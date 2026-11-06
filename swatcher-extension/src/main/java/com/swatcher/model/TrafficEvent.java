package com.swatcher.model;

import java.util.Map;

public class TrafficEvent {
    public String event_id;
    public String session_id;
    public String tool;
    public String timestamp;
    public TesterInfo tester;
    public EngagementInfo engagement;
    public RequestInfo request;
    public ResponseInfo response;

    public static class TesterInfo {
        public String machine_name;

        public TesterInfo(String machine_name) {
            this.machine_name = machine_name;
        }
    }

    public static class EngagementInfo {
        public String ritm;
        public String application_id;
        public double allocated_hours;

        public EngagementInfo(String ritm, String application_id, double allocated_hours) {
            this.ritm = ritm;
            this.application_id = application_id;
            this.allocated_hours = allocated_hours;
        }
    }

    public static class RequestInfo {
        public String tool;
        public String method;
        public String url;
        public String host;
        public int port;
        public String path;
        public String query;
        public Map<String, String> headers;
        public String body;
        public int body_length;
    }

    public static class ResponseInfo {
        public int status_code;
        public Map<String, String> headers;
        public String body;
        public int body_length;
        public long duration_ms;
    }
}
