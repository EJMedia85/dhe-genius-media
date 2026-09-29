package com.dhegeniusmedia.sms;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.NetworkType;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import org.json.JSONObject;

public class SyncWorker extends Worker {
    public SyncWorker(@NonNull Context c,@NonNull WorkerParameters p){super(c,p);}

    public Result doWork(){
        Context c=getApplicationContext();
        String token=SecureTokenStore.get(c);
        if(token.length()<20){SyncStore.markError(c,"Device is not authorized.");return Result.success();}

        // Capture newly sent SMS locally before attempting network delivery.
        SyncStore.captureSentSms(c);

        boolean hadNetworkError=false;
        boolean unauthorized=false;
        int sent=0;

        try{
            for(JSONObject o:SyncStore.pending(c)){
                MainActivityPost.Result r=MainActivityPost.postDetailed(
                        "/api/"+("sms".equals(o.optString("type"))?"sms":"whatsapp")+"/ingest",
                        token,o.optString("payload",""));
                if(r.isSuccess()){
                    SyncStore.removeExternalId(c,o.optString("external_id"));
                    SyncStore.markSynced(c,o.optString("type"));
                    sent++;
                }else if(r.isUnauthorized()){
                    unauthorized=true;
                    SyncStore.markError(c,"Server rejected the device token (HTTP "+r.code+"). Device may be revoked.");
                    break;
                }else if(r.code<0){
                    hadNetworkError=true;
                    SyncStore.markError(c,r.body);
                }else{
                    SyncStore.markFailed(c);
                    SyncStore.markError(c,"Server HTTP "+r.code+(r.body.isEmpty()?"":": "+r.body));
                }
            }

            org.json.JSONObject heartbeatPayload=new org.json.JSONObject();
            heartbeatPayload.put("pending_count",SyncStore.pendingCount(c));
            MainActivityPost.Result hb=MainActivityPost.postDetailed("/api/sms/heartbeat",token,heartbeatPayload.toString());
            if(hb.isSuccess()){
                SyncStore.clearError(c);
                if(SyncStore.pendingCount(c)==0) SyncStore.markSuccess(c);
            }else if(hb.isUnauthorized()){
                unauthorized=true;
                SyncStore.markError(c,"Device token is invalid or revoked.");
            }else if(hb.code<0){
                hadNetworkError=true;
                SyncStore.markError(c,hb.body);
            }

            if(unauthorized) return Result.success();
            if(hadNetworkError) return Result.retry();
            if(SyncStore.pendingCount(c)==0) SyncStore.markSuccess(c);
            else SyncStore.markError(c,"Some items remain pending.");
            return Result.success();
        }catch(Exception e){
            SyncStore.markError(c,e.getMessage());
            return Result.retry();
        }
    }

    public static void schedule(Context c){
        Constraints cs=new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        androidx.work.PeriodicWorkRequest periodic=new androidx.work.PeriodicWorkRequest.Builder(
                SyncWorker.class,15,java.util.concurrent.TimeUnit.MINUTES).setConstraints(cs).build();
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(
                "dgm_periodic_sync",androidx.work.ExistingPeriodicWorkPolicy.UPDATE,periodic);
    }

    public static void now(Context c){
        Constraints cs=new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        androidx.work.OneTimeWorkRequest req=new androidx.work.OneTimeWorkRequest.Builder(SyncWorker.class)
                .setConstraints(cs).build();
        WorkManager.getInstance(c).enqueueUniqueWork(
                "dgm_sync_now",androidx.work.ExistingWorkPolicy.REPLACE,req);
    }
}
