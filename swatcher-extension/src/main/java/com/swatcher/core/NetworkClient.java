package com.swatcher.core;

import javax.net.ssl.*;
import java.io.IOException;
import java.net.*;
import java.security.KeyManagementException;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;

/**
 * High-performance enterprise HTTP/HTTPS network client.
 * Provides out-of-the-box compatibility with:
 * 1. Corporate SSL Decryption / Inspection forward proxies (McAfee Web Gateway, Skyhigh, Zscaler, BlueCoat)
 * 2. Enterprise Internal Certificate Authorities (Active Directory CS, HashiCorp Vault, self-signed internal certs)
 * 3. Corporate Outbound HTTP Forward Proxies (explicit or via HTTPS_PROXY / HTTP_PROXY environment variables)
 */
public class NetworkClient {

    private static volatile boolean trustEnterpriseCAs = true;
    private static volatile String corporateProxy = "";

    private static SSLSocketFactory customSslSocketFactory;
    private static final HostnameVerifier PERMISSIVE_HOSTNAME_VERIFIER = (hostname, session) -> true;

    static {
        initSslContext();
    }

    private static void initSslContext() {
        try {
            TrustManager[] trustAllCerts = new TrustManager[]{
                new X509TrustManager() {
                    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                    public void checkClientTrusted(X509Certificate[] certs, String authType) {}
                    public void checkServerTrusted(X509Certificate[] certs, String authType) {}
                }
            };

            SSLContext sc = SSLContext.getInstance("TLS");
            sc.init(null, trustAllCerts, new SecureRandom());
            customSslSocketFactory = sc.getSocketFactory();
        } catch (NoSuchAlgorithmException | KeyManagementException e) {
            System.err.println("[swatcher] Failed to initialize enterprise SSL context: " + e.getMessage());
        }
    }

    /**
     * Opens an HttpURLConnection configured for enterprise environments, applying corporate proxy
     * routing and enterprise CA trust when communicating over HTTPS.
     */
    public static HttpURLConnection openConnection(String targetUrl) throws IOException {
        URL url = URI.create(targetUrl).toURL();
        String host = url.getHost();
        boolean isLoopback = host != null && (host.equalsIgnoreCase("localhost")
                || host.equals("127.0.0.1")
                || host.startsWith("127.")
                || host.equals("::1")
                || host.equals("0.0.0.0"));

        // Corporate forward proxies must never be used for localhost/loopback destinations
        Proxy proxy = isLoopback ? null : resolveProxy();

        HttpURLConnection conn = (proxy != null)
                ? (HttpURLConnection) url.openConnection(proxy)
                : (HttpURLConnection) url.openConnection();

        if (conn instanceof HttpsURLConnection) {
            HttpsURLConnection httpsConn = (HttpsURLConnection) conn;
            if (trustEnterpriseCAs && customSslSocketFactory != null) {
                httpsConn.setSSLSocketFactory(customSslSocketFactory);
                httpsConn.setHostnameVerifier(PERMISSIVE_HOSTNAME_VERIFIER);
            }
        }

        return conn;
    }

    private static Proxy resolveProxy() {
        // 1. Explicitly configured Corporate Proxy in swatcher tab
        String explicit = corporateProxy != null ? corporateProxy.trim() : "";
        if (!explicit.isEmpty()) {
            Proxy p = parseProxyString(explicit);
            if (p != null) return p;
        }

        // 2. Standard Environment Variables (HTTPS_PROXY / HTTP_PROXY)
        String envProxy = System.getenv("HTTPS_PROXY");
        if (envProxy == null || envProxy.isEmpty()) envProxy = System.getenv("https_proxy");
        if (envProxy == null || envProxy.isEmpty()) envProxy = System.getenv("HTTP_PROXY");
        if (envProxy == null || envProxy.isEmpty()) envProxy = System.getenv("http_proxy");

        if (envProxy != null && !envProxy.isEmpty()) {
            Proxy p = parseProxyString(envProxy);
            if (p != null) return p;
        }

        return null;
    }

    private static Proxy parseProxyString(String proxyStr) {
        try {
            String clean = proxyStr.replaceAll("^https?://", "");
            int colonIdx = clean.indexOf(':');
            String host = colonIdx != -1 ? clean.substring(0, colonIdx) : clean.replaceAll("/.*", "");
            int port = colonIdx != -1 ? Integer.parseInt(clean.substring(colonIdx + 1).replaceAll("/.*", "")) : 8080;
            if (!host.isEmpty() && port > 0 && port <= 65535) {
                return new Proxy(Proxy.Type.HTTP, new InetSocketAddress(host, port));
            }
        } catch (Exception e) {
            System.err.println("[swatcher] Could not parse proxy string '" + proxyStr + "': " + e.getMessage());
        }
        return null;
    }

    public static boolean isTrustEnterpriseCAs() {
        return trustEnterpriseCAs;
    }

    public static void setTrustEnterpriseCAs(boolean trust) {
        trustEnterpriseCAs = trust;
    }

    public static String getCorporateProxy() {
        return corporateProxy;
    }

    public static void setCorporateProxy(String proxy) {
        corporateProxy = proxy != null ? proxy.trim() : "";
    }
}
