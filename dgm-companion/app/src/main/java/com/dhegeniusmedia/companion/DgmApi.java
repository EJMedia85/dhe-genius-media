package com.dhegeniusmedia.companion;

import android.content.Context;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import android.util.Log;

public final class DgmApi {
    public static final String BASE_URL="https://dhe-genius-media.onrender.com";
    private DgmApi(){}

    public static JSONObject post(Context context,String path,JSONObject payload,String bearer) throws Exception{
        return request(context,"POST",path,payload,bearer);
    }

    public static JSONObject get(Context context,String path,String bearer) throws Exception{
        return request(context,"GET",path,null,bearer);
    }

    private static JSONObject request(Context context,String method,String path,JSONObject payload,String bearer) throws Exception{
        HttpURLConnection c=(HttpURLConnection)new URL(BASE_URL+path).openConnection();
        c.setRequestMethod(method); c.setConnectTimeout(15000); c.setReadTimeout(20000);
        c.setRequestProperty("Accept","application/json");
        if(bearer!=null)c.setRequestProperty("Authorization","Bearer "+bearer);
        if(payload!=null){
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type","application/json");
            try(OutputStream os=c.getOutputStream()){
                os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
            }
        }
        return read(c);
    }

    private static JSONObject read(HttpURLConnection c) throws Exception{
        int code=c.getResponseCode();
        InputStream in=code>=400?c.getErrorStream():c.getInputStream();
        StringBuilder b=new StringBuilder();
        if(in!=null){
            try(BufferedReader r=new BufferedReader(new InputStreamReader(in,StandardCharsets.UTF_8))){
                String s; while((s=r.readLine())!=null)b.append(s);
            }
        }
        JSONObject out=b.length()>0?new JSONObject(b.toString()):new JSONObject();
        if(code<200||code>=300)throw new IOException(out.optString("message","HTTP "+code));
        return out;
    }

    public static boolean sendMessage(Context context,String channel,String sender,String body,String clientId,JSONObject metadata){
        String token=TokenStore.get(context);
        if(token==null){ Log.w("DGM_COMPANION","Cannot send message: no authorization token"); return false; }
        try{
            JSONObject p=new JSONObject();
            p.put("channel",channel); p.put("sender",sender); p.put("body",body);
            p.put("client_id",clientId);
            if(metadata!=null)p.put("metadata",metadata);
            Exception last=null;
            for(int attempt=1;attempt<=3;attempt++){
                try{
                    post(context,"/api/companion/messages",p,token);
                    return true;
                }catch(Exception e){
                    last=e;
                    if(attempt<3) Thread.sleep(750L*attempt);
                }
            }
            Log.e("DGM_COMPANION","Message upload failed: "+channel+" / "+(last==null?"unknown":last.getMessage()),last);
        }catch(Exception e){
            Log.e("DGM_COMPANION","Message upload error: "+channel,e);
        }
        return false;
    }

    public static boolean heartbeat(Context context){
        String token=TokenStore.get(context); if(token==null)return false;
        try{
            JSONObject r=get(context,"/api/companion/heartbeat",token);
            return r.optBoolean("success",false);
        }catch(Exception e){return false;}
    }
}
