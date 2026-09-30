package com.dhegeniusmedia.sms;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.*;
import androidx.core.app.NotificationManagerCompat;

public class MainActivity extends Activity {
    private static final int SMS_REQ=42; private static final int VOICE_TREE_REQ=700; private EditText token; private TextView status,wa,mediaStatus;
    public void onCreate(Bundle b){super.onCreate(b);buildUi();refresh();}
    protected void onResume(){super.onResume();if(wa!=null)refresh();}
    private void buildUi(){
        LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(28,36,28,28);
        TextView title=new TextView(this);title.setText("DHE GENIUS MEDIA\nAndroid Companion");title.setTextSize(26);box.addView(title);
        TextView intro=new TextView(this);intro.setText("\nBuild #64 • WhatsApp conversations + authorized voice-note sync\nSMS received + sent • WhatsApp notifications • voice-note playback\n");box.addView(intro);
        token=new EditText(this);token.setHint("DGM device token");token.setSingleLine(true);token.setText(SecureTokenStore.get(this));box.addView(token);
        Button auth=new Button(this);auth.setText("Authorize Device");box.addView(auth);
        Button whatsapp=new Button(this);whatsapp.setText("WhatsApp Notification Access");box.addView(whatsapp);
        Button voiceFolder=new Button(this);voiceFolder.setText("Grant WhatsApp Voice Notes Folder");box.addView(voiceFolder);
        mediaStatus=new TextView(this);box.addView(mediaStatus);wa=new TextView(this);box.addView(wa);status=new TextView(this);box.addView(status);
        TextView note=new TextView(this);note.setText("\nPrivacy: WhatsApp data is collected only from Android notification events. DGM does not access WhatsApp private databases.\n\nReliability: on Samsung/Android 11, allow DGM Companion notifications and exclude it from battery optimization so background synchronization can continue.");box.addView(note);
        auth.setOnClickListener(v->authorize());whatsapp.setOnClickListener(v->openNotificationSettings());voiceFolder.setOnClickListener(v->openVoiceFolderPicker());
        setContentView(box);
    }
    private void authorize(){
        String t=token.getText().toString().trim();if(t.length()<20){status.setText("Enter a valid DGM device token.");return;}
        SecureTokenStore.put(this,t);SyncWorker.schedule(this);VoiceMediaSync.schedule(this);
        if(android.os.Build.VERSION.SDK_INT>=23&&checkSelfPermission(Manifest.permission.READ_SMS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.READ_SMS,Manifest.permission.RECEIVE_SMS},SMS_REQ);else startSyncService();
    }
    public void onRequestPermissionsResult(int r,String[] p,int[] g){super.onRequestPermissionsResult(r,p,g);if(r==SMS_REQ&&g.length>0&&g[0]==PackageManager.PERMISSION_GRANTED)startSyncService();else if(r==SMS_REQ)status.setText("SMS permission is required for SMS synchronization.");}
    private void startSyncService(){try{Intent i=new Intent(this,SmsSyncService.class);if(android.os.Build.VERSION.SDK_INT>=26)startForegroundService(i);else startService(i);}catch(Exception e){status.setText("Could not start sync service: "+e.getMessage());}SyncWorker.now(this);refresh();}
    private void openNotificationSettings(){try{startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));}catch(Exception e){startActivity(new Intent(Settings.ACTION_SETTINGS));}}
    private void openVoiceFolderPicker(){
        try{
            Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(i,VOICE_TREE_REQ);
        }catch(Exception e){status.setText("Could not open folder picker: "+e.getMessage());}
    }
    @Override protected void onActivityResult(int requestCode,int resultCode,Intent data){
        super.onActivityResult(requestCode,resultCode,data);
        if(requestCode==VOICE_TREE_REQ&&resultCode==RESULT_OK&&data!=null&&data.getData()!=null){
            Uri uri=data.getData();
            try{getContentResolver().takePersistableUriPermission(uri,data.getFlags()&(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION));}catch(Exception ignored){}
            VoiceMediaSync.setTree(this,uri);VoiceMediaSync.schedule(this);VoiceMediaSync.now(this);refresh();
        }
    }
    private void refresh(){
        boolean enabled=NotificationManagerCompat.getEnabledListenerPackages(this).contains(getPackageName());
        wa.setText(enabled?"\n🟢 WhatsApp notification sync: ENABLED":"\n🟠 WhatsApp notification sync: NOT ENABLED");
        boolean connected=SecureTokenStore.get(this).length()>=20;
        String tree=VoiceMediaSync.tree(this);
        mediaStatus.setText(tree.isEmpty()?"\n🟠 WhatsApp voice-note folder: not granted":"\n🟢 WhatsApp voice-note folder: granted");
        status.setText((connected?"\n🟢 Device authorization: active":"\n🔴 Device authorization: missing")+
                "\nLast sync: "+(SyncStore.lastSync(this).isEmpty()?"Never":SyncStore.lastSync(this))+
                "\nSMS events: "+SyncStore.count(this,"sms")+"  |  WhatsApp events: "+SyncStore.count(this,"whatsapp")+
                "\nPending: "+SyncStore.pendingCount(this)+
                (SyncStore.lastError(this).isEmpty()?"":"\nLast error: "+SyncStore.lastError(this)));
    }
}
