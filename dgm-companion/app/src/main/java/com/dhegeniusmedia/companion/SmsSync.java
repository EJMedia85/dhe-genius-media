package com.dhegeniusmedia.companion;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;

public final class SmsSync {
    private SmsSync(){}
    public static void syncRecent(Context context){
        if(context.checkSelfPermission(Manifest.permission.READ_SMS)!=PackageManager.PERMISSION_GRANTED)return;
        Cursor c=null;
        try{
            c=context.getContentResolver().query(
                Uri.parse("content://sms/inbox"),
                new String[]{"_id","address","body","date"},
                null,null,"date DESC LIMIT 100");
            if(c==null)return;
            int idCol=c.getColumnIndex("_id"), addr=c.getColumnIndex("address"), body=c.getColumnIndex("body"), date=c.getColumnIndex("date");
            while(c.moveToNext()){
                String id="sms-history-"+(idCol>=0?c.getString(idCol):"0");
                String sender=addr>=0?c.getString(addr):"";
                String text=body>=0?c.getString(body):"";
                org.json.JSONObject meta=new org.json.JSONObject();
                if(date>=0)meta.put("timestamp",c.getLong(date));
                DgmApi.sendMessage(context,"sms",sender,text,id,meta);
            }
        }catch(Exception ignored){}finally{if(c!=null)c.close();}
    }
}
