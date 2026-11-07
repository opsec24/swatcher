package com.swatcher.handlers;

import burp.api.montoya.MontoyaApi;
import burp.api.montoya.core.ByteArray;
import burp.api.montoya.http.handler.HttpHandler;
import burp.api.montoya.http.handler.HttpRequestToBeSent;
import burp.api.montoya.http.handler.HttpResponseReceived;
import burp.api.montoya.http.handler.RequestToBeSentAction;
import burp.api.montoya.http.handler.ResponseReceivedAction;
import burp.api.montoya.http.message.HttpHeader;
import burp.api.montoya.http.message.requests.HttpRequest;
import burp.api.montoya.http.message.responses.HttpResponse;
import com.swatcher.core.SessionManager;
import com.swatcher.core.TrafficDispatcher;
import com.swatcher.model.TrafficEvent;
import com.swatcher.ui.ActivationModal;
import com.swatcher.ui.SwatcherTab;

import java.time.Instant;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class SwatcherHttpHandler implements HttpHandler {

    private static final int MAX_BODY_BYTES = 65_536; // 64KB max capture to protect JVM heap
    private static final Set<String> STATIC_BINARY_EXTENSIONS = new HashSet<>(Arrays.asList(
            ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp", ".tif", ".tiff",
            ".woff", ".woff2", ".ttf", ".eot", ".otf",
            ".mp4", ".webm", ".avi", ".mov", ".wmv", ".m4v",
            ".mp3", ".wav", ".ogg", ".aac", ".flac",
            ".zip", ".tar", ".gz", ".7z", ".rar", ".iso", ".exe", ".dmg", ".pdf"
    ));

    private static final Set<String> OAST_DOMAINS = new HashSet<>(Arrays.asList(
            "burpcollaborator.net",
            "oastify.com",
            "oast.pro",
            "oast.live",
            "oast.site",
            "oast.online",
            "oast.fun",
            "oast.me",
            "interact.sh",
            "interactsh.com"
    ));

    private final MontoyaApi api;
    private final SwatcherTab tab;
    private final ConcurrentHashMap<Integer, Long> inFlightTimestamps = new ConcurrentHashMap<>();

    public SwatcherHttpHandler(MontoyaApi api, SwatcherTab tab) {
        this.api = api;
        this.tab = tab;
    }

    /**
     * Immunity against self-logging feedback loops and testing scaffolding noise.
     * Excludes traffic to:
     * 1. The Swatcher Central Server itself (preventing infinite recursive ingestion loops)
     * 2. Loopback & Localhost probes (127.0.0.1, localhost, etc.)
     * 3. Burp Collaborator & Out-Of-Band (OAST) interaction domains
     */
    private boolean isExcludedTraffic(String host, int port, String url) {
        if (host == null || host.isEmpty()) return true;
        String cleanHost = host.toLowerCase().trim();

        // 1. Exclude Loopback & Localhost traffic
        if (cleanHost.equals("localhost") || cleanHost.endsWith(".localhost")
                || cleanHost.equals("127.0.0.1") || cleanHost.startsWith("127.")
                || cleanHost.equals("0.0.0.0") || cleanHost.equals("::1")) {
            return true;
        }

        // 2. Exclude Burp Collaborator & OAST scaffolding
        for (String oast : OAST_DOMAINS) {
            if (cleanHost.equals(oast) || cleanHost.endsWith("." + oast)) {
                return true;
            }
        }

        // 3. Loop Immunity: Exclude Swatcher Central Server itself
        String serverUrl = SessionManager.getInstance().getServerUrl();
        if (serverUrl != null && !serverUrl.trim().isEmpty()) {
            if (url != null && url.startsWith(serverUrl)) {
                return true;
            }
            try {
                java.net.URI uri = java.net.URI.create(serverUrl);
                String sHost = uri.getHost();
                if (sHost != null && sHost.equalsIgnoreCase(cleanHost)) {
                    int sPort = uri.getPort() != -1 ? uri.getPort() : (serverUrl.startsWith("https") ? 443 : 80);
                    if (sPort == port || port == 0) {
                        return true;
                    }
                }
            } catch (Exception ignored) {}
        }

        return false;
    }

    /**
     * Safely extracts up to 64KB from ByteArray WITHOUT allocating full multi-megabyte heap Strings.
     */
    private String extractSafeBody(ByteArray body) {
        if (body == null || body.length() == 0) {
            return "";
        }
        int len = body.length();
        if (len <= MAX_BODY_BYTES) {
            return body.toString();
        }
        // Slice ONLY the first 64KB bytes from the ByteArray before converting to String
        return body.subArray(0, MAX_BODY_BYTES).toString()
                + "\n[swatcher: payload truncated at 64KB - original size: " + len + " bytes]";
    }

    private boolean isStaticBinary(String path) {
        if (path == null) return false;
        int qIdx = path.indexOf('?');
        String cleanPath = qIdx != -1 ? path.substring(0, qIdx) : path;
        int dotIdx = cleanPath.lastIndexOf('.');
        if (dotIdx != -1 && dotIdx + 1 < cleanPath.length()) {
            String ext = cleanPath.substring(dotIdx).toLowerCase();
            return STATIC_BINARY_EXTENSIONS.contains(ext);
        }
        return false;
    }

    private Map<String, String> extractHeaders(java.util.List<HttpHeader> headers) {
        Map<String, String> map = new HashMap<>();
        if (headers == null) return map;
        for (HttpHeader h : headers) {
            if (h.name() == null) continue;
            map.merge(h.name(), h.value() != null ? h.value() : "", (oldVal, newVal) -> oldVal + "; " + newVal);
        }
        return map;
    }

    @Override
    public RequestToBeSentAction handleHttpRequestToBeSent(HttpRequestToBeSent requestToBeSent) {
        try {
            String host = requestToBeSent.httpService().host();
            int port = requestToBeSent.httpService().port();
            String url = requestToBeSent.url();

            // Ignore self-traffic, localhost, and OAST collaborator scaffolding
            if (isExcludedTraffic(host, port, url)) {
                return RequestToBeSentAction.continueWith(requestToBeSent);
            }

            boolean recording = SessionManager.getInstance().isRecordingEnabled();

            // Track in-flight request start timestamp for accurate duration calculation
            if (recording && requestToBeSent.isInScope()) {
                if (inFlightTimestamps.size() > 5000) {
                    inFlightTimestamps.clear(); // Safety eviction cap to prevent leaks
                }
                inFlightTimestamps.put(requestToBeSent.messageId(), System.currentTimeMillis());
            } else if (!recording && !SessionManager.getInstance().getServerUrl().isEmpty()) {
                // If target is in scope but recording is NOT enabled, prompt user
                if (requestToBeSent.isInScope() && SessionManager.getInstance().shouldPromptForActivation()) {
                    ActivationModal.showActivationPrompt(tab, host);
                }
            }
        } catch (Exception e) {
            api.logging().logToError("Error in handleHttpRequestToBeSent: " + e.getMessage());
        }

        return RequestToBeSentAction.continueWith(requestToBeSent);
    }

    @Override
    public ResponseReceivedAction handleHttpResponseReceived(HttpResponseReceived responseReceived) {
        // Fast-path: if recording is not active, immediately return with 0 CPU overhead
        if (!SessionManager.getInstance().isRecordingEnabled()) {
            return ResponseReceivedAction.continueWith(responseReceived);
        }

        try {
            HttpRequest req = responseReceived.initiatingRequest();
            if (!req.isInScope()) {
                return ResponseReceivedAction.continueWith(responseReceived);
            }

            String host = req.httpService().host();
            int port = req.httpService().port();
            String url = req.url();

            // Exclude self-traffic, loopback, and OAST collaborator domains
            if (isExcludedTraffic(host, port, url)) {
                return ResponseReceivedAction.continueWith(responseReceived);
            }

            HttpResponse res = responseReceived;

            TrafficEvent event = new TrafficEvent();
            event.event_id = UUID.randomUUID().toString();
            event.session_id = SessionManager.getInstance().getCurrentSessionId();
            event.timestamp = Instant.now().toString();

            String toolName = "UNKNOWN";
            try {
                toolName = responseReceived.toolSource().toolType().toolName().toUpperCase();
            } catch (Exception ignored) {}
            event.tool = toolName;

            event.tester = new TrafficEvent.TesterInfo(
                    SessionManager.getInstance().getTesterMachine()
            );
            event.engagement = new TrafficEvent.EngagementInfo(
                    SessionManager.getInstance().getRitm(),
                    SessionManager.getInstance().getApplicationId(),
                    SessionManager.getInstance().getAllocatedHours()
            );

            // Request details
            event.request = new TrafficEvent.RequestInfo();
            event.request.tool = toolName;
            event.request.method = req.method();
            event.request.url = req.url();
            event.request.host = req.httpService().host();
            event.request.port = req.httpService().port();
            String path = req.path() != null ? req.path() : "/";
            String query = "";
            int qIdx = path.indexOf("?");
            if (qIdx != -1 && qIdx + 1 < path.length()) {
                query = path.substring(qIdx + 1);
            }

            event.request.path = path;
            event.request.query = query;
            event.request.headers = extractHeaders(req.headers());
            event.request.body = extractSafeBody(req.body());
            event.request.body_length = req.body().length();

            // Response details
            event.response = new TrafficEvent.ResponseInfo();
            event.response.status_code = res.statusCode();
            event.response.headers = extractHeaders(res.headers());
            event.response.body_length = res.body().length();

            // Smart static asset handling: omit binary body while preserving full metadata and audit trail
            if (isStaticBinary(path)) {
                event.response.body = "[static media/binary asset omitted - " + res.body().length() + " bytes]";
            } else {
                event.response.body = extractSafeBody(res.body());
            }

            // Accurate duration calculation
            Long startTime = inFlightTimestamps.remove(responseReceived.messageId());
            long durationMs = startTime != null ? Math.max(0, System.currentTimeMillis() - startTime) : 0;
            event.response.duration_ms = durationMs;

            // Dispatch event asynchronously without blocking or touching Burp UI EDT
            TrafficDispatcher.getInstance().enqueue(event);

        } catch (Exception e) {
            api.logging().logToError("Error in handleHttpResponseReceived: " + e.getMessage());
        }

        return ResponseReceivedAction.continueWith(responseReceived);
    }
}
