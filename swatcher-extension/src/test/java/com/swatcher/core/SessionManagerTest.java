package com.swatcher.core;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

public class SessionManagerTest {

    private SessionManager sessionManager;

    @BeforeEach
    public void setUp() {
        sessionManager = SessionManager.getInstance();
        sessionManager.stopSession();
        sessionManager.setServerUrl("");
        sessionManager.setApiKey("");
        sessionManager.updateProjectDetails("", "", 40.0);
    }

    @Test
    public void testServerUrlDefaultIsEmpty() {
        assertEquals("", sessionManager.getServerUrl());
    }

    @Test
    public void testVerifyApiKeyFailsFastWhenServerUrlEmpty() {
        sessionManager.setApiKey("sw_test_key");
        // Should immediately return false and not hang or attempt HTTP request
        assertFalse(sessionManager.verifyApiKeyWithServer());
        assertFalse(sessionManager.isTokenVerified());
    }

    @Test
    public void testRecordingDisabledWithoutServerUrl() {
        sessionManager.setApiKey("sw_test_key");
        sessionManager.updateProjectDetails("RITM0012345", "APP-TEST", 40.0);
        // Even if RITM, AppID, and API Key exist, serverUrl is empty so recording must be false
        assertFalse(sessionManager.isRecordingEnabled());

        // Once server URL is configured, auto-start should enable recording
        sessionManager.setServerUrl("https://swatcher.corp.internal:9090");
        assertTrue(sessionManager.isRecordingEnabled());
        assertEquals("https://swatcher.corp.internal:9090", sessionManager.getServerUrl());
    }

    @Test
    public void testActivationPromptSuppressedWhenServerUrlEmpty() {
        sessionManager.setApiKey("sw_test_key");
        assertFalse(sessionManager.shouldPromptForActivation());
    }

    @Test
    public void testServerUrlNormalization() {
        sessionManager.setServerUrl("swatcher.corp.internal");
        assertEquals("https://swatcher.corp.internal", sessionManager.getServerUrl());

        sessionManager.setServerUrl("127.0.0.1:9090");
        assertEquals("http://127.0.0.1:9090", sessionManager.getServerUrl());

        sessionManager.setServerUrl("localhost:9090");
        assertEquals("http://localhost:9090", sessionManager.getServerUrl());

        sessionManager.setServerUrl("http://127.0.0.1:9090");
        assertEquals("http://127.0.0.1:9090", sessionManager.getServerUrl());

        sessionManager.setServerUrl("  https://central.swatcher.io/api/  ");
        assertEquals("https://central.swatcher.io/api/", sessionManager.getServerUrl());
    }
}
