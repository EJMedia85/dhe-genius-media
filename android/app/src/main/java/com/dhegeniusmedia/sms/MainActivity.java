package com.dhegeniusmedia.sms;

import android.Manifest;
import android.app.Activity;
import android.os.Bundle;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.widget.*;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final String BASE = "https://dhe-genius-media.onrender.com";
    private EditText token;
    private TextView status;
    private static final int SMS_REQ = 42;

    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(32,48,32,32);

        TextView title = new TextView(this);
        title.setText("DHE GENIUS MEDIA\nMy Devices SMS");
        title.setTextSize(26);
        box.addView(title);

        TextView info = new TextView(this);
        info.setText("\nAuthorize this phone to sync its SMS to your DGM account. Only use this on a phone you own or are authorized to manage.\n");
        box.addView(info);

        token = new EditText(this);
        token.setHint("Paste DGM device token");
        token.setSingleLine(true);
        box.addView(token);

        Button authorize = new Button(this);
        authorize.setText("Authorize & Sync");
        box.addView(authorize);

        status = new TextView(this);
        status.setText("\nNot connected");
        box.addView(status);

        authorize.setOnClickListener(v -> authorize());
        setContentView(box);
    }

    private void authorize() {
        String t = token.getText().toString().trim();
        if (t.length() < 20) { status.setText("Enter the device token from DGM."); return; }
        getPreferences(MODE_PRIVATE).edit().putString("token", t).apply();

        if (android.os.Build.VERSION.SDK_INT >= 23 &&
            checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS}, SMS_REQ);
        } else {
            syncInbox(t);
        }
    }

    @Override public void onRequestPermissionsResult(int r, String[] p, int[] g) {
        super.onRequestPermissionsResult(r,p,g);
        if (r == SMS_REQ && g.length > 0 && g[0] == PackageManager.PERMISSION_GRANTED) {
            syncInbox(getPreferences(MODE_PRIVATE).getString("token",""));
        } else {
            status.setText("SMS permission is required to sync this phone.");
        }
    }

    private void syncInbox(String t) {
        status.setText("Authorizing and syncing…");
        new Thread(() -> {
            try {
                Cursor c = getContentResolver().query(Uri.parse("content://sms/inbox"),
                    new String[]{"_id","address","body","date"}, null, null, "date DESC");
                int count = 0;
                if (c != null) {
                    while (c.moveToNext() && count < 500) {
                        String id=c.getString(0), sender=c.getString(1), body=c.getString(2);
                        long date=c.getLong(3);
                        JSONObject o=new JSONObject();
                        o.put("external_id", id);
                        o.put("direction","inbound");
                        o.put("sender", sender == null ? "" : sender);
                        o.put("body", body == null ? "" : body);
                        o.put("received_at", new java.util.Date(date).toInstant().toString());
                        if (post("/api/sms/ingest", t, o.toString())) count++;
                    }
                    c.close();
                }
                final int syncedCount = count;
                runOnUiThread(() -> status.setText("Connected. Synced " + syncedCount + " SMS messages."));
            } catch(Exception e) {
                runOnUiThread(() -> status.setText("Sync failed: " + e.getMessage()));
            }
        }).start();
    }

    public static boolean post(String path, String token, String json) {
        try {
            HttpURLConnection x=(HttpURLConnection)new URL(BASE+path).openConnection();
            x.setRequestMethod("POST");
            x.setRequestProperty("Authorization","Bearer "+token);
            x.setRequestProperty("Content-Type","application/json");
            x.setConnectTimeout(15000);
            x.setReadTimeout(15000);
            x.setDoOutput(true);
            try(OutputStream os=x.getOutputStream()){os.write(json.getBytes(StandardCharsets.UTF_8));}
            int code=x.getResponseCode();
            x.disconnect();
            return code >= 200 && code < 300;
        } catch(Exception e) { return false; }
    }
}
