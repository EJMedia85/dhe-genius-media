package com.dhegeniusmedia.sms;

import android.app.*;
import android.content.*;
import android.database.ContentObserver;
import android.net.Uri;
import android.os.*;

public class SmsSyncService extends Service {
    private static final int N=77;
    private ContentObserver observer;

    @Override public void onCreate(){
        super.onCreate();
        createChannel();
        startForeground(N,notification());
        observer=new ContentObserver(new Handler(Looper.getMainLooper())){
            @Override public void onChange(boolean self,Uri uri){
                SyncStore.captureSentSms(SmsSyncService.this);
                SyncWorker.now(SmsSyncService.this);
            }
        };
        getContentResolver().registerContentObserver(Uri.parse("content://sms"),true,observer);
        SyncStore.captureSentSms(this);
        SyncWorker.schedule(this);
        SyncWorker.now(this);
    }

    private Notification notification(){
        return new Notification.Builder(this,"dgm_sms")
                .setContentTitle("DGM Companion")
                .setContentText("Background synchronization is active")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setOngoing(true).build();
    }

    private void createChannel(){
        if(Build.VERSION.SDK_INT>=26){
            NotificationManager nm=getSystemService(NotificationManager.class);
            nm.createNotificationChannel(new NotificationChannel(
                    "dgm_sms","DGM Background Sync",NotificationManager.IMPORTANCE_LOW));
        }
    }

    @Override public int onStartCommand(Intent i,int flags,int id){return START_STICKY;}
    @Override public void onDestroy(){if(observer!=null)getContentResolver().unregisterContentObserver(observer);super.onDestroy();}
    @Override public IBinder onBind(Intent i){return null;}
}
