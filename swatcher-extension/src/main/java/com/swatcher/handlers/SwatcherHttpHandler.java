package com.swatcher.handlers;

import burp.api.montoya.MontoyaApi;
import burp.api.montoya.http.message.HttpHeader;
import burp.api.montoya.http.handler.HttpHandler;
import burp.api.montoya.http.handler.HttpRequestToBeSent;
import burp.api.montoya.http.handler.HttpResponseReceived;
import burp.api.montoya.http.handler.RequestToBeSentAction;
import burp.api.montoya.http.handler.ResponseReceivedAction;
import burp.api.montoya.http.message.requests.HttpRequest;
import burp.api.montoya.http.message.responses.HttpResponse;
import com.swatcher.core.SessionManager;
import com.swatcher.core.TrafficDispatcher;
import com.swatcher.model.TrafficEvent;
import com.swatcher.ui.ActivationModal;
import com.swatcher.ui.SwatcherTab;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public class SwatcherHttpHandler implements HttpHandler {

    private final MontoyaApi api;
    private final SwatcherTab tab;

    public SwatcherHttpHandler(MontoyaApi api, SwatcherTab tab) {
        this.api = api;
        this.tab = tab;
    }

    @Override
    public RequestToBeSentAction handleHttpRequestToBeSent(HttpRequestToBeSent requestToBeSent) {
        try {
            boolean inScope = requestToBeSent.isInScope();

            // If target is in scope but recording is NOT enabled, prompt user
            if (inScope && !SessionManager.getInstance().isRecordingEnabled()) {
                if (SessionManager.getInstance().shouldPromptForActivation()) {
                    String host = requestToBeSent.httpService().host();
                    ActivationModal.showActivationPrompt(tab, host);
                }
            }
        } catch (Exception e) {
            api.logging().logToError("Error in handleHttpRequestToBeSent: " + e.getMessage());
        }

        return RequestToBeSentAction.continueWith(requestToBeSent);
    }

    @Override
    public ResponseReceivedAction handleHttpResponseReceived(HttpResponseReceived responseReceived) {
        try {
            HttpRequest req = responseReceived.initiatingRequest();
            boolean inScope = req.isInScope();

            // Only record when in-scope and recording is active
            if (inScope && SessionManager.getInstance().isRecordingEnabled()) {
                HttpResponse res = responseReceived;

                TrafficEvent event = new TrafficEvent();
                event.event_id = UUID.randomUUID().toString();
                event.session_id = SessionManager.getInstance().getCurrentSessionId();
                event.timestamp = Instant.now().toString();

                String toolName = "UNKNOWN";
                try {
                    toolName = responseReceived.toolSource().toolType().toolName().toUpperCase();
                } catch (Exception ignored) {}
                event.tool = toolName;

                event.tester = new TrafficEvent.TesterInfo(
                        SessionManager.getInstance().getTesterMachine()
                );
                event.engagement = new TrafficEvent.EngagementInfo(
                        SessionManager.getInstance().getRitm(),
                        SessionManager.getInstance().getApplicationId(),
                        SessionManager.getInstance().getAllocatedHours()
                );

                // Request details
                event.request = new TrafficEvent.RequestInfo();
                event.request.tool = toolName;
                event.request.method = req.method();
                event.request.url = req.url();
                event.request.host = req.httpService().host();
                event.request.port = req.httpService().port();
                event.request.path = req.path();
                event.request.query = req.path().contains("?") ? req.path().substring(req.path().indexOf("?") + 1) : "";

                Map<String, String> reqHeaders = new HashMap<>();
                for (HttpHeader h : req.headers()) {
                    reqHeaders.put(h.name(), h.value());
                }
                event.request.headers = reqHeaders;
                event.request.body = req.bodyToString();
                event.request.body_length = req.body().length();

                // Response details
                event.response = new TrafficEvent.ResponseInfo();
                event.response.status_code = res.statusCode();
                Map<String, String> resHeaders = new HashMap<>();
                for (HttpHeader h : res.headers()) {
                    resHeaders.put(h.name(), h.value());
                }
                event.response.headers = resHeaders;
                event.response.body = res.bodyToString();
                event.response.body_length = res.body().length();
                event.response.duration_ms = 0;

                // Dispatch event asynchronously
                TrafficDispatcher.getInstance().enqueue(event);

                // Update Burp UI tab
                tab.addTrafficRow(
                        Instant.now().toString().substring(11, 19),
                        toolName,
                        req.method(),
                        req.path(),
                        res.statusCode(),
                        0
                );
            }
        } catch (Exception e) {
            api.logging().logToError("Error in handleHttpResponseReceived: " + e.getMessage());
        }

        return ResponseReceivedAction.continueWith(responseReceived);
    }
}
