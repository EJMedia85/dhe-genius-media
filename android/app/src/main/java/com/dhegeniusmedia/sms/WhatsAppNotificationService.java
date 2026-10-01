package com.dhegeniusmedia.sms;

import android.app.Notification;
import android.os.Bundle;
import android.os.Build;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.text.TextUtils;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.List;

public class WhatsAppNotificationService extends NotificationListenerService {
    private static final String[] PACKAGES={"com.whatsapp","com.whatsapp.w4b"};

    @Override public void onListenerConnected(){
        super.onListenerConnected();
        try{
            StatusBarNotification[] active=getActiveNotifications();
            if(active!=null) for(StatusBarNotification item:active) processNotification(item);
        }catch(Exception ignored){}
    }

    @Override public void onNotificationPosted(StatusBarNotification sbn){
        processNotification(sbn);
    }

    private void processNotification(StatusBarNotification sbn){
        if(sbn==null||!isWhatsAppPackage(sbn.getPackageName())) return;
        Notification n=sbn.getNotification();
        if(n==null||n.extras==null) return;

        // WhatsApp commonly publishes MessagingStyle notifications. Prefer the
        // actual message objects because they can contain multiple messages in
        // one notification, rather than treating the notification as one chat.
        if(Build.VERSION.SDK_INT>=24){
            try{
                List<Notification.MessagingStyle.Message> messages =
                        Notification.MessagingStyle.Message.getMessagesFromBundleArray(
                                n.extras.getParcelableArray(Notification.EXTRA_MESSAGES));
                if(messages!=null && messages.length>0){
                    String conversationId=conversationId(sbn,n);
                    String conversationName=firstNonEmpty(
                            n.extras.getString(Notification.EXTRA_TITLE),
                            n.extras.getString(Notification.EXTRA_TITLE_BIG));
                    boolean storedAny=false;
                    for(Notification.MessagingStyle.Message m:messages){
                        if(m==null) continue;
                        String body=m.getText()==null?"":m.getText().toString();
                        if(TextUtils.isEmpty(body)) continue;

                        String sender=conversationName;
                        if(m.getSender()!=null && m.getSender().length()>0){
                            sender=m.getSender().toString();
                        }
                        long when=m.getTimestamp()>0?m.getTimestamp():sbn.getPostTime();
                        String receivedAt=formatTime(when);
                        String externalId=stableMessageId(sbn,conversationId,sender,body,when);

                        if(enqueueWhatsApp(externalId,conversationId,conversationName,sender,body,receivedAt)){
                            storedAny=true;
                        }
                    }
                    if(storedAny) SyncWorker.now(this);
                    return;
                }
            }catch(Exception ignored){}
        }

        // Fallback for older/non-MessagingStyle WhatsApp notifications.
        String title=firstNonEmpty(n.extras.getString(Notification.EXTRA_TITLE),n.extras.getString(Notification.EXTRA_TITLE_BIG));
        String body=extractBody(n.extras);
        if(TextUtils.isEmpty(body)) return;

        String conversationId=conversationId(sbn,n);
        String externalId=stableId(sbn,title,body);
        String receivedAt=formatTime(sbn.getPostTime());
        if(enqueueWhatsApp(externalId,conversationId,title,
                TextUtils.isEmpty(title)?"WhatsApp":title,body,receivedAt)){
            SyncWorker.now(this);
        }
    }

    private boolean enqueueWhatsApp(String externalId,String conversationId,String conversationName,
                                     String sender,String body,String receivedAt){
        try{
            org.json.JSONObject o=new org.json.JSONObject();
            o.put("external_id",externalId);
            o.put("direction","received");
            o.put("event_type","conversation_message");
            o.put("conversation_id",conversationId);
            o.put("conversation_name",TextUtils.isEmpty(conversationName)?"WhatsApp":conversationName);
            o.put("sender",TextUtils.isEmpty(sender)?"WhatsApp":sender);
            o.put("body",body);
            o.put("received_at",receivedAt);
            return SyncStore.enqueue(this,"whatsapp",externalId,o.toString(),
                    TextUtils.isEmpty(sender)?"WhatsApp":sender,body,receivedAt);
        }catch(Exception ignored){return false;}
    }

    private String conversationId(StatusBarNotification sbn,Notification n){
        if(Build.VERSION.SDK_INT>=29){
            try{
                String shortcut=n.getShortcutId();
                if(!TextUtils.isEmpty(shortcut)) return "wa-shortcut:"+shortcut;
            }catch(Exception ignored){}
        }
        String channel="";
        try{channel=n.getChannelId();}catch(Exception ignored){}
        if(!TextUtils.isEmpty(channel)) return "wa-channel:"+channel;
        return "wa-notification:"+sbn.getPackageName()+":"+sbn.getKey();
    }

    private String formatTime(long millis){
        return new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",Locale.US)
                .format(new Date(millis));
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

    private String stableMessageId(StatusBarNotification sbn,String conversationId,String sender,String body,long when){
        return hash("wa-msg|"+sbn.getPackageName()+"|"+conversationId+"|"+sender+"|"+body+"|"+when);
    }

    private String stableId(StatusBarNotification sbn,String title,String body){
        return hash("wa-event|"+sbn.getPackageName()+"|"+sbn.getKey()+"|"+sbn.getPostTime()+"|"+title+"|"+body);
    }

    private String hash(String raw){
        try{
            MessageDigest md=MessageDigest.getInstance("SHA-256");
            byte[] h=md.digest(raw.getBytes(StandardCharsets.UTF_8));
            StringBuilder b=new StringBuilder("wa-");
            for(byte v:h)b.append(String.format(Locale.US,"%02x",v));
            return b.toString();
        }catch(Exception e){return "wa-"+Math.abs(raw.hashCode());}
    }

    private String firstNonEmpty(String a,String b){return !TextUtils.isEmpty(a)?a:b;}
}
