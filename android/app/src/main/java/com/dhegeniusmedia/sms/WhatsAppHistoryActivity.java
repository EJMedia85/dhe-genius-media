package com.dhegeniusmedia.sms;

import android.app.Activity;
import android.os.Bundle;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

public class WhatsAppHistoryActivity extends Activity {
    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(24, 32, 24, 24);

        TextView title = new TextView(this);
        title.setText("DGM WhatsApp Conversations");
        title.setTextSize(23);
        box.addView(title);

        String raw = getSharedPreferences("dgm_whatsapp", MODE_PRIVATE).getString("events", "[]");
        try {
            JSONArray items = new JSONArray(raw);
            if (items.length() == 0) {
                TextView empty = new TextView(this);
                empty.setText("\nNo WhatsApp notification events have been captured yet.");
                box.addView(empty);
            } else {
                for (int i = items.length() - 1; i >= 0; i--) {
                    JSONObject o = items.getJSONObject(i);
                    TextView row = new TextView(this);
                    row.setText("\n" + o.optString("sender", "WhatsApp")
                            + "\n" + o.optString("body", "")
                            + "\n" + o.optString("received_at", "") + "\n");
                    row.setTextSize(16);
                    box.addView(row);
                }
            }
        } catch (Exception e) {
            TextView error = new TextView(this);
            error.setText("\nUnable to read local conversation history.");
            box.addView(error);
        }

        setContentView(box);
    }
}