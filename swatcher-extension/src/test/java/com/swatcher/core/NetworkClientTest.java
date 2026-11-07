package com.swatcher.core;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import javax.net.ssl.HttpsURLConnection;
import java.io.IOException;
import java.net.HttpURLConnection;

import static org.junit.jupiter.api.Assertions.*;

public class NetworkClientTest {

    @BeforeEach
    public void setUp() {
        NetworkClient.setTrustEnterpriseCAs(true);
        NetworkClient.setCorporateProxy("");
    }

    @AfterEach
    public void tearDown() {
        NetworkClient.setTrustEnterpriseCAs(true);
        NetworkClient.setCorporateProxy("");
    }

    @Test
    public void testEnterpriseCaTrustDefault() {
        assertTrue(NetworkClient.isTrustEnterpriseCAs(), "Enterprise CA trust should be enabled by default for enterprise environments");
    }

    @Test
    public void testToggleEnterpriseCaTrust() {
        NetworkClient.setTrustEnterpriseCAs(false);
        assertFalse(NetworkClient.isTrustEnterpriseCAs());
        NetworkClient.setTrustEnterpriseCAs(true);
        assertTrue(NetworkClient.isTrustEnterpriseCAs());
    }

    @Test
    public void testCorporateProxyConfig() {
        assertEquals("", NetworkClient.getCorporateProxy());
        NetworkClient.setCorporateProxy("proxy.corp.internal:8080");
        assertEquals("proxy.corp.internal:8080", NetworkClient.getCorporateProxy());

        NetworkClient.setCorporateProxy(null);
        assertEquals("", NetworkClient.getCorporateProxy());
    }

    @Test
    public void testOpenConnectionHttpsConfiguresEnterpriseSsl() throws IOException {
        NetworkClient.setTrustEnterpriseCAs(true);
        HttpURLConnection conn = NetworkClient.openConnection("https://127.0.0.1:9090/api/v1/health");

        assertNotNull(conn);
        assertInstanceOf(HttpsURLConnection.class, conn);
    }

    @Test
    public void testOpenConnectionWithCorporateProxy() throws IOException {
        NetworkClient.setCorporateProxy("127.0.0.1:8888");
        HttpURLConnection conn = NetworkClient.openConnection("http://127.0.0.1:9090/api/v1/health");

        assertNotNull(conn);
        assertInstanceOf(HttpURLConnection.class, conn);
    }

    @Test
    public void testOpenConnectionWithProxyWithoutExplicitPort() throws IOException {
        NetworkClient.setCorporateProxy("proxy.corp.internal");
        HttpURLConnection conn = NetworkClient.openConnection("http://127.0.0.1:9090/api/v1/health");

        assertNotNull(conn);
        assertInstanceOf(HttpURLConnection.class, conn);
    }
}
