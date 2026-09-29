package com.dhegeniusmedia.sms;

import android.Manifest;
import android.app.Activity;
import android.os.Bundle;
import android.content.pm.PackageManager;

public class MainActivity extends Activity {
    private EditText token; private TextView status; private static final int SMS_REQ=42;
    @Override public void onCreate(Bundle b){super.onCreate(b);LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(32,48,32,32);
        TextView title=new TextView(this);title.setText("DHE GENIUS MEDIA\nMy Devices SMS");title.setTextSize(26);box.addView(title);
        TextView info=new TextView(this);info.setText("\nAuthorize this phone to sync its SMS to your DGM account. Only use this on a phone you own or are authorized to manage.\n");box.addView(info);
        token=new EditText(this);token.setHint("Paste DGM device token");token.setSingleLine(true);box.addView(token);
        Button authorize=new Button(this);authorize.setText("Authorize & Sync");box.addView(authorize);
        status=new TextView(this);status.setText("\nNot connected");box.addView(status);authorize.setOnClickListener(v->authorize());setContentView(box);}
    private void authorize(){String t=token.getText().toString().trim();if(t.length()<20){status.setText("Enter the device token from DGM.");return;}getSharedPreferences("dgm_sms",MODE_PRIVATE).edit().putString("token",t).apply();if(android.os.Build.VERSION.SDK_INT>=23&&checkSelfPermission(Manifest.permission.READ_SMS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.READ_SMS,Manifest.permission.RECEIVE_SMS},SMS_REQ);else syncAll(t);}
    @Override public void onRequestPermissionsResult(int r,String[] p,int[] g){super.onRequestPermissionsResult(r,p,g);if(r==SMS_REQ&&g.length>0&&g[0]==PackageManager.PERMISSION_GRANTED)syncAll(getSharedPreferences("dgm_sms",MODE_PRIVATE).getString("token",""));else status.setText("SMS permission is required to sync this phone.");}
    private void syncAll(String t){status.setText("Authorizing and syncing sent + received SMS…");new Thread(()->{int count=SmsSyncService.syncFolder(this,"inbox",t)+SmsSyncService.syncFolder(this,"sent",t);startSmsWatcher();final int n=count;runOnUiThread(()->status.setText("Connected. Synced "+n+" SMS messages."));}).start();}
    private void startSmsWatcher(){try{Intent i=new Intent(this,SmsSyncService.class);if(android.os.Build.VERSION.SDK_INT>=26)startForegroundService(i);else startService(i);}catch(Exception ignored){}}
}