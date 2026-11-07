package com.swatcher;

import burp.api.montoya.BurpExtension;
import burp.api.montoya.MontoyaApi;
import com.swatcher.core.SessionManager;
import com.swatcher.core.TrafficDispatcher;
import com.swatcher.handlers.SwatcherHttpHandler;
import com.swatcher.ui.SwatcherTab;

public class SwatcherExtension implements BurpExtension {

    @Override
    public void initialize(MontoyaApi api) {
        api.extension().setName("swatcher - Burp Traffic Collector");

        // 1. Initialize Session Manager from Burp persistence (auto-resumes saved projects!)
        SessionManager.getInstance().initializeFromBurp(api);

        // 2. Initialize UI Suite Tab
        SwatcherTab swatcherTab = new SwatcherTab();
        api.userInterface().registerSuiteTab("swatcher", swatcherTab);

        // 3. Register HTTP Interception Handler
        api.http().registerHttpHandler(new SwatcherHttpHandler(api, swatcherTab));

        // 4. Register shutdown hook for background thread pool
        api.extension().registerUnloadingHandler(() -> {
            api.logging().logToOutput("[swatcher] Unloading extension and draining upload queue...");
            TrafficDispatcher.getInstance().shutdown();
        });

        api.logging().logToOutput("=================================================");
        api.logging().logToOutput("  swatcher v1.2.2 initialized successfully.");
        api.logging().logToOutput("  Burp Suite Traffic Governance & Proof-of-Work");
        api.logging().logToOutput("=================================================");
    }
}
