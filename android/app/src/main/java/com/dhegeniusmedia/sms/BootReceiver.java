package com.dhegeniusmedia.sms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) &&
            !"android.intent.action.LOCKED_BOOT_COMPLETED".equals(action)) return;

        String token = context.getSharedPreferences("dgm_sms", Context.MODE_PRIVATE)
                .getString("token", "");
        if (token == null || token.trim().length() < 20) return;

        try {
            Intent service = new Intent(context, SmsSyncService.class);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service);
            else context.startService(service);
        } catch (Exception ignored) {}
    }
}