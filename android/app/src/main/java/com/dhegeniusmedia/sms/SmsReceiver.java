package com.dhegeniusmedia.sms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.telephony.SmsMessage;
import org.json.JSONObject;

public class SmsReceiver extends BroadcastReceiver {
    public void onReceive(Context c,Intent intent){
        if(!"android.provider.Telephony.SMS_RECEIVED".equals(intent.getAction()))return;
        Bundle e=intent.getExtras();if(e==null)return;Object[] pdus=(Object[])e.get("pdus");if(pdus==null)return;
        String sender="";StringBuilder body=new StringBuilder();long ts=System.currentTimeMillis();
        for(Object p:pdus){SmsMessage m=SmsMessage.createFromPdu((byte[])p);if(m!=null){sender=m.getOriginatingAddress();body.append(m.getMessageBody());ts=m.getTimestampMillis();}}
        try{
            String id="rx-"+ts+"-"+sender+"-"+Integer.toHexString(body.toString().hashCode());
            JSONObject o=new JSONObject();o.put("external_id",id);o.put("direction","inbound");o.put("sender",sender==null?"":sender);o.put("body",body.toString());o.put("received_at",new java.util.Date(ts).toInstant().toString());
            if(SecureTokenStore.get(c).length()>=20){
                SyncStore.enqueue(c,"sms",id,o.toString(),sender,body.toString(),o.optString("received_at"));
                SyncWorker.now(c);
            }
        }catch(Exception ignored){}
    }
}
