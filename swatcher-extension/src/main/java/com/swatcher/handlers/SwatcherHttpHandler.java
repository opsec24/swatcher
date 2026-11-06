package com.swatcher.handlers;

import burp.api.montoya.MontoyaApi;
import burp.api.montoya.http.message.HttpHeader;
import burp.api.montoya.http.handler.HttpHandler;
import burp.api.montoya.http.handler.HttpRequestToBeSent;
import burp.api.montoya.http.handler.HttpResponseReceived;
import burp.api.montoya.http.handler.RequestToBeSentAction;
import burp.api.montoya.http.handler.ResponseReceivedAction;
import burp.api.montoya.http.message.requests.HttpRequest;
import burp.api.montoya.http.message.responses.HttpResponse;
import com.swatcher.core.SessionManager;
import com.swatcher.core.TrafficDispatcher;
import com.swatcher.model.TrafficEvent;
import com.swatcher.ui.ActivationModal;
import com.swatcher.ui.SwatcherTab;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public class SwatcherHttpHandler implements HttpHandler {

    private static final int MAX_BODY_CHARS = 65_536; // 64KB max capture to protect JVM heap
    private final MontoyaApi api;
    private final SwatcherTab tab;

    public SwatcherHttpHandler(MontoyaApi api, SwatcherTab tab) {
        this.api = api;
        this.tab = tab;
    }

    private String safeTruncateBody(String body) {
        if (body == null) return "";
        if (body.length() <= MAX_BODY_CHARS) {
            return body;
        }
        return body.substring(0, MAX_BODY_CHARS) + "\n[swatcher: payload truncated at 64KB - original size: " + body.length() + " chars]";
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
            boolean inScope = requestToBeSent.isInScope();

            // If target is in scope but recording is NOT enabled, prompt user
            if (inScope && !SessionManager.getInstance().isRecordingEnabled()) {
                if (SessionManager.getInstance().shouldPromptForActivation()) {
                    String host = requestToBeSent.httpService().host();
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
        try {
            HttpRequest req = responseReceived.initiatingRequest();
            boolean inScope = req.isInScope();

            // Only record when in-scope and recording is active
            if (inScope && SessionManager.getInstance().isRecordingEnabled()) {
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
                event.request.body = safeTruncateBody(req.bodyToString());
                event.request.body_length = req.body().length();

                // Response details
                event.response = new TrafficEvent.ResponseInfo();
                event.response.status_code = res.statusCode();
                event.response.headers = extractHeaders(res.headers());
                event.response.body = safeTruncateBody(res.bodyToString());
                event.response.body_length = res.body().length();
                event.response.duration_ms = 0;

                // Dispatch event asynchronously
                TrafficDispatcher.getInstance().enqueue(event);

                // Update Burp UI tab
                tab.addTrafficRow(
                        Instant.now().toString().substring(11, 19),
                        toolName,
                        req.method(),
                        req.path(),
                        res.statusCode(),
                        0
                );
            }
        } catch (Exception e) {
            api.logging().logToError("Error in handleHttpResponseReceived: " + e.getMessage());
        }

        return ResponseReceivedAction.continueWith(responseReceived);
    }
}
