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
    private String ritm = "";
    private String applicationId = "";
    private double allocatedHours = 40.0;
    private String serverUrl = "http://localhost:9090";
    private String apiKey = "";
    private String testerMachine;
    private String currentSessionId = "";

    // Authenticated Identity from Server Handshake
    private boolean isTokenVerified = false;
    private String authenticatedFullName = "";
    private String authenticatedUsername = "";

    private long lastPromptTimestamp = 0;
    private static final long PROMPT_COOLDOWN_MS = 60_000;

    public interface SessionStateListener {
        void onSessionStateChanged(boolean isRecording, String ritm, String appId, double effortHours);
        void onAuthStatusChanged(boolean isVerified, String fullName, String username, String message);
    }

    private final List<SessionStateListener> listeners = new ArrayList<>();

    private SessionManager() {
        try {
            this.testerMachine = InetAddress.getLocalHost().getHostName();
        } catch (Exception e) {
            this.testerMachine = "unknown_host";
        }
    }

    public static synchronized SessionManager getInstance() {
        if (instance == null) {
            instance = new SessionManager();
        }
        return instance;
    }

    public synchronized void initializeFromBurp(MontoyaApi api) {
        this.api = api;

        // 1. Read Global Workstation Preferences (Server URL & API Key)
        try {
            String savedUrl = api.persistence().preferences().getString("swatcher.serverUrl");
            if (savedUrl != null && !savedUrl.trim().isEmpty()) {
                this.serverUrl = savedUrl.trim();
            }
            String savedKey = api.persistence().preferences().getString("swatcher.apiKey");
            if (savedKey != null && !savedKey.trim().isEmpty()) {
                this.apiKey = savedKey.trim();
            }
        } catch (Exception e) {
            api.logging().logToError("Could not load preferences: " + e.getMessage());
        }

        // 2. Read Burp Project-Scoped Data (.burp file persistence)
        boolean hasSavedProject = false;
        try {
            String savedRitm = api.persistence().extensionData().getString("swatcher.ritm");
            String savedAppId = api.persistence().extensionData().getString("swatcher.applicationId");
            String savedEffort = api.persistence().extensionData().getString("swatcher.allocatedHours");
            Boolean savedRecording = api.persistence().extensionData().getBoolean("swatcher.isRecording");

            if (savedRitm != null && !savedRitm.trim().isEmpty() && savedAppId != null && !savedAppId.trim().isEmpty()) {
                this.ritm = savedRitm.trim().toUpperCase();
                this.applicationId = savedAppId.trim().toUpperCase();
                if (savedEffort != null) {
                    try { this.allocatedHours = Double.parseDouble(savedEffort); } catch (Exception ignored) {}
                }
                this.currentSessionId = "sess_" + this.ritm + "_" + System.currentTimeMillis();
                hasSavedProject = true;

                // By default, if project details exist, auto-start recording!
                this.recordingEnabled.set(savedRecording != null ? savedRecording : true);
            }
        } catch (Exception e) {
            api.logging().logToError("Could not load project extension data: " + e.getMessage());
        }

        // 3. Perform Server Handshake in Background Thread
        final boolean resumeProject = hasSavedProject;
        new Thread(() -> {
            if (apiKey != null && !apiKey.isEmpty()) {
                boolean verified = verifyApiKeyWithServer();
                if (verified && resumeProject) {
                    api.logging().logToOutput("[swatcher] Project RITM: " + ritm + " (" + applicationId + ") loaded.");
                    api.logging().logToOutput("[swatcher] Traffic recording is ACTIVE.");
                }
            } else {
                api.logging().logToOutput("[swatcher] No API Token configured. Please paste your token in the 'swatcher' tab.");
                notifyAuthListeners(false, "", "", "API Token required. Please configure in the swatcher tab.");
            }
        }).start();

        notifyListeners();
    }

    /**
     * Handshake with central server: verifies API key and retrieves pentester identity
     */
    public synchronized boolean verifyApiKeyWithServer() {
        if (apiKey == null || apiKey.trim().isEmpty()) {
            isTokenVerified = false;
            notifyAuthListeners(false, "", "", "API Token is missing.");
            return false;
        }

        String endpoint = serverUrl.replaceAll("/+$", "") + "/api/v1/auth/verify-key";
        try {
            URL url = new URL(endpoint);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Authorization", "Bearer " + apiKey.trim());
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);

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
                            api.logging().logToOutput("=============================================================");
                            api.logging().logToOutput("  swatcher // Authenticated with Central Server (" + serverUrl + ")");
                            api.logging().logToOutput("  Welcome back, " + authenticatedFullName + " (" + authenticatedUsername + ")!");
                            api.logging().logToOutput("=============================================================");
                        }

                        notifyAuthListeners(true, authenticatedFullName, authenticatedUsername, "Authenticated as " + authenticatedFullName);
                        return true;
                    }
                }
            } else {
                isTokenVerified = false;
                notifyAuthListeners(false, "", "", "Token rejected by server (HTTP " + code + "). Please check your key.");
            }
        } catch (Exception e) {
            isTokenVerified = false;
            notifyAuthListeners(false, "", "", "Could not reach server at " + endpoint + ": " + e.getMessage());
        }
        return false;
    }

    public boolean isRecordingEnabled() {
        return recordingEnabled.get() && !ritm.trim().isEmpty() && !applicationId.trim().isEmpty() && isTokenVerified;
    }

    public synchronized void startSession(String ritm, String applicationId, double effortHours) {
        this.ritm = ritm.trim().toUpperCase();
        this.applicationId = applicationId.trim().toUpperCase();
        this.allocatedHours = effortHours > 0 ? effortHours : 40.0;
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
        if (isRecordingEnabled() || !isTokenVerified) {
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
        this.serverUrl = serverUrl.trim();
        if (api != null) {
            try { api.persistence().preferences().setString("swatcher.serverUrl", this.serverUrl); } catch (Exception ignored) {}
        }
    }

    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) {
        this.apiKey = apiKey.trim();
        if (api != null) {
            try { api.persistence().preferences().setString("swatcher.apiKey", this.apiKey); } catch (Exception ignored) {}
        }
    }

    public boolean isTokenVerified() { return isTokenVerified; }
    public String getAuthenticatedFullName() { return authenticatedFullName; }
    public String getAuthenticatedUsername() { return authenticatedUsername; }
    public String getTesterMachine() { return testerMachine; }
    public String getCurrentSessionId() { return currentSessionId; }
}
