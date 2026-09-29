package com.dhegeniusmedia.sms;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.app.NotificationManagerCompat;

public class MainActivity extends Activity {
    private EditText token;
    private TextView status;
    private TextView whatsappStatus;
    private static final int SMS_REQ = 42;

    @Override
    public void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(32, 48, 32, 32);

        TextView title = new TextView(this);
        title.setText("DHE GENIUS MEDIA\nSMS & WhatsApp Companion");
        title.setTextSize(24);
        box.addView(title);

        TextView info = new TextView(this);
        info.setText("\nAuthorize this phone to sync its SMS and WhatsApp notifications to your DGM account. Only use this on a phone you own or are authorized to manage.\n");
        box.addView(info);

        token = new EditText(this);
        token.setHint("Paste DGM device token");
        token.setSingleLine(true);
        box.addView(token);

        Button authorize = new Button(this);
        authorize.setText("Authorize & Sync SMS");
        box.addView(authorize);

        Button whatsapp = new Button(this);
        whatsapp.setText("Enable WhatsApp Message Sync");
        box.addView(whatsapp);

        whatsappStatus = new TextView(this);
        box.addView(whatsappStatus);

        status = new TextView(this);
        status.setText("\nNot connected");
        box.addView(status);

        authorize.setOnClickListener(v -> authorize());
        whatsapp.setOnClickListener(v -> openNotificationSettings());
        setContentView(box);
        updateWhatsAppStatus();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (whatsappStatus != null) updateWhatsAppStatus();
    }

    private void authorize() {
        String t = token.getText().toString().trim();
        if (t.length() < 20) {
            status.setText("Enter the device token from DGM.");
            return;
        }
        getSharedPreferences("dgm_sms", MODE_PRIVATE).edit().putString("token", t).apply();
        if (android.os.Build.VERSION.SDK_INT >= 23 &&
                checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS}, SMS_REQ);
        } else {
            syncAll(t);
        }
    }

    @Override
    public void onRequestPermissionsResult(int r, String[] p, int[] g) {
        super.onRequestPermissionsResult(r, p, g);
        if (r == SMS_REQ && g.length > 0 && g[0] == PackageManager.PERMISSION_GRANTED) {
            syncAll(getSharedPreferences("dgm_sms", MODE_PRIVATE).getString("token", ""));
        } else if (r == SMS_REQ) {
            status.setText("SMS permission is required to sync this phone.");
        }
    }

    private void syncAll(String t) {
        status.setText("Authorizing and syncing sent + received SMS…");
        new Thread(() -> {
            int count = SmsSyncService.syncFolder(this, "inbox", t)
                    + SmsSyncService.syncFolder(this, "sent", t);
            startSmsWatcher();
            final int n = count;
            runOnUiThread(() -> status.setText("Connected. Synced " + n + " SMS messages."));
        }).start();
    }

    private void startSmsWatcher() {
        try {
            Intent i = new Intent(this, SmsSyncService.class);
            if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
        } catch (Exception ignored) {}
    }

    private void openNotificationSettings() {
        String t = token.getText().toString().trim();
        if (t.length() >= 20) {
            getSharedPreferences("dgm_sms", MODE_PRIVATE).edit().putString("token", t).apply();
        }
        try {
            startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
        } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        }
    }

    private void updateWhatsAppStatus() {
        boolean enabled = NotificationManagerCompat
                .getEnabledListenerPackages(this)
                .contains(getPackageName());
        whatsappStatus.setText(enabled
                ? "WhatsApp sync: ENABLED — notifications will sync in the background."
                : "WhatsApp sync: NOT ENABLED — open Android Notification Access and enable DGM.");
    }
}