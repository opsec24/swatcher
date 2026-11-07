package com.swatcher.core;

import com.google.gson.Gson;
import com.swatcher.model.TrafficEvent;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Manages reliable offline persistence of traffic logs when the central Swatcher
 * server is unreachable. Events are serialized as JSON Lines (.jsonl) on local disk
 * and safely replayed in batches once server connectivity is restored.
 */
public class OfflineQueueManager {

    private final File queueFile;
    private final Gson gson = new Gson();
    private final AtomicLong offlineCount = new AtomicLong(0);

    public OfflineQueueManager() {
        File dir = new File(System.getProperty("user.home"), ".swatcher");
        if (!dir.exists()) {
            dir.mkdirs();
        }
        this.queueFile = new File(dir, "offline_queue.jsonl");
        initializeCount();
    }

    private void initializeCount() {
        if (!queueFile.exists()) {
            offlineCount.set(0);
            return;
        }

        long lines = 0;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                new FileInputStream(queueFile), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (!line.trim().isEmpty()) {
                    lines++;
                }
            }
        } catch (Exception e) {
            lines = 0;
        }
        offlineCount.set(lines);
    }

    /**
     * Appends a batch of traffic events to the local offline JSONL queue.
     */
    public synchronized void appendEvents(List<TrafficEvent> events) {
        if (events == null || events.isEmpty()) return;

        try (BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(
                new FileOutputStream(queueFile, true), StandardCharsets.UTF_8))) {
            for (TrafficEvent event : events) {
                String line = gson.toJson(event);
                writer.write(line);
                writer.newLine();
            }
            writer.flush();
            offlineCount.addAndGet(events.size());
        } catch (IOException e) {
            System.err.println("[swatcher-offline] Failed to append offline events: " + e.getMessage());
        }
    }

    /**
     * Peeks at up to maxBatchSize events from the beginning of the offline queue without removing them.
     */
    public synchronized List<TrafficEvent> peekBatch(int maxBatchSize) {
        List<TrafficEvent> batch = new ArrayList<>();
        if (!queueFile.exists() || offlineCount.get() <= 0) {
            return batch;
        }

        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                new FileInputStream(queueFile), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null && batch.size() < maxBatchSize) {
                line = line.trim();
                if (!line.isEmpty()) {
                    try {
                        TrafficEvent event = gson.fromJson(line, TrafficEvent.class);
                        if (event != null) {
                            batch.add(event);
                        }
                    } catch (Exception ignored) {}
                }
            }
        } catch (IOException e) {
            System.err.println("[swatcher-offline] Failed to read offline batch: " + e.getMessage());
        }
        return batch;
    }

    /**
     * Removes the first `count` lines from the offline file after a successful server upload.
     */
    public synchronized void commitRemove(int count) {
        if (count <= 0 || !queueFile.exists()) return;

        File tmpFile = new File(queueFile.getParentFile(), "offline_queue.tmp");
        long remaining = 0;

        try {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    new FileInputStream(queueFile), StandardCharsets.UTF_8));
                 BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(
                    new FileOutputStream(tmpFile), StandardCharsets.UTF_8))) {

                String line;
                int skipped = 0;
                while ((line = reader.readLine()) != null) {
                    if (line.trim().isEmpty()) {
                        continue; // Discard blank lines
                    }
                    if (skipped < count) {
                        skipped++;
                    } else {
                        writer.write(line);
                        writer.newLine();
                        remaining++;
                    }
                }
                writer.flush();
            }

            // Atomic file replace with fallback for OS file locking (e.g. Windows)
            Path tmpPath = tmpFile.toPath();
            Path queuePath = queueFile.toPath();
            try {
                Files.move(tmpPath, queuePath, StandardCopyOption.REPLACE_EXISTING);
            } catch (IOException moveEx) {
                Files.copy(tmpPath, queuePath, StandardCopyOption.REPLACE_EXISTING);
                tmpFile.delete();
            }

            offlineCount.set(remaining);
        } catch (IOException e) {
            System.err.println("[swatcher-offline] Error committing batch removal: " + e.getMessage());
            if (tmpFile.exists()) {
                tmpFile.delete();
            }
            initializeCount();
        }
    }

    public long getOfflineCount() {
        return Math.max(0, offlineCount.get());
    }

    public boolean hasPendingEvents() {
        return getOfflineCount() > 0;
    }

    public String getQueueFilePath() {
        return queueFile.getAbsolutePath();
    }
}
