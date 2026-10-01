package com.dhegeniusmedia.sms;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.*;

public class MainActivity extends Activity {
    private static final int SMS_REQ=42; private EditText token; private TextView status,wa;

    public void onCreate(Bundle b){super.onCreate(b);buildUi();refresh();}
    protected void onResume(){super.onResume();if(wa!=null)refresh();}

    private void buildUi(){
        LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(28,36,28,28);
        TextView title=new TextView(this);title.setText("DHE GENIUS MEDIA\nAndroid Companion");title.setTextSize(26);box.addView(title);
        TextView intro=new TextView(this);intro.setText("\nDGM Companion • WhatsApp conversations + SMS synchronization\nSMS received + sent • WhatsApp notifications • automatic background sync\n");box.addView(intro);
        token=new EditText(this);token.setHint("DGM device token");token.setSingleLine(true);token.setText(SecureTokenStore.get(this));box.addView(token);
        Button auth=new Button(this);auth.setText("Authorize Device");box.addView(auth);
        Button whatsapp=new Button(this);whatsapp.setText("WhatsApp Notification Access");box.addView(whatsapp);
        wa=new TextView(this);box.addView(wa);status=new TextView(this);box.addView(status);
        TextView note=new TextView(this);note.setText("\nPrivacy: WhatsApp data is collected only from Android notification events. No WhatsApp folder or private database is accessed.\n\nSetup: tap WhatsApp Notification Access and enable DGM WhatsApp Notification Sync. The app checks Android's actual notification-listener permission, not just the settings screen.\n\nReliability: on Samsung/Android 11, allow DGM Companion notifications and exclude it from battery optimization so background synchronization can continue.");box.addView(note);
        auth.setOnClickListener(v->authorize());whatsapp.setOnClickListener(v->openNotificationSettings());
        setContentView(box);
    }

    private void authorize(){
        String t=token.getText().toString().trim();if(t.length()<20){status.setText("Enter a valid DGM device token.");return;}
        SecureTokenStore.put(this,t);SyncWorker.schedule(this);VoiceMediaSync.schedule(this);
        if(android.os.Build.VERSION.SDK_INT>=23&&checkSelfPermission(Manifest.permission.READ_SMS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.READ_SMS,Manifest.permission.RECEIVE_SMS},SMS_REQ);else startSyncService();
    }

    public void onRequestPermissionsResult(int r,String[] p,int[] g){super.onRequestPermissionsResult(r,p,g);if(r==SMS_REQ&&g.length>0&&g[0]==PackageManager.PERMISSION_GRANTED)startSyncService();else if(r==SMS_REQ)status.setText("SMS permission is required for SMS synchronization.");}

    private void startSyncService(){try{Intent i=new Intent(this,SmsSyncService.class);if(android.os.Build.VERSION.SDK_INT>=26)startForegroundService(i);else startService(i);}catch(Exception e){status.setText("Could not start sync service: "+e.getMessage());}SyncWorker.now(this);refresh();}

    private void openNotificationSettings(){
        try{
            if(android.os.Build.VERSION.SDK_INT>=30){
                Intent detail=new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
                detail.putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                        new ComponentName(this,WhatsAppNotificationService.class));
                startActivity(detail);
            }else{
                startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
            }
        }catch(Exception e){
            try{startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));}
            catch(Exception ignored){startActivity(new Intent(Settings.ACTION_SETTINGS));}
        }
    }

    private boolean isNotificationAccessEnabled(){
        try{
            if(android.os.Build.VERSION.SDK_INT>=27){
                NotificationManager nm=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
                if(nm!=null && nm.isNotificationListenerAccessGranted(
                        new ComponentName(this,WhatsAppNotificationService.class))) return true;
            }
        }catch(Exception ignored){}

        String pkg=getPackageName();
        try{
            String enabled=Settings.Secure.getString(getContentResolver(),"enabled_notification_listeners");
            if(enabled!=null){
                for(String component:enabled.split(":")){
                    if(component.equals(new ComponentName(this,WhatsAppNotificationService.class).flattenToString())) return true;
                }
            }
        }catch(Exception ignored){}
        return false;
    }

    private void refresh(){
        boolean enabled=isNotificationAccessEnabled();
        wa.setText(enabled?"\n🟢 WhatsApp notification access: ENABLED\n\nDGM is allowed to receive WhatsApp notifications."
                :"\n🟠 WhatsApp notification access: NOT ENABLED\n\nTap \"WhatsApp Notification Access\" and enable \"DGM WhatsApp Notification Sync\".");
        boolean connected=SecureTokenStore.get(this).length()>=20;
        status.setText((connected?"\n🟢 Device authorization: active":"\n🔴 Device authorization: missing")+
                "\nLast sync: "+(SyncStore.lastSync(this).isEmpty()?"Never":SyncStore.lastSync(this))+
                "\nSMS events: "+SyncStore.count(this,"sms")+"  |  WhatsApp events: "+SyncStore.count(this,"whatsapp")+
                "\n\nWhatsApp history: Existing DGM-synchronized messages load automatically on the website. New messages sync automatically after notification access is granted."+
                "\nPending: "+SyncStore.pendingCount(this)+
                (SyncStore.lastError(this).isEmpty()?"":"\nLast error: "+SyncStore.lastError(this)));
    }
}
