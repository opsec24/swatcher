package com.swatcher.core;

import com.google.gson.Gson;
import com.swatcher.model.TrafficEvent;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicLong;

public class TrafficDispatcher {
    private static TrafficDispatcher instance;

    private final BlockingQueue<TrafficEvent> queue = new LinkedBlockingQueue<>(5000);
    private final OfflineQueueManager offlineQueue = new OfflineQueueManager();
    private final Gson gson = new Gson();
    private final Thread workerThread;
    private volatile boolean running = true;
    private volatile boolean serverOnline = true;

    private final AtomicLong totalBuffered = new AtomicLong(0);
    private final AtomicLong totalUploaded = new AtomicLong(0);
    private final AtomicLong totalFailed = new AtomicLong(0);

    public interface DispatcherStatsListener {
        void onStatsUpdated(long buffered, long uploaded, long failed, int queueSize, long offlineCount, boolean isServerOnline);
    }

    private final List<DispatcherStatsListener> statsListeners = new ArrayList<>();

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
            notifyStats();
        } else {
            System.err.println("[swatcher] Queue full! Persisting directly to offline store.");
            List<TrafficEvent> fallbackList = new ArrayList<>();
            fallbackList.add(event);
            offlineQueue.appendEvents(fallbackList);
            serverOnline = false;
            totalFailed.incrementAndGet();
            notifyStats();
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

                // If offline queue has pending events or server is offline, periodically probe & drain
                if ((!serverOnline || offlineQueue.hasPendingEvents()) && (now - lastOfflineProbe >= 4000)) {
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

        // If server is known to be offline, immediately save to local disk without waiting for connection timeout
        if (!serverOnline) {
            offlineQueue.appendEvents(batch);
            totalFailed.addAndGet(batch.size());
            notifyStats();
            return;
        }

        boolean success = executeHttpBatchUpload(batch);
        if (success) {
            serverOnline = true;
            totalUploaded.addAndGet(batch.size());
            if (offlineQueue.hasPendingEvents()) {
                drainOfflineQueue();
            }
        } else {
            serverOnline = false;
            offlineQueue.appendEvents(batch);
            totalFailed.addAndGet(batch.size());
            System.err.println("[swatcher] Server offline! Saved " + batch.size() + " logs to local offline store: " + offlineQueue.getQueueFilePath());
        }
        notifyStats();
    }

    /**
     * Replays offline-stored logs in chunks to the central server when connectivity resumes.
     */
    public synchronized void drainOfflineQueue() {
        if (!offlineQueue.hasPendingEvents()) return;

        int maxChunksPerPass = 20; // Up to 1000 events per pass
        int pass = 0;

        while (offlineQueue.hasPendingEvents() && pass < maxChunksPerPass) {
            List<TrafficEvent> chunk = offlineQueue.peekBatch(50);
            if (chunk.isEmpty()) break;

            boolean success = executeHttpBatchUpload(chunk);
            if (success) {
                serverOnline = true;
                offlineQueue.commitRemove(chunk.size());
                totalUploaded.addAndGet(chunk.size());
                notifyStats();
                pass++;
            } else {
                serverOnline = false;
                notifyStats();
                break;
            }
        }

        if (!offlineQueue.hasPendingEvents() && serverOnline) {
            System.out.println("[swatcher] All offline logs uploaded successfully. System back in LIVE recording mode.");
        }
    }

    private boolean executeHttpBatchUpload(List<TrafficEvent> batch) {
        if (batch.isEmpty()) return true;

        String serverUrl = SessionManager.getInstance().getServerUrl();
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

            URL url = new URL(endpoint);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            conn.setRequestProperty("User-Agent", "swatcher-burp-plugin/1.0");

            if (apiKey != null && !apiKey.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            }

            conn.setConnectTimeout(4000);
            conn.setReadTimeout(8000);
            conn.setDoOutput(true);

            byte[] input = jsonPayload.getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(input, 0, input.length);
            }

            int code = conn.getResponseCode();
            return (code >= 200 && code < 300);
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignored) {}
            }
        }
    }

    public void addStatsListener(DispatcherStatsListener listener) {
        statsListeners.add(listener);
    }

    private void notifyStats() {
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

    public boolean isServerOnline() {
        return serverOnline;
    }

    public long getOfflineCount() {
        return offlineQueue.getOfflineCount();
    }

    public void shutdown() {
        this.running = false;
        this.workerThread.interrupt();
    }
}
