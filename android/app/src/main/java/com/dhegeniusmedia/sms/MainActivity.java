package com.dhegeniusmedia.sms;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.OpenableColumns;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.*;
import androidx.core.app.NotificationManagerCompat;

public class MainActivity extends Activity {
    private static final int SMS_REQ=42; private static final int VOICE_TREE_REQ=700; private static final int WA_IMPORT_REQ=701; private EditText token; private TextView status,wa,mediaStatus;
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
        Button oldChats=new Button(this);oldChats.setText("Import Old WhatsApp Chat Export");box.addView(oldChats);
        mediaStatus=new TextView(this);box.addView(mediaStatus);wa=new TextView(this);box.addView(wa);status=new TextView(this);box.addView(status);
        TextView note=new TextView(this);note.setText("\nPrivacy: WhatsApp data is collected only from Android notification events. DGM does not access WhatsApp private databases.\n\nReliability: on Samsung/Android 11, allow DGM Companion notifications and exclude it from battery optimization so background synchronization can continue.");box.addView(note);
        auth.setOnClickListener(v->authorize());whatsapp.setOnClickListener(v->openNotificationSettings());voiceFolder.setOnClickListener(v->openVoiceFolderPicker());oldChats.setOnClickListener(v->openChatImport());
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
    private void openChatImport(){
        try{
            Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.setType("text/plain");
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,false);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(i,WA_IMPORT_REQ);
        }catch(Exception e){status.setText("Could not open chat export picker: "+e.getMessage());}
    }
    private void importChat(Uri uri){
        String tokenValue=SecureTokenStore.get(this);
        if(tokenValue.length()<20){status.setText("Authorize this device before importing a chat.");return;}
        try(InputStream in=getContentResolver().openInputStream(uri);
            BufferedReader br=new BufferedReader(new InputStreamReader(in,StandardCharsets.UTF_8))){
            List<JSONObject> batch=new ArrayList<>();
            String line; String currentDate=null; String currentSender=null; StringBuilder currentBody=new StringBuilder(); int total=0;
            while((line=br.readLine())!=null){
                java.util.regex.Matcher m=java.util.regex.Pattern.compile("^(\\d{1,2}[\\/\\.-]\\d{1,2}[\\/\\.-]\\d{2,4}),?\\s+(\\d{1,2}:\\d{2})(?:\\s*[AP]M)?\\s+-\\s+([^:]+):\\s?(.*)$",java.util.regex.Pattern.CASE_INSENSITIVE).matcher(line);
                if(m.find()){
                    if(currentSender!=null) total+=addImported(batch,currentDate,currentSender,currentBody.toString());
                    currentDate=m.group(1)+" "+m.group(2); currentSender=m.group(3).trim(); currentBody.setLength(0); currentBody.append(m.group(4));
                    if(batch.size()>=1000){uploadImport(batch,tokenValue);batch.clear();}
                }else if(currentSender!=null){
                    currentBody.append("\n").append(line);
                }
            }
            if(currentSender!=null) total+=addImported(batch,currentDate,currentSender,currentBody.toString());
            if(!batch.isEmpty()){uploadImport(batch,tokenValue);total+=batch.size();}
            status.setText("Imported "+total+" old WhatsApp messages. Refresh the DGM WhatsApp page.");
        }catch(Exception e){status.setText("Chat import failed: "+e.getMessage());}
    }
    private int addImported(List<JSONObject> batch,String date,String sender,String body){
        try{
            JSONObject o=new JSONObject();
            o.put("sender",sender); o.put("body",body);
            o.put("direction","received");
            o.put("received_at",parseChatDate(date));
            o.put("external_id","oldchat-"+sha(date+"|"+sender+"|"+body));
            batch.add(o); return 1;
        }catch(Exception e){return 0;}
    }
    private String parseChatDate(String value){
        String[] formats={"d/M/yyyy H:mm","d/M/yy H:mm","d/M/yyyy h:mm a","d/M/yy h:mm a","M/d/yyyy H:mm","M/d/yy H:mm","M/d/yyyy h:mm a","M/d/yy h:mm a"};
        for(String f:formats)try{return new SimpleDateFormat(f,Locale.US).parse(value).toInstant().toString();}catch(Exception ignored){}
        return new java.util.Date().toInstant().toString();
    }
    private String sha(String raw){
        try{java.security.MessageDigest md=java.security.MessageDigest.getInstance("SHA-256");byte[] b=md.digest(raw.getBytes(StandardCharsets.UTF_8));StringBuilder x=new StringBuilder();for(byte q:b)x.append(String.format(Locale.US,"%02x",q));return x.toString();}catch(Exception e){return Integer.toHexString(raw.hashCode());}
    }
    private void uploadImport(List<JSONObject> batch,String tokenValue){
        try{
            JSONArray arr=new JSONArray();for(JSONObject o:batch)arr.put(o);
            JSONObject payload=new JSONObject();payload.put("messages",arr);
            MainActivityPost.Result r=MainActivityPost.postDetailed("/api/whatsapp/import",tokenValue,payload.toString());
            if(!r.isSuccess())throw new Exception("Server rejected import ("+r.code+")");
        }catch(Exception e){throw new RuntimeException(e);}
    }

    @Override protected void onActivityResult(int requestCode,int resultCode,Intent data){
        super.onActivityResult(requestCode,resultCode,data);
        if(requestCode==WA_IMPORT_REQ&&resultCode==RESULT_OK&&data!=null&&data.getData()!=null){
            importChat(data.getData()); return;
        }
        if(requestCode==VOICE_TREE_REQ&&resultCode==RESULT_OK&&data!=null&&data.getData()!=null){
            Uri uri=data.getData();
            try{getContentResolver().takePersistableUriPermission(uri,data.getFlags()&(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION));}catch(Exception ignored){}
            VoiceMediaSync.setTree(this,uri); VoiceMediaSync.schedule(this); VoiceMediaSync.now(this); refresh();
        }
    }
    private void openVoiceFolderPicker(){
        try{
            Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(i,VOICE_TREE_REQ);
        }catch(Exception e){status.setText("Could not open folder picker: "+e.getMessage());}
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
