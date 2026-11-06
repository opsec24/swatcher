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
    private final Gson gson = new Gson();
    private final Thread workerThread;
    private volatile boolean running = true;

    private final AtomicLong totalBuffered = new AtomicLong(0);
    private final AtomicLong totalUploaded = new AtomicLong(0);
    private final AtomicLong totalFailed = new AtomicLong(0);

    public interface DispatcherStatsListener {
        void onStatsUpdated(long buffered, long uploaded, long failed, int queueSize);
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
            System.err.println("[swatcher] Queue full! Dropping event: " + event.event_id);
            totalFailed.incrementAndGet();
            notifyStats();
        }
    }

    private void runWorker() {
        List<TrafficEvent> batch = new ArrayList<>();
        long lastFlush = System.currentTimeMillis();

        while (running) {
            try {
                TrafficEvent event = queue.poll(500, java.util.concurrent.TimeUnit.MILLISECONDS);
                if (event != null) {
                    batch.add(event);
                }

                long now = System.currentTimeMillis();
                boolean shouldFlush = batch.size() >= 25 || (now - lastFlush >= 3000 && !batch.isEmpty());

                if (shouldFlush) {
                    sendBatch(batch);
                    batch.clear();
                    lastFlush = now;
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                System.err.println("[swatcher] Error in dispatcher loop: " + e.getMessage());
            }
        }

        if (!batch.isEmpty()) {
            sendBatch(batch);
        }
    }

    private void sendBatch(List<TrafficEvent> batch) {
        if (batch.isEmpty()) return;

        String serverUrl = SessionManager.getInstance().getServerUrl();
        String apiKey = SessionManager.getInstance().getApiKey();
        String endpoint = serverUrl.replaceAll("/+$", "") + "/api/v1/ingest/batch";

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
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            conn.setRequestProperty("User-Agent", "swatcher-burp-plugin/1.0");
            
            // Authenticate with Bearer API Token
            if (apiKey != null && !apiKey.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            }

            conn.setConnectTimeout(5000);
            conn.setReadTimeout(10000);
            conn.setDoOutput(true);

            byte[] input = jsonPayload.getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(input, 0, input.length);
            }

            int code = conn.getResponseCode();
            if (code >= 200 && code < 300) {
                totalUploaded.addAndGet(batch.size());
            } else {
                System.err.println("[swatcher] Server returned error code " + code + " for batch upload.");
                totalFailed.addAndGet(batch.size());
            }
            conn.disconnect();
        } catch (Exception e) {
            System.err.println("[swatcher] Failed to upload batch to " + endpoint + ": " + e.getMessage());
            totalFailed.addAndGet(batch.size());
        } finally {
            notifyStats();
        }
    }

    public void addStatsListener(DispatcherStatsListener listener) {
        statsListeners.add(listener);
    }

    private void notifyStats() {
        for (DispatcherStatsListener listener : statsListeners) {
            try {
                listener.onStatsUpdated(totalBuffered.get(), totalUploaded.get(), totalFailed.get(), queue.size());
            } catch (Exception ignored) {}
        }
    }

    public void shutdown() {
        this.running = false;
        this.workerThread.interrupt();
    }
}
