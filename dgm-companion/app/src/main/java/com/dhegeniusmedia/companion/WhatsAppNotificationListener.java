package com.dhegeniusmedia.companion;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import org.json.JSONArray;
import org.json.JSONObject;

public class WhatsAppNotificationListener extends NotificationListenerService {
    @Override public void onNotificationPosted(StatusBarNotification sbn){
        if(!"com.whatsapp".equals(sbn.getPackageName()))return;

        String title="",text="";
        Bundle e=sbn.getNotification().extras;
        if(e!=null){
            title=e.getString(Notification.EXTRA_TITLE,"");
            text=e.getString(Notification.EXTRA_TEXT,"");
            if((text==null||text.isEmpty()))text=e.getString(Notification.EXTRA_BIG_TEXT,"");

            CharSequence[] lines=e.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            if((text==null||text.trim().isEmpty()) && lines!=null && lines.length>0){
                StringBuilder b=new StringBuilder();
                for(CharSequence line:lines){
                    if(line==null)continue;
                    if(b.length()>0)b.append("\n");
                    b.append(line);
                }
                text=b.toString();
            }
        }

        if((text==null||text.trim().isEmpty())&&(title==null||title.trim().isEmpty()))return;

        try{
            JSONObject meta=new JSONObject();
            meta.put("package",sbn.getPackageName());
            meta.put("notification_key",sbn.getKey());
            meta.put("posted_at",sbn.getPostTime());
            meta.put("source","android_notification_listener");

            String id="wa-"+sbn.getPostTime()+"-"+Math.abs(sbn.getKey().hashCode());
            DgmApi.sendMessage(this,"whatsapp",title==null?"":title,text==null?"":text,id,meta);
        }catch(Exception ignored){}
    }
}
