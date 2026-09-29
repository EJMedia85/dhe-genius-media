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
        Context c=getApplicationContext(); String token=SecureTokenStore.get(c);
        if(token.length()<20){SyncStore.markError(c,"Device is not authorized.");return Result.success();}
        int ok=0; try{
            for(JSONObject o:SyncStore.pending(c)){
                boolean sent=MainActivityPost.post("/api/"+("sms".equals(o.optString("type"))?"sms":"whatsapp")+"/ingest",token,o.optString("payload",""));
                if(sent){SyncStore.removeExternalId(c,o.optString("external_id"));ok++;}
            }
            if(SyncStore.pendingCount(c)==0)SyncStore.markSuccess(c); else SyncStore.markError(c,"Some items remain pending.");
            return Result.success();
        }catch(Exception e){SyncStore.markError(c,e.getMessage());return Result.retry();}
    }
    public static void schedule(Context c){
        Constraints cs=new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        androidx.work.PeriodicWorkRequest periodic=new androidx.work.PeriodicWorkRequest.Builder(SyncWorker.class,15,java.util.concurrent.TimeUnit.MINUTES).setConstraints(cs).build();
        WorkManager.getInstance(c).enqueueUniquePeriodicWork("dgm_periodic_sync",androidx.work.ExistingPeriodicWorkPolicy.UPDATE,periodic);
    }
    public static void now(Context c){
        Constraints cs=new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        androidx.work.OneTimeWorkRequest req=new androidx.work.OneTimeWorkRequest.Builder(SyncWorker.class).setConstraints(cs).build();
        WorkManager.getInstance(c).enqueueUniqueWork("dgm_sync_now",androidx.work.ExistingWorkPolicy.REPLACE,req);
    }
}
