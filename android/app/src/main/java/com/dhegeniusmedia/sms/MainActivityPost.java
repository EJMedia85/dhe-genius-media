package com.dhegeniusmedia.sms;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class MainActivityPost {
    private static final String BASE="https://dhe-genius-media.onrender.com";
    private MainActivityPost(){}

    public static Result postDetailed(String path,String token,String json){
        HttpURLConnection x=null;
        try{
            if(!path.startsWith("/")) path="/"+path;
            x=(HttpURLConnection)new URL(BASE+path).openConnection();
            x.setRequestMethod("POST");
            x.setRequestProperty("Authorization","Bearer "+token);
            x.setRequestProperty("Content-Type","application/json");
            x.setRequestProperty("Accept","application/json");
            x.setConnectTimeout(15000);
            x.setReadTimeout(15000);
            x.setDoOutput(true);
            byte[] data=json==null?new byte[0]:json.getBytes(StandardCharsets.UTF_8);
            try(OutputStream os=x.getOutputStream()){os.write(data);}
            int code=x.getResponseCode();
            InputStream in=code>=400?x.getErrorStream():x.getInputStream();
            StringBuilder body=new StringBuilder();
            if(in!=null){byte[] b=new byte[1024];int n;while((n=in.read(b))>0)body.append(new String(b,0,n,StandardCharsets.UTF_8));in.close();}
            return new Result(code,body.toString());
        }catch(Exception e){return new Result(-1,e.getMessage()==null?"Network error":e.getMessage());}
        finally{if(x!=null)x.disconnect();}
    }

    public static boolean post(String path,String token,String json){return postDetailed(path,token,json).isSuccess();}

    public static final class Result{
        public final int code; public final String body;
        Result(int code,String body){this.code=code;this.body=body;}
        public boolean isSuccess(){return code>=200&&code<300;}
        public boolean isUnauthorized(){return code==401||code==403;}
    }
}
