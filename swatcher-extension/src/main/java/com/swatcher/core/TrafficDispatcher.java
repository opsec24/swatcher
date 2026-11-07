package com.swatcher.core;

import com.google.gson.Gson;
import com.swatcher.model.TrafficEvent;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.GZIPOutputStream;

public class TrafficDispatcher {
    private static TrafficDispatcher instance;

    private final BlockingQueue<TrafficEvent> queue = new LinkedBlockingQueue<>(5000);
    private final OfflineQueueManager offlineQueue = new OfflineQueueManager();
    private final Gson gson = new Gson();
    private final Thread workerThread;
    private volatile boolean running = true;
    private volatile boolean serverOnline = true;
    private volatile boolean authValid = true;
    private final AtomicBoolean isDraining = new AtomicBoolean(false);

    public enum UploadResult {
        SUCCESS,
        AUTH_REJECTED,
        NETWORK_OFFLINE
    }

    private final AtomicLong totalBuffered = new AtomicLong(0);
    private final AtomicLong totalUploaded = new AtomicLong(0);
    private final AtomicLong totalFailed = new AtomicLong(0);
    private final AtomicLong lastStatsNotify = new AtomicLong(0);
    private final AtomicLong lastLoggedUploaded = new AtomicLong(0);

    public interface DispatcherStatsListener {
        void onStatsUpdated(long buffered, long uploaded, long failed, int queueSize, long offlineCount, boolean isServerOnline);
    }

    public interface OperationalLogListener {
        void onOperationalLog(String message);
    }

    private final List<DispatcherStatsListener> statsListeners = new CopyOnWriteArrayList<>();
    private final List<OperationalLogListener> logListeners = new CopyOnWriteArrayList<>();

    private TrafficDispatcher() {
        this.workerThread = new Thread(this::runWorker, "swatcher-dispatcher-worker");
        this.workerThread.setDaemon(true);
        this.workerThread.start();
    }

    public static synchronized TrafficDispatcher getInstance() {
        if (instance == null) {
            instance = new TrafficDispatcher();
        }
        return instance;
    }

    public void enqueue(TrafficEvent event) {
        if (queue.offer(event)) {
            totalBuffered.incrementAndGet();
            notifyStats(false);
        } else {
            System.err.println("[swatcher] Queue full! Persisting directly to offline store.");
            List<TrafficEvent> fallbackList = new ArrayList<>();
            fallbackList.add(event);
            offlineQueue.appendEvents(fallbackList);
            serverOnline = false;
            totalFailed.incrementAndGet();
            notifyStats(true);
            notifyLog("⚠️ Queue capacity exceeded (5000). Overflow buffered directly to offline store.");
        }
    }

