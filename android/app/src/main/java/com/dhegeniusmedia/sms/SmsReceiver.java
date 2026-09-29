package com.dhegeniusmedia.sms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.telephony.SmsMessage;
import org.json.JSONObject;

public class SmsReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!"android.provider.Telephony.SMS_RECEIVED".equals(intent.getAction())) return;
        String token = context.getSharedPreferences("dgm", Context.MODE_PRIVATE).getString("token", "");
        if (token.isEmpty()) {
            token = context.getSharedPreferences("dgm_sms", Context.MODE_PRIVATE).getString("token", "");
        }
        if (token.isEmpty()) {
            // MainActivity stores its preference in the activity preference file.
            token = context.getSharedPreferences("com.dhegeniusmedia.sms_preferences", Context.MODE_PRIVATE).getString("token", "");
        }
        if (token.isEmpty()) return;

        Bundle extras=intent.getExtras();
        if (extras == null) return;
        Object[] pdus=(Object[])extras.get("pdus");
        if (pdus == null) return;

        String sender="";
        StringBuilder body=new StringBuilder();
        long timestamp=System.currentTimeMillis();
        for (Object pdu: pdus) {
            SmsMessage m=SmsMessage.createFromPdu((byte[])pdu);
            if (m == null) continue;
            sender=m.getOriginatingAddress();
            body.append(m.getMessageBody());
            timestamp=m.getTimestampMillis();
        }

        try {
            JSONObject o=new JSONObject();
            o.put("external_id", "rx-" + timestamp + "-" + sender);
            o.put("direction","inbound");
            o.put("sender", sender == null ? "" : sender);
            o.put("body", body.toString());
            o.put("received_at", new java.util.Date(timestamp).toInstant().toString());
            final String finalToken=token;
            final String payload=o.toString();
            new Thread(() -> MainActivity.post("/api/sms/ingest", finalToken, payload)).start();
        } catch(Exception ignored) {}
    }
}
