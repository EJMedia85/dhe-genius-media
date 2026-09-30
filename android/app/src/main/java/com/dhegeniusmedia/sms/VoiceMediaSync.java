package com.dhegeniusmedia.sms;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import androidx.documentfile.provider.DocumentFile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

public final class VoiceMediaSync {
    private static final String PREF="dgm_whatsapp_media";
    private static final String TREE="voice_tree_uri";
    private static final String UPLOADED="uploaded";
    private VoiceMediaSync(){}

    public static String tree(Context c){
        return c.getSharedPreferences(PREF,Context.MODE_PRIVATE).getString(TREE,"");
    }

    public static void setTree(Context c,Uri uri){
        c.getSharedPreferences(PREF,Context.MODE_PRIVATE).edit().putString(TREE,uri.toString()).apply();
    }

    public static void schedule(Context c){
        androidx.work.Constraints cs=new androidx.work.Constraints.Builder()
                .setRequiredNetworkType(androidx.work.NetworkType.CONNECTED).build();
        androidx.work.PeriodicWorkRequest req=new androidx.work.PeriodicWorkRequest.Builder(
                VoiceMediaWorker.class,15,TimeUnit.MINUTES).setConstraints(cs).build();
        androidx.work.WorkManager.getInstance(c).enqueueUniquePeriodicWork(
                "dgm_whatsapp_media",androidx.work.ExistingPeriodicWorkPolicy.UPDATE,req);
    }

    public static void now(Context c){
        androidx.work.Constraints cs=new androidx.work.Constraints.Builder()
                .setRequiredNetworkType(androidx.work.NetworkType.CONNECTED).build();
        androidx.work.OneTimeWorkRequest req=new androidx.work.OneTimeWorkRequest.Builder(VoiceMediaWorker.class)
                .setConstraints(cs).build();
        androidx.work.WorkManager.getInstance(c).enqueueUniqueWork(
                "dgm_whatsapp_media_now",androidx.work.ExistingWorkPolicy.REPLACE,req);
    }

    static int sync(Context c){
        String token=SecureTokenStore.get(c);
        String tree=tree(c);
        if(token.length()<20||tree.isEmpty()) return 0;

        DocumentFile root=DocumentFile.fromTreeUri(c,Uri.parse(tree));
        if(root==null||!root.canRead()) return 0;

        List<DocumentFile> files=new ArrayList<>();
        collect(root,files,0);
        Collections.sort(files,(a,b)->Long.compare(b.lastModified(),a.lastModified()));
        if(files.size()>500) files=new ArrayList<>(files.subList(0,500));

        Set<String> uploaded=uploaded(c);
        int count=0;
        for(DocumentFile file:files){
            if(file.length()>20L*1024L*1024L) continue;
            String name=file.getName()==null?"":file.getName().toLowerCase(Locale.US);
            if(!(name.endsWith(".opus")||name.endsWith(".ogg")||name.endsWith(".m4a")||name.endsWith(".aac"))) continue;

            String id=hash(file.getUri().toString()+"|"+file.length()+"|"+file.lastModified());
            if(uploaded.contains(id)) continue;

            JSONObject match=nearestVoiceEvent(c,file.lastModified());
            Map<String,String> headers=new HashMap<>();
            headers.put("X-DGM-Media-External-ID","wamedia-"+id);
            if(match!=null){
                headers.put("X-DGM-Message-External-ID",match.optString("external_id",""));
                headers.put("X-DGM-Sender",match.optString("sender","WhatsApp"));
                headers.put("X-DGM-Received-At",match.optString("received_at",""));
            }else{
                headers.put("X-DGM-Sender","WhatsApp");
                headers.put("X-DGM-Received-At",iso(file.lastModified()));
            }
            headers.put("X-DGM-Event-Type","voice_note");
            headers.put("X-DGM-Direction","received");
            headers.put("X-DGM-Mime-Type",mime(name));
            headers.put("X-DGM-Duration-Ms","0");

            try(InputStream in=c.getContentResolver().openInputStream(file.getUri())){
                if(in==null) continue;
                MainActivityPost.Result r=MainActivityPost.uploadBinary(
                        "/api/whatsapp/media",token,in,file.length(),headers);
                if(r.isSuccess()){
                    uploaded.add(id);
                    saveUploaded(c,uploaded);
                    count++;
                }else if(r.isUnauthorized()){
                    break;
                }
            }catch(Exception ignored){}
        }
        return count;
    }

    private static void collect(DocumentFile dir,List<DocumentFile> out,int depth){
        if(depth>6||dir==null) return;
        DocumentFile[] children=dir.listFiles();
        if(children==null) return;
        for(DocumentFile f:children){
            if(f.isDirectory()) collect(f,out,depth+1);
            else out.add(f);
        }
    }

    private static Set<String> uploaded(Context c){
        SharedPreferences p=c.getSharedPreferences(PREF,Context.MODE_PRIVATE);
        return new HashSet<>(p.getStringSet(UPLOADED,new HashSet<>()));
    }

    private static void saveUploaded(Context c,Set<String> set){
        HashSet<String> copy=new HashSet<>(set);
        if(copy.size()>2000){
            List<String> list=new ArrayList<>(copy);
            copy=new HashSet<>(list.subList(Math.max(0,list.size()-2000),list.size()));
        }
        c.getSharedPreferences(PREF,Context.MODE_PRIVATE).edit().putStringSet(UPLOADED,copy).apply();
    }

    private static JSONObject nearestVoiceEvent(Context c,long fileTime){
        try{
            String raw=c.getSharedPreferences("dgm_sync",Context.MODE_PRIVATE).getString("whatsapp","[]");
            JSONArray a=new JSONArray(raw);
            JSONObject best=null; long bestDelta=Long.MAX_VALUE;
            for(int i=0;i<a.length();i++){
                JSONObject o=a.optJSONObject(i); if(o==null) continue;
                String body=o.optString("body","").toLowerCase(Locale.US);
                if(!(body.contains("voice message")||body.contains("voice note")||body.contains("audio")||body.contains("🎤"))) continue;
                long t=parseTime(o.optString("time",o.optString("received_at","")));
                if(t<=0) t=parseTime(o.optString("received_at",""));
                if(t<=0) continue;
                long delta=Math.abs(fileTime-t);
                if(delta<=TimeUnit.MINUTES.toMillis(3)&&delta<bestDelta){best=o;bestDelta=delta;}
            }
            return best;
        }catch(Exception e){return null;}
    }

    private static long parseTime(String value){
        try{return new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",Locale.US).parse(value).getTime();}catch(Exception ignored){}
        try{return new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX",Locale.US).parse(value).getTime();}catch(Exception ignored){}
        return 0;
    }

    private static String iso(long ms){
        return new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",Locale.US).format(new Date(ms));
    }

    private static String mime(String name){
        if(name.endsWith(".m4a")) return "audio/mp4";
        if(name.endsWith(".aac")) return "audio/aac";
        if(name.endsWith(".ogg")) return "audio/ogg";
        return "audio/ogg";
    }

    private static String hash(String raw){
        try{
            MessageDigest md=MessageDigest.getInstance("SHA-256");
            byte[] b=md.digest(raw.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder out=new StringBuilder();
            for(byte x:b) out.append(String.format(Locale.US,"%02x",x));
            return out.toString();
        }catch(Exception e){return Integer.toHexString(raw.hashCode());}
    }
}
