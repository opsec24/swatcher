package com.swatcher.core;

import burp.api.montoya.MontoyaApi;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

public class SessionManager {
    private static SessionManager instance;

    private MontoyaApi api;
    private final AtomicBoolean recordingEnabled = new AtomicBoolean(false);
    private volatile String ritm = "";
    private volatile String applicationId = "";
    private volatile double allocatedHours = 40.0;
    private volatile String serverUrl = "";
    private volatile String apiKey = "";
    private volatile String testerMachine;
    private volatile String currentSessionId = "";

    // Authenticated Identity from Server Handshake
    private volatile boolean isTokenVerified = false;
    private volatile String authenticatedFullName = "";
    private volatile String authenticatedUsername = "";

    private long lastPromptTimestamp = 0;
    private static final long PROMPT_COOLDOWN_MS = 60_000;

    public interface SessionStateListener {
        void onSessionStateChanged(boolean isRecording, String ritm, String appId, double effortHours);
        void onAuthStatusChanged(boolean isVerified, String fullName, String username, String message);
    }

    private final List<SessionStateListener> listeners = new java.util.concurrent.CopyOnWriteArrayList<>();

    private SessionManager() {
        // Safe, non-blocking hostname resolution (never hangs on offline DNS)
        String host = System.getenv("HOSTNAME");
        if (host == null || host.trim().isEmpty()) {
            host = System.getenv("COMPUTERNAME");
        }
        if (host == null || host.trim().isEmpty()) {
            host = "workstation";
        }
        this.testerMachine = host;
    }

    public static synchronized SessionManager getInstance() {
        if (instance == null) {
            instance = new SessionManager();
        }
        return instance;
    }

    public synchronized void initializeFromBurp(MontoyaApi api) {
        this.api = api;

        // 1. Read Global Workstation Preferences (Server URL, API Key & Cached Verification)
        try {
            String savedUrl = api.persistence().preferences().getString("swatcher.serverUrl");
            if (savedUrl != null && !savedUrl.trim().isEmpty()) {
                this.serverUrl = savedUrl.trim();
            }
            String savedKey = api.persistence().preferences().getString("swatcher.apiKey");
            if (savedKey != null && !savedKey.trim().isEmpty()) {
                this.apiKey = savedKey.trim();
            }
            Boolean cachedVerified = api.persistence().preferences().getBoolean("swatcher.isTokenVerified");
            if (cachedVerified != null && cachedVerified && !this.apiKey.isEmpty()) {
                this.isTokenVerified = true;
                String cachedName = api.persistence().preferences().getString("swatcher.fullName");
                String cachedUser = api.persistence().preferences().getString("swatcher.username");
                if (cachedName != null) this.authenticatedFullName = cachedName;
                if (cachedUser != null) this.authenticatedUsername = cachedUser;
            }
        } catch (Exception e) {
            api.logging().logToError("Could not load preferences: " + e.getMessage());
        }

        // 2. Read Burp Project-Scoped Data (.burp file persistence)
        try {
            String savedRitm = api.persistence().extensionData().getString("swatcher.ritm");
            String savedAppId = api.persistence().extensionData().getString("swatcher.applicationId");
            String savedEffort = api.persistence().extensionData().getString("swatcher.allocatedHours");

            if (savedRitm != null && !savedRitm.trim().isEmpty() && savedAppId != null && !savedAppId.trim().isEmpty()) {
                this.ritm = savedRitm.trim().toUpperCase();
                this.applicationId = savedAppId.trim().toUpperCase();
                if (savedEffort != null) {
                    try { this.allocatedHours = Double.parseDouble(savedEffort); } catch (Exception ignored) {}
                }
                this.currentSessionId = "sess_" + this.ritm + "_" + System.currentTimeMillis();

                // If token, server URL, and project details are present, auto-enable recording immediately!
                if (!apiKey.isEmpty() && !serverUrl.isEmpty()) {
                    this.recordingEnabled.set(true);
                }
            }
        } catch (Exception e) {
            api.logging().logToError("Could not load project extension data: " + e.getMessage());
        }

        // 3. Perform Server Handshake in Background Thread
        new Thread(() -> {
            if (serverUrl == null || serverUrl.trim().isEmpty()) {
                api.logging().logToOutput("[swatcher] No Central Server URL configured. Please configure your server URL in the 'swatcher' tab.");
                notifyAuthListeners(false, "", "", "Central Server URL required. Please configure in the swatcher tab.");
                return;
            }
            if (apiKey != null && !apiKey.isEmpty()) {
                boolean verified = verifyApiKeyWithServer();
                if (verified) {
                    checkAndAutoStartSession();
                    api.logging().logToOutput("[swatcher] Project RITM: " + ritm + " (" + applicationId + ") loaded.");
                    if (isRecordingEnabled()) {
                        api.logging().logToOutput("[swatcher] Traffic recording is ACTIVE.");
                    }
                }
            } else {
                api.logging().logToOutput("[swatcher] No API Token configured. Please paste your token in the 'swatcher' tab.");
                notifyAuthListeners(false, "", "", "API Token required. Please configure in the swatcher tab.");
            }
        }).start();

        checkAndAutoStartSession();
        notifyListeners();
    }

