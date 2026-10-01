package com.dhegeniusmedia.companion;

import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.app.Notification;
import android.os.Bundle;
import org.json.JSONObject;

public class WhatsAppNotificationListener extends NotificationListenerService {
    @Override public void onNotificationPosted(StatusBarNotification sbn){
        if(!"com.whatsapp".equals(sbn.getPackageName()))return;
        String title="",text="";
        Bundle e=sbn.getNotification().extras;
        if(e!=null){
            title=e.getString(Notification.EXTRA_TITLE,"");
            text=e.getString(Notification.EXTRA_TEXT,"");
            if(text==null||text.isEmpty())text=e.getString(Notification.EXTRA_BIG_TEXT,"");
        }
        if((text==null||text.trim().isEmpty())&&(title==null||title.trim().isEmpty()))return;
        try{
            JSONObject meta=new JSONObject();
            meta.put("package",sbn.getPackageName());
            meta.put("notification_key",sbn.getKey());
            meta.put("posted_at",sbn.getPostTime());
            String id="wa-"+sbn.getPostTime()+"-"+Math.abs(sbn.getKey().hashCode());
            DgmApi.sendMessage(this,"whatsapp",title,text,id,meta);
        }catch(Exception ignored){}
    }
}
