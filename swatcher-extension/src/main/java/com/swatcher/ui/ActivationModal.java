package com.swatcher.ui;

import com.swatcher.core.SessionManager;

import javax.swing.*;
import java.awt.*;

public class ActivationModal {

    public static void showActivationPrompt(Component parent, String detectedHost) {
        SwingUtilities.invokeLater(() -> {
            JDialog dialog = new JDialog((Frame) SwingUtilities.getWindowAncestor(parent), "swatcher - Recording Inactive", true);
            dialog.setLayout(new BorderLayout(15, 15));
            dialog.setResizable(false);

            JPanel contentPanel = new JPanel();
            contentPanel.setLayout(new BoxLayout(contentPanel, BoxLayout.Y_AXIS));
            contentPanel.setBorder(BorderFactory.createEmptyBorder(15, 20, 15, 20));

            JLabel titleLabel = new JLabel("<html><b style='font-size:13px; color:#4f46e5;'>Target Traffic Detected (Recording Disabled)</b></html>");
            JLabel hostLabel = new JLabel("In-Scope Target: " + (detectedHost != null ? detectedHost : "Authorized target"));
            hostLabel.setFont(new Font(Font.MONOSPACED, Font.BOLD, 12));

            String welcomeSub = "";
            if (SessionManager.getInstance().isTokenVerified()) {
                welcomeSub = "<div style='color:#10b981; font-weight:bold; margin-top:4px;'>Pentester: "
                        + SessionManager.getInstance().getAuthenticatedFullName() + " (" + SessionManager.getInstance().getAuthenticatedUsername() + ")</div>";
            }

            JLabel descLabel = new JLabel("<html><div style='width:360px; margin-top:6px; color:#555;'>"
                    + welcomeSub
                    + "Traffic recording is currently paused. Please confirm the ServiceNow RITM, Application ID, "
                    + "and allocated effort hours for this engagement."
                    + "</div></html>");

            JPanel formPanel = new JPanel(new GridLayout(3, 2, 8, 8));
            formPanel.setBorder(BorderFactory.createEmptyBorder(12, 0, 10, 0));

            // Auto-suggest App ID from host if empty
            String currentAppId = SessionManager.getInstance().getApplicationId();
            if (currentAppId.isEmpty() && detectedHost != null && !detectedHost.isEmpty()) {
                String cleanHost = detectedHost.replaceAll("^(api|portal|stg|uat|dev|www)\\.", "");
                currentAppId = "APP-" + cleanHost.replaceAll("[^a-zA-Z0-9]", "-").toUpperCase();
            }

            JTextField ritmField = new JTextField(SessionManager.getInstance().getRitm(), 15);
            JTextField appField = new JTextField(currentAppId, 15);
            JTextField effortField = new JTextField(String.valueOf((int) SessionManager.getInstance().getAllocatedHours()), 15);

            formPanel.add(new JLabel("ServiceNow RITM:"));
            formPanel.add(ritmField);
            formPanel.add(new JLabel("Application ID:"));
            formPanel.add(appField);
            formPanel.add(new JLabel("Allocated Effort (Hours):"));
            formPanel.add(effortField);

            contentPanel.add(titleLabel);
            contentPanel.add(Box.createVerticalStrut(4));
            contentPanel.add(hostLabel);
            contentPanel.add(descLabel);
            contentPanel.add(formPanel);

            JPanel btnPanel = new JPanel(new FlowLayout(FlowLayout.RIGHT, 10, 10));
            JButton enableBtn = new JButton("Start Recording");
            enableBtn.setBackground(new Color(34, 197, 94));
            enableBtn.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 12));

            JButton remindBtn = new JButton("Remind Me Later");

            enableBtn.addActionListener(e -> {
                String ritm = ritmField.getText().trim();
                String appId = appField.getText().trim();
                double effort = 40.0;
                try { effort = Double.parseDouble(effortField.getText().trim()); } catch (Exception ignored) {}

                if (!SessionManager.getInstance().isTokenVerified()) {
                    JOptionPane.showMessageDialog(dialog,
                            "Your Swatcher API Key is not configured or verified.\n"
                            + "Please open the 'swatcher' tab in Burp Suite and verify your API token first.",
                            "API Key Required", JOptionPane.WARNING_MESSAGE);
                    dialog.dispose();
                    return;
                }

                if (ritm.isEmpty() || appId.isEmpty()) {
                    JOptionPane.showMessageDialog(dialog, "Please provide both RITM and Application ID.", "Validation Error", JOptionPane.WARNING_MESSAGE);
                    return;
                }
                SessionManager.getInstance().startSession(ritm, appId, effort);
                dialog.dispose();
            });

            remindBtn.addActionListener(e -> dialog.dispose());

            btnPanel.add(remindBtn);
            btnPanel.add(enableBtn);

            dialog.add(contentPanel, BorderLayout.CENTER);
            dialog.add(btnPanel, BorderLayout.SOUTH);

            dialog.pack();
            dialog.setLocationRelativeTo(parent);
            dialog.setVisible(true);
        });
    }
}
