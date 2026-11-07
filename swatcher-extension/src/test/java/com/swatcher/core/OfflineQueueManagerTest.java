package com.swatcher.core;

import com.swatcher.model.TrafficEvent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

public class OfflineQueueManagerTest {

    private OfflineQueueManager queueManager;
    private File queueFile;

    @BeforeEach
    public void setUp() {
        queueManager = new OfflineQueueManager();
        queueFile = new File(queueManager.getQueueFilePath());
        if (queueFile.exists()) {
            queueFile.delete();
        }
        queueManager = new OfflineQueueManager();
    }

    @AfterEach
    public void tearDown() {
        if (queueFile != null && queueFile.exists()) {
            queueFile.delete();
        }
    }

    @Test
    public void testAppendAndPeekBatch() {
        List<TrafficEvent> events = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            TrafficEvent ev = new TrafficEvent();
            ev.event_id = "test-event-" + i;
            ev.tool = "PROXY";
            events.add(ev);
        }

        queueManager.appendEvents(events);

        assertEquals(5, queueManager.getOfflineCount());
        assertTrue(queueManager.hasPendingEvents());

        List<TrafficEvent> peeked = queueManager.peekBatch(3);
        assertEquals(3, peeked.size());
        assertEquals("test-event-0", peeked.get(0).event_id);
        assertEquals("test-event-1", peeked.get(1).event_id);
        assertEquals("test-event-2", peeked.get(2).event_id);

        // Count should still be 5 because we only peeked
        assertEquals(5, queueManager.getOfflineCount());
    }

    @Test
    public void testCommitRemove() {
        List<TrafficEvent> events = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            TrafficEvent ev = new TrafficEvent();
            ev.event_id = "event-" + i;
            events.add(ev);
        }
        queueManager.appendEvents(events);

        // Remove 2 events
        queueManager.commitRemove(2);
        assertEquals(3, queueManager.getOfflineCount());

        List<TrafficEvent> remaining = queueManager.peekBatch(10);
        assertEquals(3, remaining.size());
        assertEquals("event-2", remaining.get(0).event_id);
        assertEquals("event-3", remaining.get(1).event_id);
        assertEquals("event-4", remaining.get(2).event_id);

        // Remove all remaining
        queueManager.commitRemove(3);
        assertEquals(0, queueManager.getOfflineCount());
        assertFalse(queueManager.hasPendingEvents());
    }

    @Test
    public void testBlankLinesResilience() throws Exception {
        // Manually write file with empty lines interspersed
        java.nio.file.Files.writeString(queueFile.toPath(),
                "{\"event_id\":\"ev-1\"}\n\n  \n{\"event_id\":\"ev-2\"}\n\n{\"event_id\":\"ev-3\"}\n");

        OfflineQueueManager qm = new OfflineQueueManager();
        assertEquals(3, qm.getOfflineCount());

        List<TrafficEvent> batch = qm.peekBatch(2);
        assertEquals(2, batch.size());
        assertEquals("ev-1", batch.get(0).event_id);
        assertEquals("ev-2", batch.get(1).event_id);

        qm.commitRemove(2);
        assertEquals(1, qm.getOfflineCount());

        List<TrafficEvent> remaining = qm.peekBatch(5);
        assertEquals(1, remaining.size());
        assertEquals("ev-3", remaining.get(0).event_id);
    }

    @Test
    public void testResetQueue() {
        List<TrafficEvent> events = new ArrayList<>();
        TrafficEvent ev = new TrafficEvent();
        ev.event_id = "ev-corrupt";
        events.add(ev);
        queueManager.appendEvents(events);
        assertTrue(queueManager.hasPendingEvents());

        queueManager.resetQueue();
        assertEquals(0, queueManager.getOfflineCount());
        assertFalse(queueManager.hasPendingEvents());
    }
}
