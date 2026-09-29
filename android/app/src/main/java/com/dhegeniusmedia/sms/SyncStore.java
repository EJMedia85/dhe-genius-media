package com.dhegeniusmedia.sms;

import android.content.Context;
import android.content.SharedPreferences;
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
            JSONArray seen=arr(c,"seen"); for(int i=0;i<seen.length();i++)if(externalId.equals(seen.optString(i)))return false;
            JSONArray q=arr(c,"queue"); JSONObject o=new JSONObject(); o.put("type",type);o.put("external_id",externalId);o.put("payload",payload);o.put("sender",displaySender);o.put("body",displayBody);o.put("time",time);o.put("created_at",System.currentTimeMillis()); q.put(o);
            seen.put(externalId);
            while(q.length()>1000)q.remove(0); while(seen.length()>3000)seen.remove(0);
            p(c).edit().putString("queue",q.toString()).putString("seen",seen.toString()).apply();
            if("whatsapp".equals(type)){JSONArray h=arr(c,"whatsapp");h.put(o);while(h.length()>500)h.remove(0);p(c).edit().putString("whatsapp",h.toString()).apply();}
            if("sms".equals(type)){JSONArray h=arr(c,"sms");h.put(o);while(h.length()>1000)h.remove(0);p(c).edit().putString("sms",h.toString()).apply();}
            return true;
        }catch(Exception e){return false;}
    }
    public static synchronized List<JSONObject> pending(Context c){
        JSONArray q=arr(c,"queue");List<JSONObject> out=new ArrayList<>();for(int i=0;i<q.length();i++){JSONObject o=q.optJSONObject(i);if(o!=null)out.add(o);}return out;
    }
    public static synchronized void removeExternalId(Context c,String id){
        JSONArray q=arr(c,"queue");JSONArray n=new JSONArray();for(int i=0;i<q.length();i++){JSONObject o=q.optJSONObject(i);if(o!=null&&!id.equals(o.optString("external_id")))n.put(o);}p(c).edit().putString("queue",n.toString()).apply();
    }
    public static int pendingCount(Context c){return pending(c).size();}
    public static int count(Context c,String type){return arr(c,type).length();}
    public static String lastSync(Context c){return p(c).getString("last_sync","");}
    public static String lastError(Context c){return p(c).getString("last_error","");}
    public static void markSuccess(Context c){p(c).edit().putString("last_sync",new java.util.Date().toInstant().toString()).remove("last_error").apply();}
    public static void markError(Context c,String e){p(c).edit().putString("last_error",e==null?"Unknown error":e).apply();}
    public static void clear(Context c){p(c).edit().clear().apply();}
    public static JSONArray conversations(Context c){JSONArray all=new JSONArray();JSONArray a=arr(c,"sms"),b=arr(c,"whatsapp");for(int i=0;i<a.length();i++)all.put(a.opt(i));for(int i=0;i<b.length();i++)all.put(b.opt(i));return all;}
}
