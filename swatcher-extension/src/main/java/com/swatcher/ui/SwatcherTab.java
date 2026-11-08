package com.swatcher.ui;

import com.swatcher.core.SessionManager;
import com.swatcher.core.TrafficDispatcher;

import javax.swing.*;
import javax.swing.border.EmptyBorder;
import javax.swing.event.DocumentEvent;
import javax.swing.event.DocumentListener;
import java.awt.*;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;

public class SwatcherTab extends JPanel {

    private final JLabel statusLabel;
    private final JLabel welcomeLabel;
    private final JTextField ritmField;
    private final JTextField appIdField;
    private final JTextField effortField;
    private final JTextField serverUrlField;
    private final JPasswordField apiKeyField;
    private final JCheckBox trustCaCheckbox;
    private final JTextField corpProxyField;
    private final JButton toggleBtn;
    private final JButton verifyBtn;

    private final JLabel bufferedLabel;
    private final JLabel uploadedLabel;
    private final JLabel failedLabel;
    private final JLabel backlogLabel;

    private final JTextArea consoleArea;
    private boolean isUpdatingUI = false;

    public SwatcherTab() {
        setLayout(new BorderLayout(10, 10));
        setBorder(new EmptyBorder(15, 15, 15, 15));

        // Top Header
        JPanel topPanel = new JPanel();
        topPanel.setLayout(new BoxLayout(topPanel, BoxLayout.Y_AXIS));

        JPanel titleBar = new JPanel(new BorderLayout());
        JLabel title = new JLabel("swatcher // Burp Suite Traffic Governance");
        title.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 16));
        titleBar.add(title, BorderLayout.WEST);

        statusLabel = new JLabel("STATUS: PAUSED");
        statusLabel.setFont(new Font(Font.MONOSPACED, Font.BOLD, 13));
        statusLabel.setForeground(new Color(239, 68, 68));
        titleBar.add(statusLabel, BorderLayout.EAST);

        topPanel.add(titleBar);

        // Welcome / Auth Status Banner
        JPanel authBanner = new JPanel(new BorderLayout());
        authBanner.setBorder(BorderFactory.createEmptyBorder(4, 0, 6, 0));
        welcomeLabel = new JLabel(SessionManager.getInstance().getServerUrl().isEmpty()
                ? "Central Server URL required. Please configure below."
                : "Checking API Token authentication with central server...");
        welcomeLabel.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 12));
        welcomeLabel.setForeground(new Color(156, 163, 175));
        authBanner.add(welcomeLabel, BorderLayout.WEST);
        topPanel.add(authBanner);

        topPanel.add(Box.createVerticalStrut(6));

        // Controls Box
        JPanel controlsBox = new JPanel(new GridBagLayout());
        controlsBox.setBorder(BorderFactory.createTitledBorder("Pentester Authentication & Project Session Configuration"));
        GridBagConstraints gbc = new GridBagConstraints();
        gbc.insets = new Insets(4, 8, 4, 8);
        gbc.fill = GridBagConstraints.HORIZONTAL;

        // Row 0: API Token (Configured ONCE globally)
        gbc.gridx = 0; gbc.gridy = 0;
        controlsBox.add(new JLabel("Swatcher API Token:"), gbc);
        gbc.gridx = 1; gbc.gridwidth = 2;
        apiKeyField = new JPasswordField(SessionManager.getInstance().getApiKey(), 24);
        controlsBox.add(apiKeyField, gbc);
        gbc.gridx = 3; gbc.gridwidth = 1;
        verifyBtn = new JButton("Verify & Save Token");
        verifyBtn.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 11));
        verifyBtn.addActionListener(e -> handleVerifyAndSaveKey());
        controlsBox.add(verifyBtn, gbc);

        // Row 1: RITM and App ID (Project Scoped)
        gbc.gridx = 0; gbc.gridy = 1; gbc.gridwidth = 1;
        controlsBox.add(new JLabel("ServiceNow RITM:"), gbc);
        gbc.gridx = 1;
        ritmField = new JTextField(SessionManager.getInstance().getRitm(), 15);
        controlsBox.add(ritmField, gbc);

        gbc.gridx = 2;
        controlsBox.add(new JLabel("Application ID:"), gbc);
        gbc.gridx = 3;
        appIdField = new JTextField(SessionManager.getInstance().getApplicationId(), 15);
        controlsBox.add(appIdField, gbc);

        // Row 2: Effort and Server URL
        gbc.gridx = 0; gbc.gridy = 2;
        controlsBox.add(new JLabel("Allocated Effort (Hours):"), gbc);
        gbc.gridx = 1;
        effortField = new JTextField(String.valueOf((int) SessionManager.getInstance().getAllocatedHours()), 15);
        controlsBox.add(effortField, gbc);

        gbc.gridx = 2;
        controlsBox.add(new JLabel("Central Server URL:"), gbc);
        gbc.gridx = 3;
        serverUrlField = new JTextField(SessionManager.getInstance().getServerUrl(), 20);
        serverUrlField.setToolTipText("e.g. https://swatcher.corp.internal:9090");
        controlsBox.add(serverUrlField, gbc);

        // Row 3: Enterprise CA & Corporate Forward Proxy Configuration (McAfee, Zscaler, Internal PKI)
        gbc.gridx = 0; gbc.gridy = 3; gbc.gridwidth = 2;
        trustCaCheckbox = new JCheckBox("Trust Enterprise CAs (McAfee, Zscaler, Corp PKI)", SessionManager.getInstance().isTrustEnterpriseCAs());
        trustCaCheckbox.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 11));
        trustCaCheckbox.setToolTipText("Bypasses Java PKIX errors when corporate forward proxies (McAfee Web Gateway, Skyhigh, BlueCoat) inspect TLS traffic.");
        trustCaCheckbox.addActionListener(e -> {
            boolean selected = trustCaCheckbox.isSelected();
            SessionManager.getInstance().setTrustEnterpriseCAs(selected);
            appendConsoleLog(selected ? "✓ Enterprise CA trust enabled (McAfee/Zscaler/Corporate PKI)." : "⚠️ Strict CA verification enabled.");
        });
        controlsBox.add(trustCaCheckbox, gbc);

        gbc.gridx = 2; gbc.gridwidth = 1;
        controlsBox.add(new JLabel("Corporate Proxy:"), gbc);
        gbc.gridx = 3;
        corpProxyField = new JTextField(SessionManager.getInstance().getCorporateProxy(), 20);
        corpProxyField.setToolTipText("Optional corporate forward proxy (e.g. proxy.corp.internal:8080 or http://10.0.0.1:8080)");
        corpProxyField.getDocument().addDocumentListener(new DocumentListener() {
            private void updateProxy() {
                if (isUpdatingUI) return;
                String proxy = corpProxyField.getText().trim();
                SessionManager.getInstance().setCorporateProxy(proxy);
            }
            @Override public void insertUpdate(DocumentEvent e) { updateProxy(); }
            @Override public void removeUpdate(DocumentEvent e) { updateProxy(); }
            @Override public void changedUpdate(DocumentEvent e) { updateProxy(); }
        });
        controlsBox.add(corpProxyField, gbc);

        // Row 4: Actions
        gbc.gridx = 0; gbc.gridy = 4; gbc.gridwidth = 4;
        JPanel actionRow = new JPanel(new FlowLayout(FlowLayout.RIGHT));
        toggleBtn = new JButton("Start Recording Session");
        toggleBtn.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 12));
        toggleBtn.setBackground(new Color(34, 197, 94));
        toggleBtn.setForeground(Color.BLACK);

        toggleBtn.addActionListener(e -> toggleRecording());
        actionRow.add(toggleBtn);
        controlsBox.add(actionRow, gbc);

        topPanel.add(controlsBox);
        topPanel.add(Box.createVerticalStrut(8));

        // Stats Bar
        JPanel statsPanel = new JPanel(new GridLayout(1, 4, 10, 0));
        statsPanel.setBorder(BorderFactory.createTitledBorder("Live Upload Queue Telemetry"));

        bufferedLabel = new JLabel("Buffered: 0", SwingConstants.CENTER);
        uploadedLabel = new JLabel("Uploaded: 0", SwingConstants.CENTER);
        failedLabel = new JLabel("Offline Store: 0", SwingConstants.CENTER);
        backlogLabel = new JLabel("Active Queue: 0", SwingConstants.CENTER);

        statsPanel.add(bufferedLabel);
        statsPanel.add(uploadedLabel);
        statsPanel.add(failedLabel);
        statsPanel.add(backlogLabel);

        topPanel.add(statsPanel);
        add(topPanel, BorderLayout.NORTH);

        // Center: Terminal Diagnostic Stream Console
        consoleArea = new JTextArea();
        consoleArea.setEditable(false);
        consoleArea.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
        consoleArea.setBackground(new Color(7, 23, 44)); // Deepest Navy #07172C
        consoleArea.setForeground(new Color(228, 228, 231)); // Crisp terminal text
        consoleArea.setCaretColor(new Color(255, 196, 54)); // Gold caret #FFC436
        consoleArea.setMargin(new Insets(8, 10, 8, 10));

        JScrollPane consoleScrollPane = new JScrollPane(consoleArea);
        consoleScrollPane.setBorder(BorderFactory.createTitledBorder("swatcher Telemetry Stream & Diagnostics Console"));

        JPanel centerPanel = new JPanel(new BorderLayout(0, 4));
        centerPanel.add(consoleScrollPane, BorderLayout.CENTER);

        JPanel consoleFooter = new JPanel(new BorderLayout());
        JLabel consoleHelp = new JLabel(" Operational logs and queue activity stream (high-performance, zero UI overhead).");
        consoleHelp.setFont(new Font(Font.SANS_SERIF, Font.ITALIC, 11));
        consoleHelp.setForeground(new Color(107, 114, 128));

        JButton clearBtn = new JButton("Clear Console");
        clearBtn.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 11));
        clearBtn.addActionListener(e -> consoleArea.setText(""));

        consoleFooter.add(consoleHelp, BorderLayout.WEST);
        consoleFooter.add(clearBtn, BorderLayout.EAST);
        centerPanel.add(consoleFooter, BorderLayout.SOUTH);

        add(centerPanel, BorderLayout.CENTER);

        // Automatic Auto-Enable DocumentListener
        DocumentListener autoEnableListener = new DocumentListener() {
            private void triggerAutoCheck() {
                if (isUpdatingUI) return;
                String r = ritmField.getText().trim();
                String a = appIdField.getText().trim();
                String k = new String(apiKeyField.getPassword()).trim();
                String u = serverUrlField.getText().trim();
                double effort = 40.0;
                try { effort = Double.parseDouble(effortField.getText().trim()); } catch (Exception ignored) {}

                if (!u.isEmpty()) {
                    SessionManager.getInstance().setServerUrl(u);
                }
                if (!k.isEmpty()) {
                    SessionManager.getInstance().setApiKey(k);
                }
                if (!r.isEmpty() && !a.isEmpty()) {
                    SessionManager.getInstance().updateProjectDetails(r, a, effort);
                }
                updateStatusLabel();
            }

            @Override public void insertUpdate(DocumentEvent e) { triggerAutoCheck(); }
            @Override public void removeUpdate(DocumentEvent e) { triggerAutoCheck(); }
            @Override public void changedUpdate(DocumentEvent e) { triggerAutoCheck(); }
        };

        ritmField.getDocument().addDocumentListener(autoEnableListener);
        appIdField.getDocument().addDocumentListener(autoEnableListener);
        apiKeyField.getDocument().addDocumentListener(autoEnableListener);
        serverUrlField.getDocument().addDocumentListener(autoEnableListener);

        // Wire session manager listeners
        SessionManager.getInstance().addListener(new SessionManager.SessionStateListener() {
            @Override
            public void onSessionStateChanged(boolean isRecording, String ritm, String appId, double effort) {
                SwingUtilities.invokeLater(() -> {
                    updateSessionUI(isRecording, ritm, appId, effort);
                    if (isRecording) {
                        appendConsoleLog("▶ Session ACTIVE: " + ritm + " (" + appId + ") - " + ((int) effort) + "h allocated effort.");
                    } else {
                        appendConsoleLog("⏸ Session PAUSED.");
                    }
                });
            }

            @Override
            public void onAuthStatusChanged(boolean isVerified, String fullName, String username, String message) {
                SwingUtilities.invokeLater(() -> {
                    updateAuthUI(isVerified, fullName, username, message);
                    if (isVerified) {
                        appendConsoleLog("✓ Authenticated with Central Server as " + fullName + " (" + username + ").");
                    } else if (message != null && !message.isEmpty()) {
                        appendConsoleLog("⚠️ " + message);
                    }
                });
            }
        });

        // Wire dispatcher stats telemetry listener (throttled/debounced)
        TrafficDispatcher.getInstance().addStatsListener((buffered, uploaded, failed, queueSize, offlineCount, isServerOnline) -> {
            SwingUtilities.invokeLater(() -> {
                bufferedLabel.setText("Buffered: " + buffered);
                uploadedLabel.setText("Uploaded: " + uploaded);
                failedLabel.setText("Offline Store: " + offlineCount);
                backlogLabel.setText("Active Queue: " + queueSize);
                updateStatusLabel();
            });
        });

        // Wire dispatcher operational log listener
        TrafficDispatcher.getInstance().addLogListener(this::appendConsoleLog);

        // Initial console greetings
        appendConsoleLog("swatcher Burp Suite Traffic Collector v1.2.3 initialized.");
        if (!SessionManager.getInstance().getServerUrl().isEmpty()) {
            appendConsoleLog("Configured Central Server: " + SessionManager.getInstance().getServerUrl());
        }
        if (SessionManager.getInstance().isTrustEnterpriseCAs()) {
            appendConsoleLog("Enterprise CA Support: ENABLED (McAfee, Zscaler, Internal PKI)");
        }
        if (!SessionManager.getInstance().getCorporateProxy().isEmpty()) {
            appendConsoleLog("Corporate Forward Proxy: " + SessionManager.getInstance().getCorporateProxy());
        }
        if (!SessionManager.getInstance().getRitm().isEmpty()) {
            appendConsoleLog("Active Engagement: " + SessionManager.getInstance().getRitm() + " (" + SessionManager.getInstance().getApplicationId() + ")");
        }

        updateStatusLabel();
    }

    public void appendConsoleLog(String message) {
        SwingUtilities.invokeLater(() -> {
            String time = LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"));
            consoleArea.append("[" + time + "] $ " + message + "\n");
            int lineCount = consoleArea.getLineCount();
            if (lineCount > 300) {
                try {
                    int endOffset = consoleArea.getLineEndOffset(lineCount - 250);
                    consoleArea.replaceRange("", 0, endOffset);
                } catch (Exception ignored) {}
            }
            consoleArea.setCaretPosition(consoleArea.getDocument().getLength());
        });
    }

    private void handleVerifyAndSaveKey() {
        String token = new String(apiKeyField.getPassword()).trim();
        String url = serverUrlField.getText().trim();

        if (url.isEmpty()) {
            JOptionPane.showMessageDialog(this, "Please enter your Central Server URL (e.g. https://swatcher.corp.internal:9090).", "Server URL Required", JOptionPane.WARNING_MESSAGE);
            return;
        }

        if (token.isEmpty()) {
            JOptionPane.showMessageDialog(this, "Please enter your Swatcher API Key.", "Input Required", JOptionPane.WARNING_MESSAGE);
            return;
        }

        SessionManager.getInstance().setServerUrl(url);
        SessionManager.getInstance().setApiKey(token);
        verifyBtn.setEnabled(false);
        verifyBtn.setText("Verifying...");
        appendConsoleLog("Verifying API token against " + url + "...");

        new Thread(() -> {
            boolean valid = SessionManager.getInstance().verifyApiKeyWithServer();
            SwingUtilities.invokeLater(() -> {
                verifyBtn.setEnabled(true);
                verifyBtn.setText("Verify & Save Token");
                if (valid) {
                    JOptionPane.showMessageDialog(this,
                            "Welcome back, " + SessionManager.getInstance().getAuthenticatedFullName() + "!\n\n"
                            + "API Token verified successfully and saved globally on your machine.\n"
                            + "You will not need to enter this key again.",
                            "Authentication Successful", JOptionPane.INFORMATION_MESSAGE);
                } else {
                    JOptionPane.showMessageDialog(this,
                            "API Token verification failed.\nPlease ensure your Swatcher server is running at " + url + " and your key is active.",
                            "Authentication Failed", JOptionPane.ERROR_MESSAGE);
                }
                updateStatusLabel();
            });
        }).start();
    }

    private void toggleRecording() {
        if (SessionManager.getInstance().isRecordingEnabled()) {
            SessionManager.getInstance().stopSession();
        } else {
            String ritm = ritmField.getText().trim();
            String appId = appIdField.getText().trim();
            String token = new String(apiKeyField.getPassword()).trim();
            String url = serverUrlField.getText().trim();
            double effort = 40.0;
            try { effort = Double.parseDouble(effortField.getText().trim()); } catch (Exception ignored) {}

            if (url.isEmpty()) {
                JOptionPane.showMessageDialog(this, "Please configure your Central Server URL (e.g. https://swatcher.corp.internal:9090).", "Server URL Required", JOptionPane.WARNING_MESSAGE);
                return;
            }
            if (token.isEmpty()) {
                JOptionPane.showMessageDialog(this, "Please configure your Swatcher API Token (issued by AppSec Leadership).", "API Token Required", JOptionPane.WARNING_MESSAGE);
                return;
            }
            if (ritm.isEmpty() || appId.isEmpty()) {
                JOptionPane.showMessageDialog(this, "Please provide both RITM and Application ID to record traffic.", "Input Required", JOptionPane.WARNING_MESSAGE);
                return;
            }

            SessionManager.getInstance().setServerUrl(url);
            SessionManager.getInstance().setApiKey(token);
            SessionManager.getInstance().startSession(ritm, appId, effort);
        }
        updateStatusLabel();
    }

    private void updateAuthUI(boolean isVerified, String fullName, String username, String message) {
        if (isVerified) {
            welcomeLabel.setText("<html><b style='color:#10b981;'>✓ Authenticated as " + fullName + " (" + username + ")</b></html>");
        } else {
            welcomeLabel.setText("<html><span style='color:#f59e0b;'>⚠️ " + message + "</span></html>");
        }
        updateStatusLabel();
    }

    private void updateSessionUI(boolean isRecording, String ritm, String appId, double effort) {
        isUpdatingUI = true;
        try {
            if (!ritmField.hasFocus() && !ritmField.getText().trim().equalsIgnoreCase(ritm)) ritmField.setText(ritm);
            if (!appIdField.hasFocus() && !appIdField.getText().trim().equalsIgnoreCase(appId)) appIdField.setText(appId);
            if (!effortField.hasFocus()) effortField.setText(String.valueOf((int) effort));
            if (!serverUrlField.hasFocus()) serverUrlField.setText(SessionManager.getInstance().getServerUrl());
            if (!corpProxyField.hasFocus() && !corpProxyField.getText().trim().equals(SessionManager.getInstance().getCorporateProxy())) {
                corpProxyField.setText(SessionManager.getInstance().getCorporateProxy());
            }
            trustCaCheckbox.setSelected(SessionManager.getInstance().isTrustEnterpriseCAs());
            if (!apiKeyField.hasFocus() && !new String(apiKeyField.getPassword()).trim().equals(SessionManager.getInstance().getApiKey())) {
                apiKeyField.setText(SessionManager.getInstance().getApiKey());
            }
        } finally {
            isUpdatingUI = false;
        }

        updateStatusLabel();
    }

    private void updateStatusLabel() {
        String sUrl = SessionManager.getInstance().getServerUrl();
        String apiKey = SessionManager.getInstance().getApiKey();
        boolean recording = SessionManager.getInstance().isRecordingEnabled();
        boolean online = TrafficDispatcher.getInstance().isServerOnline();
        boolean authOk = TrafficDispatcher.getInstance().isAuthValid();
        long offline = TrafficDispatcher.getInstance().getOfflineCount();
        String ritm = SessionManager.getInstance().getRitm();
        String appId = SessionManager.getInstance().getApplicationId();

        if (sUrl == null || sUrl.trim().isEmpty()) {
            statusLabel.setText("STATUS: SERVER URL REQUIRED");
            statusLabel.setForeground(new Color(245, 158, 11)); // Amber
            toggleBtn.setText("Start Recording Session");
            toggleBtn.setBackground(new Color(156, 163, 175)); // Gray
            toggleBtn.setForeground(Color.BLACK);
        } else if (apiKey == null || apiKey.trim().isEmpty()) {
            statusLabel.setText("STATUS: API TOKEN REQUIRED");
            statusLabel.setForeground(new Color(245, 158, 11)); // Amber
            toggleBtn.setText("Start Recording Session");
            toggleBtn.setBackground(new Color(156, 163, 175)); // Gray
            toggleBtn.setForeground(Color.BLACK);
        } else if (!recording) {
            statusLabel.setText("STATUS: PAUSED");
            statusLabel.setForeground(new Color(239, 68, 68)); // Red
            toggleBtn.setText("Start Recording Session");
            toggleBtn.setBackground(new Color(34, 197, 94)); // Green
            toggleBtn.setForeground(Color.BLACK);
        } else if (!authOk) {
            statusLabel.setText("STATUS: AUTH REJECTED - Invalid API Token");
            statusLabel.setForeground(new Color(239, 68, 68)); // Red
            toggleBtn.setText("Pause Recording");
            toggleBtn.setBackground(new Color(239, 68, 68)); // Red
            toggleBtn.setForeground(Color.WHITE);
        } else if (!online) {
            String countNote = offline > 0 ? " (" + offline + " queued locally)" : "";
            statusLabel.setText("STATUS: SAVING OFFLINE - Central Server Offline" + countNote);
            statusLabel.setForeground(new Color(245, 158, 11)); // Amber
            toggleBtn.setText("Pause Recording");
            toggleBtn.setBackground(new Color(239, 68, 68)); // Red
            toggleBtn.setForeground(Color.WHITE);
        } else if (offline > 0) {
            statusLabel.setText("STATUS: RECORDING (Draining " + offline + " offline logs...)");
            statusLabel.setForeground(new Color(59, 130, 246)); // Blue
            toggleBtn.setText("Pause Recording");
            toggleBtn.setBackground(new Color(239, 68, 68)); // Red
            toggleBtn.setForeground(Color.WHITE);
        } else {
            statusLabel.setText("STATUS: RECORDING (LIVE - " + ritm + " / " + appId + ")");
            statusLabel.setForeground(new Color(34, 197, 94)); // Green
            toggleBtn.setText("Pause Recording");
            toggleBtn.setBackground(new Color(239, 68, 68)); // Red
            toggleBtn.setForeground(Color.WHITE);
        }
    }
}
