package com.dhegeniusmedia.companion;

import android.Manifest;
import android.app.Activity;
import android.os.Bundle;
import android.provider.Settings;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.app.NotificationManager;
import android.view.*;
import android.widget.*;
import org.json.JSONObject;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private EditText tokenInput,deviceName;
    private TextView status;
    private final java.util.concurrent.ExecutorService executor=Executors.newSingleThreadExecutor();

    @Override public void onCreate(Bundle b){
        super.onCreate(b);
        LinearLayout root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(36,36,36,36);
        root.setBackgroundColor(Color.rgb(7,19,13));
        TextView title=new TextView(this); title.setText("DHE GENIUS MEDIA\nCOMPANION"); title.setTextColor(Color.rgb(37,211,102)); title.setTextSize(24); title.setGravity(Gravity.CENTER); root.addView(title,new LinearLayout.LayoutParams(-1,110));
        TextView help=new TextView(this); help.setText("Enroll this phone using the one-time token generated in your DGM Admin Dashboard."); help.setTextColor(Color.WHITE); help.setTextSize(15); help.setPadding(0,0,0,24); root.addView(help);
        deviceName=new EditText(this); deviceName.setHint("Device name"); deviceName.setText("My Android"); deviceName.setTextColor(Color.WHITE); deviceName.setHintTextColor(Color.GRAY); root.addView(deviceName,new LinearLayout.LayoutParams(-1,60));
        tokenInput=new EditText(this); tokenInput.setHint("Enrollment token"); tokenInput.setTextColor(Color.WHITE); tokenInput.setHintTextColor(Color.GRAY); tokenInput.setSingleLine(true); tokenInput.setInputType(2|0x80000); root.addView(tokenInput,new LinearLayout.LayoutParams(-1,60));

        Button enroll=new Button(this); enroll.setText("ENROLL DEVICE"); root.addView(enroll,new LinearLayout.LayoutParams(-1,60));
        Button sms=new Button(this); sms.setText("GRANT SMS ACCESS"); root.addView(sms,new LinearLayout.LayoutParams(-1,60));
        Button calls=new Button(this); calls.setText("GRANT CALL LOG + CONTACT ACCESS"); root.addView(calls,new LinearLayout.LayoutParams(-1,60));
        Button wa=new Button(this); wa.setText("ENABLE WHATSAPP NOTIFICATION ACCESS"); root.addView(wa,new LinearLayout.LayoutParams(-1,60));

        status=new TextView(this); status.setTextColor(Color.LTGRAY); status.setPadding(0,24,0,0); root.addView(status);
        setContentView(root);

        String saved=TokenStore.get(this);
        if(saved!=null)status.setText("Device enrolled. Grant the requested permissions, then leave Companion installed.");
        enroll.setOnClickListener(v->enroll());
        sms.setOnClickListener(v->requestSms());
        calls.setOnClickListener(v->requestCallAccess());
        wa.setOnClickListener(v->openNotificationAccess());
    }

    private void enroll(){
        String t=tokenInput.getText().toString().trim();
        if(t.isEmpty()){status.setText("Enter the enrollment token first.");return;}
        status.setText("Enrolling…");
        executor.execute(()->{
            try{
                JSONObject p=new JSONObject();
                p.put("enrollment_token",t);
                p.put("device_name",deviceName.getText().toString().trim());
                p.put("platform","Android");
                p.put("app_version","1.2.0");
                JSONObject r=DgmApi.post(this,"/api/companion/enroll",p,null);
                if(r.optBoolean("pending_approval",false)){
                    runOnUiThread(()->status.setText("REGISTRATION RECEIVED ✓\nAwaiting DGM Admin authorization…"));
                    waitForApproval(t);
                    return;
                }
                String serverToken=r.optString("token","");
                if(serverToken.isEmpty())throw new Exception("Server did not return a device token.");
                TokenStore.save(this,serverToken);
                runOnUiThread(()->{
                    status.setText("ENROLLED ✓\nDevice authorized. Grant SMS, call-log/contact and WhatsApp access.");
                    tokenInput.setText("");
                    requestSms();
                });
            }catch(Exception e){runOnUiThread(()->status.setText("Enrollment failed: "+e.getMessage()));}
        });
    }

    private void waitForApproval(String enrollmentToken){
        executor.execute(()->{
            for(int i=0;i<90;i++){
                try{
                    Thread.sleep(10000);
                    JSONObject p=new JSONObject();
                    p.put("enrollment_token",enrollmentToken);
                    JSONObject r=DgmApi.post(this,"/api/companion/enroll/status",p,null);
                    if(r.optBoolean("authorized",false)){
                        String serverToken=r.optString("token","");
                        if(serverToken.isEmpty())throw new Exception("Authorization token missing.");
                        TokenStore.save(this,serverToken);
                        runOnUiThread(()->{
                            status.setText("AUTHORIZED ✓\nDGM Admin approved this device.");
                            tokenInput.setText("");
                            requestSms();
                        });
                        return;
                    }
                    runOnUiThread(()->status.setText("REGISTRATION RECEIVED ✓\nAwaiting DGM Admin authorization…"));
                }catch(Exception e){
                    if(i>=89){
                        runOnUiThread(()->status.setText("Authorization check stopped: "+e.getMessage()));
                    }
                }
            }
        });
    }

    private void requestSms(){
        if(android.os.Build.VERSION.SDK_INT>=23){
            requestPermissions(new String[]{Manifest.permission.RECEIVE_SMS,Manifest.permission.READ_SMS},40);
        }else{
            syncAndShowStatus();
        }
    }

    private void requestCallAccess(){
        if(android.os.Build.VERSION.SDK_INT>=23){
            requestPermissions(new String[]{
                Manifest.permission.READ_CALL_LOG,
                Manifest.permission.READ_CONTACTS
            },50);
        }else{
            syncAndShowStatus();
        }
    }

    private void openNotificationAccess(){
        try{
            startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
        }catch(Exception e){
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        }
    }

    private boolean smsGranted(){
        return android.os.Build.VERSION.SDK_INT<23 ||
            (checkSelfPermission(Manifest.permission.READ_SMS)==PackageManager.PERMISSION_GRANTED &&
             checkSelfPermission(Manifest.permission.RECEIVE_SMS)==PackageManager.PERMISSION_GRANTED);
    }

    private boolean callLogGranted(){
        return android.os.Build.VERSION.SDK_INT<23 ||
            checkSelfPermission(Manifest.permission.READ_CALL_LOG)==PackageManager.PERMISSION_GRANTED;
    }

    private boolean contactsGranted(){
        return android.os.Build.VERSION.SDK_INT<23 ||
            checkSelfPermission(Manifest.permission.READ_CONTACTS)==PackageManager.PERMISSION_GRANTED;
    }

    private boolean whatsappAccessGranted(){
        if(android.os.Build.VERSION.SDK_INT<18)return false;
        NotificationManager nm=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        return nm!=null && nm.isNotificationListenerAccessGranted(
            new ComponentName(this,WhatsAppNotificationListener.class));
    }

    private void syncAndShowStatus(){
        executor.execute(()->{
            if(smsGranted()) SmsSync.syncRecent(this);
            if(callLogGranted()) CallLogSync.syncRecent(this);
            boolean connected=DgmApi.heartbeat(this);
            runOnUiThread(()->status.setText(
                (connected?"CONNECTED ✓":"ENROLLED ✓")+
                "\nSMS access: "+(smsGranted()?"ON":"OFF")+
                "\nCall logs: "+(callLogGranted()?"ON":"OFF")+
                "\nContact names: "+(contactsGranted()?"ON":"OFF")+
                "\nWhatsApp notification access: "+(whatsappAccessGranted()?"ON":"OFF")+
                (connected?"\nDGM server: reachable":"\nDGM server: unavailable")));
        });
    }

    @Override public void onRequestPermissionsResult(int requestCode,String[] permissions,int[] grantResults){
        super.onRequestPermissionsResult(requestCode,permissions,grantResults);
        if(requestCode==40 || requestCode==50) syncAndShowStatus();
    }

    @Override protected void onResume(){
        super.onResume();
        if(TokenStore.get(this)!=null) syncAndShowStatus();
    }

    @Override protected void onDestroy(){executor.shutdownNow();super.onDestroy();}
}
