package com.dhegeniusmedia.companion;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import org.json.JSONObject;

public final class SmsSync {
    private SmsSync(){}

    public static void syncRecent(Context context){
        if(context.checkSelfPermission(Manifest.permission.READ_SMS)!=PackageManager.PERMISSION_GRANTED)return;
        Cursor c=null;
        try{
            c=context.getContentResolver().query(
                Uri.parse("content://sms"),
                new String[]{"_id","address","body","date","type"},
                null,null,"date DESC LIMIT 100");
            if(c==null)return;
            int idCol=c.getColumnIndex("_id"), addr=c.getColumnIndex("address"),
                body=c.getColumnIndex("body"), date=c.getColumnIndex("date"),
                type=c.getColumnIndex("type");
            while(c.moveToNext()){
                String idValue=idCol>=0?c.getString(idCol):String.valueOf(System.currentTimeMillis());
                String sender=addr>=0?c.getString(addr):"";
                String text=body>=0?c.getString(body):"";
                if(text==null||text.trim().isEmpty())continue;
                JSONObject meta=new JSONObject();
                if(date>=0)meta.put("timestamp",c.getLong(date));
                if(type>=0)meta.put("sms_type",c.getInt(type));
                meta.put("source","android_sms_history");
                DgmApi.sendMessage(context,"sms",sender,text,"sms-history-"+idValue,meta);
            }
        }catch(Exception ignored){}finally{if(c!=null)c.close();}
    }
}
