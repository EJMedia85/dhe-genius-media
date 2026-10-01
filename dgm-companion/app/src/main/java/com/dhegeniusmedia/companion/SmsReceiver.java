package com.dhegeniusmedia.companion;

import android.content.*;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import org.json.JSONObject;
import java.util.concurrent.Executors;

public class SmsReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context,Intent intent){
        if(!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction()))return;
        final PendingResult pending=goAsync();
        Executors.newSingleThreadExecutor().execute(()->{
            try{
                SmsMessage[] msgs=Telephony.Sms.Intents.getMessagesFromIntent(intent);
                if(msgs!=null){
                    for(SmsMessage m:msgs){
                        String body=m.getMessageBody(); String sender=m.getOriginatingAddress();
                        String id="sms-"+m.getTimestampMillis()+"-"+Math.abs((sender+"|"+body).hashCode());
                        DgmApi.sendMessage(context,"sms",sender,body,id,null);
                    }
                }
            }finally{pending.finish();}
        });
    }
}
