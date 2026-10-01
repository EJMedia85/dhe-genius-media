package com.dhegeniusmedia.companion;

import android.Manifest;
import android.app.Activity;
import android.os.Bundle;
import android.provider.Settings;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.graphics.Color;
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
        Button wa=new Button(this); wa.setText("ENABLE WHATSAPP NOTIFICATION ACCESS"); root.addView(wa,new LinearLayout.LayoutParams(-1,60));
        status=new TextView(this); status.setTextColor(Color.LTGRAY); status.setPadding(0,24,0,0); root.addView(status);
        setContentView(root);
        String saved=TokenStore.get(this);
        if(saved!=null){status.setText("Device enrolled. Grant the requested permissions, then leave Companion installed.");}
        enroll.setOnClickListener(v->enroll());
        sms.setOnClickListener(v->requestSms());
        wa.setOnClickListener(v->{try{startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"));}catch(Exception e){startActivity(new Intent(Settings.ACTION_SETTINGS));}});
    }

    private void enroll(){
        String t=tokenInput.getText().toString().trim();
        if(t.isEmpty()){status.setText("Enter the enrollment token first.");return;}
        status.setText("Enrolling…");
        executor.execute(()->{
            try{
                JSONObject p=new JSONObject(); p.put("enrollment_token",t); p.put("device_name",deviceName.getText().toString().trim()); p.put("platform","Android"); p.put("app_version","1.0");
                JSONObject r=DgmApi.post(this,"/api/companion/enroll",p,null);
                String serverToken=r.optString("token","");
                if(serverToken.isEmpty())throw new Exception("Server did not return a device token.");
                TokenStore.save(this,serverToken);
                runOnUiThread(()->{status.setText("ENROLLED ✓\nDevice is now authorized. Grant SMS and WhatsApp notification access."); tokenInput.setText(""); requestSms();});
            }catch(Exception e){runOnUiThread(()->status.setText("Enrollment failed: "+e.getMessage()));}
        });
    }

    private void requestSms(){
        if(android.os.Build.VERSION.SDK_INT>=23){
            requestPermissions(new String[]{Manifest.permission.RECEIVE_SMS,Manifest.permission.READ_SMS},40);
        }
    }

    @Override protected void onResume(){
        super.onResume();
        if(TokenStore.get(this)!=null){
            executor.execute(()->{
                boolean ok=DgmApi.heartbeat(this);
                runOnUiThread(()->status.setText(ok?"CONNECTED ✓\nDGM server is reachable.":"ENROLLED ✓\nWaiting for DGM server connection."));
            });
        }
    }

    @Override protected void onDestroy(){executor.shutdownNow();super.onDestroy();}
}