    /**
     * Handshake with central server: verifies API key and retrieves pentester identity.
     * Non-blocking and never holds monitor locks during network I/O so Burp Suite never hangs.
     * If the server is temporarily offline, previously cached credentials remain valid.
     */
    public boolean verifyApiKeyWithServer() {
        String currentKey = this.apiKey;
        String currentUrl = this.serverUrl;

        if (currentUrl == null || currentUrl.trim().isEmpty()) {
            this.isTokenVerified = false;
            notifyAuthListeners(false, "", "", "Central Server URL is missing.");
            return false;
        }

        if (currentKey == null || currentKey.trim().isEmpty()) {
            this.isTokenVerified = false;
            notifyAuthListeners(false, "", "", "API Token is missing.");
            return false;
        }

        String targetUrl = currentUrl.trim();
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
            targetUrl = "https://" + targetUrl;
            this.serverUrl = targetUrl;
        }

        String endpoint = targetUrl.replaceAll("/+$", "") + "/api/v1/auth/verify-key";
        try {
            URL url = new URL(endpoint);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Authorization", "Bearer " + currentKey.trim());
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setConnectTimeout(2000); // 2s quick connect timeout
            conn.setReadTimeout(2500);

            int code = conn.getResponseCode();
            if (code == 200) {
                try (InputStream is = conn.getInputStream();
                     InputStreamReader reader = new InputStreamReader(is, StandardCharsets.UTF_8)) {
                    JsonObject json = new Gson().fromJson(reader, JsonObject.class);
                    if (json.has("valid") && json.get("valid").getAsBoolean()) {
                        isTokenVerified = true;
                        JsonObject pt = json.getAsJsonObject("pentester");
                        authenticatedFullName = pt.get("full_name").getAsString();
                        authenticatedUsername = pt.get("username").getAsString();

                        if (api != null) {
                            try {
                                api.persistence().preferences().setBoolean("swatcher.isTokenVerified", true);
                                api.persistence().preferences().setString("swatcher.fullName", authenticatedFullName);
                                api.persistence().preferences().setString("swatcher.username", authenticatedUsername);
                            } catch (Exception ignored) {}

                            api.logging().logToOutput("=============================================================");
                            api.logging().logToOutput("  swatcher // Authenticated with Central Server (" + currentUrl + ")");
                            api.logging().logToOutput("  Welcome back, " + authenticatedFullName + " (" + authenticatedUsername + ")!");
                            api.logging().logToOutput("=============================================================");
                        }

                        notifyAuthListeners(true, authenticatedFullName, authenticatedUsername, "Authenticated as " + authenticatedFullName);
                        checkAndAutoStartSession();
                        return true;
                    }
                }
            } else if (code == 401 || code == 403) {
                // Key explicitly rejected by server
                isTokenVerified = false;
                if (api != null) {
                    try { api.persistence().preferences().setBoolean("swatcher.isTokenVerified", false); } catch (Exception ignored) {}
                }
                notifyAuthListeners(false, "", "", "Token rejected by server (HTTP " + code + "). Please check your key.");
                return false;
            }
        } catch (Exception e) {
            // Server offline / network unreachable: if previously verified, keep operational in offline mode
            if (isTokenVerified) {
                notifyAuthListeners(true, authenticatedFullName, authenticatedUsername, "Server offline (Operating with cached key)");
                checkAndAutoStartSession();
                return true;
            } else {
                // Key has not been verified with central server yet
                notifyAuthListeners(false, "", "", "Server unreachable. Key will be validated when server reconnects.");
                return false;
            }
        }
        return isTokenVerified;
    }

    public synchronized void markTokenRejected(String reason) {
        this.isTokenVerified = false;
        if (api != null) {
            try { api.persistence().preferences().setBoolean("swatcher.isTokenVerified", false); } catch (Exception ignored) {}
        }
        notifyAuthListeners(false, "", "", reason != null ? reason : "API Key rejected by server.");
    }

    /**
     * Auto-starts the session if token, server URL, RITM, and App ID are all present.
     */
    public synchronized void checkAndAutoStartSession() {
        String r = ritm != null ? ritm.trim() : "";
        String a = applicationId != null ? applicationId.trim() : "";
        String k = apiKey != null ? apiKey.trim() : "";
        String u = serverUrl != null ? serverUrl.trim() : "";

        if (!r.isEmpty() && !a.isEmpty() && !k.isEmpty() && !u.isEmpty()) {
            if (!recordingEnabled.get()) {
                startSession(r, a, allocatedHours);
            }
        }
    }

    public boolean isRecordingEnabled() {
        return recordingEnabled.get() && !ritm.trim().isEmpty() && !applicationId.trim().isEmpty() && (!apiKey.trim().isEmpty() || isTokenVerified) && !serverUrl.trim().isEmpty();
    }

    public synchronized void startSession(String ritm, String applicationId, double effortHours) {
        this.ritm = ritm.trim().toUpperCase();
        this.applicationId = applicationId.trim().toUpperCase();
        this.allocatedHours = effortHours > 0 ? effortHours : 40.0;
        // Always generate a fresh session ID on engagement start or project update
        this.currentSessionId = "sess_" + this.ritm + "_" + System.currentTimeMillis();
        this.recordingEnabled.set(true);

        // Persist to current Burp project file
        if (api != null) {
            try {
                api.persistence().extensionData().setString("swatcher.ritm", this.ritm);
                api.persistence().extensionData().setString("swatcher.applicationId", this.applicationId);
                api.persistence().extensionData().setString("swatcher.allocatedHours", String.valueOf(this.allocatedHours));
                api.persistence().extensionData().setBoolean("swatcher.isRecording", true);
            } catch (Exception ignored) {}
        }

        notifyListeners();
    }

    public synchronized void updateProjectDetails(String ritm, String appId, double effortHours) {
        this.ritm = ritm != null ? ritm.trim().toUpperCase() : "";
        this.applicationId = appId != null ? appId.trim().toUpperCase() : "";
        if (effortHours > 0) this.allocatedHours = effortHours;

        if (api != null) {
            try {
                api.persistence().extensionData().setString("swatcher.ritm", this.ritm);
                api.persistence().extensionData().setString("swatcher.applicationId", this.applicationId);
                api.persistence().extensionData().setString("swatcher.allocatedHours", String.valueOf(this.allocatedHours));
            } catch (Exception ignored) {}
        }

        checkAndAutoStartSession();
        notifyListeners();
    }

    public synchronized void stopSession() {
        this.recordingEnabled.set(false);
        if (api != null) {
            try {
                api.persistence().extensionData().setBoolean("swatcher.isRecording", false);
            } catch (Exception ignored) {}
        }
        notifyListeners();
    }

    public synchronized boolean shouldPromptForActivation() {
        if (isRecordingEnabled() || apiKey.trim().isEmpty() || serverUrl.trim().isEmpty()) {
            return false;
        }
        long now = System.currentTimeMillis();
        if (now - lastPromptTimestamp > PROMPT_COOLDOWN_MS) {
            lastPromptTimestamp = now;
            return true;
        }
        return false;
    }

    public void addListener(SessionStateListener listener) {
        listeners.add(listener);
    }

    private void notifyListeners() {
        for (SessionStateListener listener : listeners) {
            try {
                listener.onSessionStateChanged(recordingEnabled.get(), ritm, applicationId, allocatedHours);
            } catch (Exception ignored) {}
        }
    }

    private void notifyAuthListeners(boolean isVerified, String fullName, String username, String message) {
        for (SessionStateListener listener : listeners) {
            try {
                listener.onAuthStatusChanged(isVerified, fullName, username, message);
            } catch (Exception ignored) {}
        }
    }

    // Getters and Setters
    public String getRitm() { return ritm; }
    public String getApplicationId() { return applicationId; }
    public double getAllocatedHours() { return allocatedHours; }
    public String getServerUrl() { return serverUrl; }
    public void setServerUrl(String serverUrl) {
        this.serverUrl = serverUrl != null ? serverUrl.trim() : "";
        if (api != null) {
            try { api.persistence().preferences().setString("swatcher.serverUrl", this.serverUrl); } catch (Exception ignored) {}
        }
        checkAndAutoStartSession();
    }

    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) {
        this.apiKey = apiKey.trim();
        if (api != null) {
            try { api.persistence().preferences().setString("swatcher.apiKey", this.apiKey); } catch (Exception ignored) {}
        }
        checkAndAutoStartSession();
    }

    public boolean isTokenVerified() { return isTokenVerified; }
    public String getAuthenticatedFullName() { return authenticatedFullName; }
    public String getAuthenticatedUsername() { return authenticatedUsername; }
    public String getTesterMachine() { return testerMachine; }
    public String getCurrentSessionId() { return currentSessionId; }
}
