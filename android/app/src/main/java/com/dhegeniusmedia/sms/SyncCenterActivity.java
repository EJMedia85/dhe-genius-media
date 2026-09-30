package com.dhegeniusmedia.sms;

import android.app.Activity;
import android.os.Bundle;
import android.widget.*;
import org.json.JSONObject;

public class SyncCenterActivity extends Activity {
    private LinearLayout box; private TextView summary,server;

    public void onCreate(Bundle b){super.onCreate(b);build();refresh();refreshServer();}

    private void build(){
        ScrollView scroll=new ScrollView(this);
        box=new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(28,34,28,28); scroll.addView(box);

        TextView title=new TextView(this); title.setText("DGM Sync Center"); title.setTextSize(28); box.addView(title);
        summary=new TextView(this); summary.setTextSize(17); box.addView(summary);
        server=new TextView(this); server.setTextSize(15); box.addView(server);

        Button sync=new Button(this); sync.setText("Sync Now"); sync.setOnClickListener(v->{SyncWorker.now(this);refresh();}); box.addView(sync);
        Button conv=new Button(this); conv.setText("View Conversations"); conv.setOnClickListener(v->startActivity(new android.content.Intent(this,ConversationsActivity.class))); box.addView(conv);
        Button settings=new Button(this); settings.setText("Device Settings"); settings.setOnClickListener(v->startActivity(new android.content.Intent(this,MainActivity.class))); box.addView(settings);
        Button retry=new Button(this); retry.setText("Retry Pending"); retry.setOnClickListener(v->{SyncWorker.now(this);VoiceMediaSync.now(this);refresh();}); box.addView(retry);
        Button voice=new Button(this); voice.setText("Sync WhatsApp Voice Notes"); voice.setOnClickListener(v->{VoiceMediaSync.now(this);refresh();}); box.addView(voice);
        setContentView(scroll);
    }

    private void refresh(){
        String token=SecureTokenStore.get(this);
        boolean connected=token.length()>=20;
        summary.setText((connected?"\n🟢 Device Connected":"\n🔴 Device Not Authorized")+
                "\nLast sync: "+(SyncStore.lastSync(this).isEmpty()?"Never":SyncStore.lastSync(this))+
                "\nSMS captured: "+SyncStore.count(this,"sms")+
                "\nSMS synchronized: "+SyncStore.syncedCount(this,"sms")+
                "\nWhatsApp events captured: "+SyncStore.count(this,"whatsapp")+
                "\nWhatsApp synchronized: "+SyncStore.syncedCount(this,"whatsapp")+
                "\nVoice-note folder: "+(VoiceMediaSync.tree(this).isEmpty()?"Not granted":"Granted")+
                "\nPending: "+SyncStore.pendingCount(this)+
                "\nFailed: "+SyncStore.failedCount(this)+
                (SyncStore.lastError(this).isEmpty()?"":"\nError: "+SyncStore.lastError(this)));
        server.setText("\nServer: "+SyncStore.serverStatus(this));
    }

    private void refreshServer(){
        final String token=SecureTokenStore.get(this);
        if(token.length()<20)return;
        new Thread(()->{
            MainActivityPost.Result r=MainActivityPost.getDetailed("/api/sms/status",token);
            runOnUiThread(()->{
                if(r.isSuccess()){
                    try{
                        JSONObject j=new JSONObject(r.body);
                        JSONObject counts=j.optJSONObject("counts");
                        server.setText("\n🟢 Server Connected"+
                                "\nServer SMS: "+(counts==null?0:counts.optInt("sms"))+
                                "\nServer WhatsApp events: "+(counts==null?0:counts.optInt("whatsapp"))+
                                "\nLast server contact: "+j.optString("server_time",""));
                    }catch(Exception e){server.setText("\n🟢 Server Connected");}
                }else if(r.isUnauthorized()){
                    server.setText("\n🔴 Server rejected device token.");
                }else{
                    server.setText("\n🟠 Server unavailable: "+r.body);
                }
            });
        }).start();
    }

    @Override protected void onResume(){super.onResume();if(summary!=null){refresh();refreshServer();}}
}
