package com.dhegeniusmedia.sms;

import android.app.Activity;
import android.os.Bundle;
import android.widget.*;
import android.graphics.Color;

public class SyncCenterActivity extends Activity {
    private LinearLayout box; private TextView summary;
    public void onCreate(Bundle b){super.onCreate(b);build();refresh();}
    private void build(){
        ScrollView scroll=new ScrollView(this); box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(32,40,32,32);scroll.addView(box);
        TextView title=new TextView(this);title.setText("DGM Sync Center");title.setTextSize(28);box.addView(title);
        summary=new TextView(this);summary.setTextSize(17);box.addView(summary);
        Button sync=new Button(this);sync.setText("Sync Now");sync.setOnClickListener(v->{SyncWorker.now(this);refresh();});box.addView(sync);
        Button conv=new Button(this);conv.setText("View Conversations");conv.setOnClickListener(v->startActivity(new android.content.Intent(this,WhatsAppHistoryActivity.class)));box.addView(conv);
        Button settings=new Button(this);settings.setText("Device Settings");settings.setOnClickListener(v->startActivity(new android.content.Intent(this,MainActivity.class)));box.addView(settings);
        Button retry=new Button(this);retry.setText("Retry Pending");retry.setOnClickListener(v->{SyncWorker.now(this);refresh();});box.addView(retry);
        setContentView(scroll);
    }
    private void refresh(){
        String token=SecureTokenStore.get(this);
        boolean connected=token.length()>=20;
        summary.setText((connected?"\n🟢 Device Connected":"\n🔴 Device Not Authorized")+
                "\nLast sync: "+(SyncStore.lastSync(this).isEmpty()?"Never":SyncStore.lastSync(this))+
                "\nSMS synchronized: "+SyncStore.count(this,"sms")+
                "\nWhatsApp events synchronized: "+SyncStore.count(this,"whatsapp")+
                "\nPending: "+SyncStore.pendingCount(this)+
                "\nFailed/error: "+(SyncStore.lastError(this).isEmpty()?"0":SyncStore.lastError(this)));
    }
}
