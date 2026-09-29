package com.dhegeniusmedia.sms;

import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public final class SyncStore {
    private static final String PREF="dgm_sync";
    private SyncStore(){}
    private static SharedPreferences p(Context c){return c.getSharedPreferences(PREF,Context.MODE_PRIVATE);}
    private static JSONArray arr(Context c,String k){try{return new JSONArray(p(c).getString(k,"[]"));}catch(Exception e){return new JSONArray();}}

    public static synchronized boolean enqueue(Context c,String type,String externalId,String payload,String displaySender,String displayBody,String time){
        try{
            JSONArray seen=arr(c,"seen");
            for(int i=0;i<seen.length();i++) if(externalId.equals(seen.optString(i))) return false;
            JSONArray q=arr(c,"queue");
            JSONObject o=new JSONObject();
            o.put("type",type);
            o.put("external_id",externalId);
            o.put("payload",payload);
            o.put("sender",displaySender);
            o.put("body",displayBody);
            o.put("time",time);
            try{
                JSONObject source=new JSONObject(payload);
                o.put("direction",source.optString("direction",""));
                o.put("event_type",source.optString("event_type",""));
            }catch(Exception ignored){}
            o.put("created_at",System.currentTimeMillis());
            o.put("unread",true);
            q.put(o);
            seen.put(externalId);
            while(q.length()>1000) q.remove(0);
            while(seen.length()>5000) seen.remove(0);
            SharedPreferences.Editor e=p(c).edit().putString("queue",q.toString()).putString("seen",seen.toString());
            if("whatsapp".equals(type)){
                JSONArray h=arr(c,"whatsapp"); h.put(o); while(h.length()>1000)h.remove(0); e.putString("whatsapp",h.toString());
            } else if("sms".equals(type)){
                JSONArray h=arr(c,"sms"); h.put(o); while(h.length()>2000)h.remove(0); e.putString("sms",h.toString());
            }
            e.apply();
            return true;
        }catch(Exception e){return false;}
    }

    public static synchronized int captureSentSms(Context c){
        int added=0;
        Cursor cur=null;
        try{
            cur=c.getContentResolver().query(Uri.parse("content://sms/sent"),
                    new String[]{"_id","address","body","date"},null,null,"date DESC");
            if(cur!=null){
                int limit=500;
                while(cur.moveToNext() && limit-->0){
                    String id=cur.getString(0), address=cur.getString(1), body=cur.getString(2);
                    long date=cur.getLong(3);
                    String externalId="tx-"+id;
                    JSONObject o=new JSONObject();
                    o.put("external_id",externalId);
                    o.put("direction","outbound");
                    o.put("sender",address==null?"":address);
                    o.put("body",body==null?"":body);
                    o.put("received_at",new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",java.util.Locale.US).format(new java.util.Date(date)));
                    if(enqueue(c,"sms",externalId,o.toString(),address==null?"":address,body==null?"":body,o.optString("received_at"))) added++;
                }
            }
        }catch(Exception ignored){} finally{if(cur!=null)cur.close();}
        return added;
    }

    public static synchronized List<JSONObject> pending(Context c){
        JSONArray q=arr(c,"queue"); List<JSONObject> out=new ArrayList<>();
        for(int i=0;i<q.length();i++){JSONObject o=q.optJSONObject(i);if(o!=null)out.add(o);}
        return out;
    }

    public static synchronized void removeExternalId(Context c,String id){
        JSONArray q=arr(c,"queue"),n=new JSONArray();
        for(int i=0;i<q.length();i++){JSONObject o=q.optJSONObject(i);if(o!=null&&!id.equals(o.optString("external_id")))n.put(o);}
        p(c).edit().putString("queue",n.toString()).apply();
    }

    public static synchronized void markSynced(Context c,String type){
        String key="synced_"+type;
        p(c).edit().putInt(key,p(c).getInt(key,0)+1).apply();
    }

    public static int pendingCount(Context c){return pending(c).size();}
    public static int count(Context c,String type){return arr(c,type).length();}
    public static int syncedCount(Context c,String type){return p(c).getInt("synced_"+type,0);}
    public static int failedCount(Context c){return p(c).getInt("failed_count",0);}
    public static String lastSync(Context c){return p(c).getString("last_sync","");}
    public static String lastError(Context c){return p(c).getString("last_error","");}
    public static String serverStatus(Context c){return p(c).getString("server_status","Unknown");}

    public static void markSuccess(Context c){
        p(c).edit().putString("last_sync",new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss",java.util.Locale.US).format(new java.util.Date()))
                .putString("server_status","Connected").remove("last_error").apply();
    }
    public static void markError(Context c,String e){
        p(c).edit().putString("last_error",e==null?"Unknown error":e).putString("server_status","Error").apply();
    }
    public static void markFailed(Context c){p(c).edit().putInt("failed_count",p(c).getInt("failed_count",0)+1).apply();}
    public static void clearError(Context c){p(c).edit().remove("last_error").putString("server_status","Connected").apply();}
    public static void clear(Context c){p(c).edit().clear().apply();}

    public static JSONArray conversations(Context c){
        JSONArray all=new JSONArray(); JSONArray a=arr(c,"sms"),b=arr(c,"whatsapp");
        for(int i=0;i<a.length();i++)all.put(a.opt(i));
        for(int i=0;i<b.length();i++)all.put(b.opt(i));
        return all;
    }
}
