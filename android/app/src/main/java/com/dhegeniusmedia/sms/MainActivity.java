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
    private static final int SMS_REQ = 42;
    private EditText token;
    private TextView status;
    private TextView whatsappStatus;

    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        buildUi();
        updateStatus();
    }

    @Override protected void onResume() {
        super.onResume();
        if (whatsappStatus != null) updateStatus();
    }

    private void buildUi() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(32, 40, 32, 32);

        TextView title = new TextView(this);
        title.setText("DHE GENIUS MEDIA\nAndroid Companion");
        title.setTextSize(25);
        box.addView(title);

        TextView info = new TextView(this);
        info.setText("\nAuthorized-device synchronization\n\nSMS: received + sent\nWhatsApp: notification events + conversation grouping\nBackground sync: enabled while Android permits the service to run\n");
        box.addView(info);

        token = new EditText(this);
        token.setHint("DGM device token");
        token.setSingleLine(true);
        token.setText(getSharedPreferences("dgm_sms", MODE_PRIVATE).getString("token", ""));
        box.addView(token);

        Button authorize = new Button(this);
        authorize.setText("Authorize Device & Sync");
        box.addView(authorize);

        Button whatsapp = new Button(this);
        whatsapp.setText("Open WhatsApp Notification Access");
        box.addView(whatsapp);

        Button sync = new Button(this);
        sync.setText("Sync SMS Now");
        box.addView(sync);

        whatsappStatus = new TextView(this);
        box.addView(whatsappStatus);

        status = new TextView(this);
        status.setText("\nDevice not connected");
        box.addView(status);

        TextView note = new TextView(this);
        note.setText("\nPrivacy note: DGM uses only permissions granted on this device. WhatsApp private chat databases are not accessed.");
        box.addView(note);

        authorize.setOnClickListener(v -> authorize());
        sync.setOnClickListener(v -> {
            String t = getSharedPreferences("dgm_sms", MODE_PRIVATE).getString("token", "");
            if (t.length() >= 20) syncAll(t); else status.setText("Authorize the device first.");
        });
        whatsapp.setOnClickListener(v -> openNotificationSettings());
        setContentView(box);
    }

    private void authorize() {
        String t = token.getText().toString().trim();
        if (t.length() < 20) {
            status.setText("Enter the DGM device token.");
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

    @Override public void onRequestPermissionsResult(int r, String[] p, int[] g) {
        super.onRequestPermissionsResult(r, p, g);
        if (r == SMS_REQ && g.length > 0 && g[0] == PackageManager.PERMISSION_GRANTED) {
            syncAll(getSharedPreferences("dgm_sms", MODE_PRIVATE).getString("token", ""));
        } else if (r == SMS_REQ) {
            status.setText("SMS permission is required for SMS synchronization.");
        }
    }

    private void syncAll(String t) {
        status.setText("Syncing received + sent SMS and starting background sync…");
        new Thread(() -> {
            int count = SmsSyncService.syncFolder(this, "inbox", t)
                    + SmsSyncService.syncFolder(this, "sent", t);
            startSmsWatcher();
            final int n = count;
            runOnUiThread(() -> status.setText("Connected. Synced " + n + " SMS messages. Background sync is active."));
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
        if (t.length() >= 20)
            getSharedPreferences("dgm_sms", MODE_PRIVATE).edit().putString("token", t).apply();
        try {
            startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
        } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        }
    }

    private void updateStatus() {
        boolean enabled = NotificationManagerCompat.getEnabledListenerPackages(this).contains(getPackageName());
        whatsappStatus.setText(enabled
                ? "WhatsApp notification sync: ENABLED"
                : "WhatsApp notification sync: NOT ENABLED");
        if (status != null && enabled) status.setText("\nDevice authorization is stored locally. Background sync can run when Android allows it.");
    }
}