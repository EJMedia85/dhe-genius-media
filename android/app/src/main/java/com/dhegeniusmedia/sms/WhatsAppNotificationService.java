package com.dhegeniusmedia.sms;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.text.TextUtils;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class WhatsAppNotificationService extends NotificationListenerService {
    private static final String[] PACKAGES={"com.whatsapp","com.whatsapp.w4b"};

    @Override public void onListenerConnected(){\n        super.onListenerConnected();\n        try{\n            StatusBarNotification[] active=getActiveNotifications();\n            if(active!=null) for(StatusBarNotification item:active) processNotification(item);\n        }catch(Exception ignored){}\n    }\n\n    @Override public void onNotificationPosted(StatusBarNotification sbn){\n        processNotification(sbn);\n    }\n\n    private void processNotification(StatusBarNotification sbn){
        if(sbn==null||!isWhatsAppPackage(sbn.getPackageName())) return;
        Notification n=sbn.getNotification();
        if(n==null||n.extras==null) return;

        String title=firstNonEmpty(n.extras.getString(Notification.EXTRA_TITLE),n.extras.getString(Notification.EXTRA_TITLE_BIG));
        String body=extractBody(n.extras);
        if(TextUtils.isEmpty(body)) return;

        String externalId=stableId(sbn,title,body);
        String receivedAt=new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",Locale.US)
                .format(new Date(sbn.getPostTime()));
        final String sender=TextUtils.isEmpty(title)?"WhatsApp":title;

        try{
            org.json.JSONObject o=new org.json.JSONObject();
            o.put("external_id",externalId);
            o.put("direction","received");
            o.put("event_type","notification_event");
            o.put("sender",sender);
            o.put("body",body);
            o.put("received_at",receivedAt);

            // Always persist locally first. SyncWorker delivers it when online.
            if(SyncStore.enqueue(this,"whatsapp",externalId,o.toString(),sender,body,receivedAt)){
                SyncWorker.now(this);
            }
        }catch(Exception ignored){}
    }

    private boolean isWhatsAppPackage(String p){for(String x:PACKAGES)if(x.equals(p))return true;return false;}

    private String extractBody(Bundle e){
        CharSequence big=e.getCharSequence(Notification.EXTRA_BIG_TEXT);
        if(big!=null&&big.length()>0)return big.toString();
        CharSequence text=e.getCharSequence(Notification.EXTRA_TEXT);
        if(text!=null&&text.length()>0)return text.toString();
        CharSequence[] lines=e.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
        if(lines!=null&&lines.length>0){
            StringBuilder out=new StringBuilder();
            for(CharSequence line:lines)if(line!=null&&line.length()>0){if(out.length()>0)out.append("\n");out.append(line);}
            return out.toString();
        }
        return "";
    }

    private String stableId(StatusBarNotification sbn,String title,String body){
        try{
            MessageDigest md=MessageDigest.getInstance("SHA-256");
            String raw=sbn.getPackageName()+"|"+sbn.getKey()+"|"+sbn.getPostTime()+"|"+title+"|"+body;
            byte[] h=md.digest(raw.getBytes(StandardCharsets.UTF_8));
            StringBuilder b=new StringBuilder("wa-");
            for(byte v:h)b.append(String.format(Locale.US,"%02x",v));
            return b.toString();
        }catch(Exception e){return "wa-"+sbn.getPostTime();}
    }

    private String firstNonEmpty(String a,String b){return !TextUtils.isEmpty(a)?a:b;}
}