    private void runWorker() {
        List<TrafficEvent> batch = new ArrayList<>();
        long lastFlush = System.currentTimeMillis();
        long lastOfflineProbe = System.currentTimeMillis();

        while (running) {
            try {
                TrafficEvent event = queue.poll(500, java.util.concurrent.TimeUnit.MILLISECONDS);
                if (event != null) {
                    batch.add(event);
                }

                long now = System.currentTimeMillis();
                boolean shouldFlush = batch.size() >= 25 || (now - lastFlush >= 2000 && !batch.isEmpty());

                if (shouldFlush) {
                    handleDispatchBatch(batch);
                    batch.clear();
                    lastFlush = now;
                }

                // If offline queue has pending events or server is offline, periodically probe & drain (10s backoff)
                if ((!serverOnline || offlineQueue.hasPendingEvents()) && (now - lastOfflineProbe >= 10000)) {
                    drainOfflineQueue();
                    lastOfflineProbe = now;
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                System.err.println("[swatcher] Error in dispatcher loop: " + e.getMessage());
            }
        }

        if (!batch.isEmpty()) {
            handleDispatchBatch(batch);
        }
    }

    private void handleDispatchBatch(List<TrafficEvent> batch) {
        if (batch.isEmpty()) return;

        String serverUrl = SessionManager.getInstance().getServerUrl();
        if (serverUrl == null || serverUrl.trim().isEmpty()) {
            offlineQueue.appendEvents(batch);
            totalFailed.addAndGet(batch.size());
            notifyStats(true);
            return;
        }

        // If server is known to be offline, immediately save to local disk without waiting for connection timeout
        if (!serverOnline) {
            offlineQueue.appendEvents(batch);
            totalFailed.addAndGet(batch.size());
            notifyStats(false);
            return;
        }

        UploadResult result = executeHttpBatchUpload(batch);
        if (result == UploadResult.SUCCESS) {
            boolean wasOffline = !serverOnline;
            serverOnline = true;
            authValid = true;
            long uploaded = totalUploaded.addAndGet(batch.size());

            if (wasOffline) {
                notifyLog("✓ Central server connection restored.");
            }

            // Periodic upload milestone logging (every ~100 events)
            if (uploaded - lastLoggedUploaded.get() >= 100) {
                lastLoggedUploaded.set(uploaded);
                notifyLog("Uploaded " + uploaded + " events to " + serverUrl + " (gzip compressed).");
            }

            if (offlineQueue.hasPendingEvents()) {
                drainOfflineQueue();
            }
        } else if (result == UploadResult.AUTH_REJECTED) {
            serverOnline = true; // Server is online, but auth failed
            authValid = false;
            SessionManager.getInstance().markTokenRejected("API Token rejected by server (HTTP 401/403).");
            offlineQueue.appendEvents(batch);
            totalFailed.addAndGet(batch.size());
            notifyLog("❌ API Token rejected by server (HTTP 401/403). Session recording paused.");
        } else {
            boolean wasOnline = serverOnline;
            serverOnline = false;
            offlineQueue.appendEvents(batch);
            totalFailed.addAndGet(batch.size());
            if (wasOnline) {
                notifyLog("⚠️ Central server unreachable. Buffering events locally to offline store.");
            }
        }
        notifyStats(true);
    }

    /**
     * Replays offline-stored logs in chunks to the central server when connectivity resumes.
     * Uses non-blocking AtomicBoolean check instead of monitor locks to prevent UI hangs.
     */
    public void drainOfflineQueue() {
        if (!offlineQueue.hasPendingEvents()) return;

        String serverUrl = SessionManager.getInstance().getServerUrl();
        if (serverUrl == null || serverUrl.trim().isEmpty()) {
            return;
        }

        if (!isDraining.compareAndSet(false, true)) {
            return; // Already draining on another thread
        }

        try {
            int maxChunksPerPass = 20; // Up to 2000 events per pass
            int pass = 0;
            long initialOffline = offlineQueue.getOfflineCount();

            if (initialOffline > 0) {
                notifyLog("Draining " + initialOffline + " offline-buffered logs to central server...");
            }

            while (offlineQueue.hasPendingEvents() && pass < maxChunksPerPass) {
                List<TrafficEvent> chunk = offlineQueue.peekBatch(100); // 100 events per replay chunk
                if (chunk.isEmpty()) break;

                UploadResult result = executeHttpBatchUpload(chunk);
                if (result == UploadResult.SUCCESS) {
                    serverOnline = true;
                    authValid = true;
                    offlineQueue.commitRemove(chunk.size());
                    totalUploaded.addAndGet(chunk.size());
                    notifyStats(true);
                    pass++;
                } else if (result == UploadResult.AUTH_REJECTED) {
                    serverOnline = true;
                    authValid = false;
                    SessionManager.getInstance().markTokenRejected("Offline replay halted: API Key rejected (HTTP 401/403).");
                    notifyStats(true);
                    notifyLog("❌ Offline replay halted: API Key rejected (HTTP 401/403).");
                    break;
                } else {
                    serverOnline = false;
                    notifyStats(true);
                    break;
                }
            }

            if (!offlineQueue.hasPendingEvents() && serverOnline) {
                notifyLog("✓ All offline logs uploaded successfully. System operating in LIVE recording mode.");
            }
        } finally {
            isDraining.set(false);
        }
    }

    private UploadResult executeHttpBatchUpload(List<TrafficEvent> batch) {
        if (batch.isEmpty()) return UploadResult.SUCCESS;

        String serverUrl = SessionManager.getInstance().getServerUrl();
        if (serverUrl == null || serverUrl.trim().isEmpty()) {
            return UploadResult.NETWORK_OFFLINE;
        }

        String apiKey = SessionManager.getInstance().getApiKey();
        String endpoint = serverUrl.replaceAll("/+$", "") + "/api/v1/ingest/batch";

        HttpURLConnection conn = null;
        try {
            Map<String, Object> payload = new HashMap<>();
            payload.put("batch", batch);
            payload.put("session_id", SessionManager.getInstance().getCurrentSessionId());
            payload.put("tester", new TrafficEvent.TesterInfo(
                SessionManager.getInstance().getTesterMachine()
            ));
            payload.put("engagement", new TrafficEvent.EngagementInfo(
                SessionManager.getInstance().getRitm(),
                SessionManager.getInstance().getApplicationId(),
                SessionManager.getInstance().getAllocatedHours()
            ));

            String jsonPayload = gson.toJson(payload);
            byte[] rawBytes = jsonPayload.getBytes(StandardCharsets.UTF_8);

            // GZIP compress payload (shrinks JSON network transit by ~85%)
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            try (GZIPOutputStream gzos = new GZIPOutputStream(baos)) {
                gzos.write(rawBytes);
            }
            byte[] compressedBytes = baos.toByteArray();

            conn = NetworkClient.openConnection(endpoint);
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            conn.setRequestProperty("Content-Encoding", "gzip");
            conn.setRequestProperty("User-Agent", "swatcher-burp-plugin/1.2.0");

            if (apiKey != null && !apiKey.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            }

            conn.setConnectTimeout(2500);
            conn.setReadTimeout(5000);
            conn.setDoOutput(true);

            try (OutputStream os = conn.getOutputStream()) {
                os.write(compressedBytes, 0, compressedBytes.length);
            }

            int code = conn.getResponseCode();
            if (code >= 200 && code < 300) {
                return UploadResult.SUCCESS;
            } else if (code == 401 || code == 403) {
                return UploadResult.AUTH_REJECTED;
            } else {
                return UploadResult.NETWORK_OFFLINE;
            }
        } catch (Exception e) {
            return UploadResult.NETWORK_OFFLINE;
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignored) {}
            }
        }
    }

    public void addStatsListener(DispatcherStatsListener listener) {
        statsListeners.add(listener);
    }

    public void addLogListener(OperationalLogListener listener) {
        logListeners.add(listener);
    }

    private void notifyLog(String message) {
        for (OperationalLogListener l : logListeners) {
            try {
                l.onOperationalLog(message);
            } catch (Exception ignored) {}
        }
    }

    /**
     * Debounced stats notification (at most 4 updates/sec unless forced) to prevent EDT flooding.
     */
    private void notifyStats(boolean force) {
        long now = System.currentTimeMillis();
        long last = lastStatsNotify.get();
        if (!force && (now - last < 250)) {
            return;
        }
        if (lastStatsNotify.compareAndSet(last, now) || force) {
            long buffered = totalBuffered.get();
            long uploaded = totalUploaded.get();
            long failed = totalFailed.get();
            int queueSize = queue.size();
            long offlineCount = offlineQueue.getOfflineCount();
            boolean online = serverOnline;

            for (DispatcherStatsListener listener : statsListeners) {
                try {
                    listener.onStatsUpdated(buffered, uploaded, failed, queueSize, offlineCount, online);
                } catch (Exception ignored) {}
            }
        }
    }

    public boolean isServerOnline() {
        return serverOnline;
    }

    public boolean isAuthValid() {
        return authValid;
    }

    public long getOfflineCount() {
        return offlineQueue.getOfflineCount();
    }

    public void shutdown() {
        this.running = false;
        this.workerThread.interrupt();
        // Drain any un-flushed in-memory events to the offline store so no traffic is lost on unload
        List<TrafficEvent> remaining = new ArrayList<>();
        queue.drainTo(remaining);
        if (!remaining.isEmpty()) {
            offlineQueue.appendEvents(remaining);
        }
    }
}
