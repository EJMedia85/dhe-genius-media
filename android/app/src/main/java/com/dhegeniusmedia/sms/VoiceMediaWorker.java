package com.dhegeniusmedia.sms;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public class VoiceMediaWorker extends Worker {
    public VoiceMediaWorker(@NonNull Context c,@NonNull WorkerParameters p){super(c,p);}
    @NonNull @Override public Result doWork(){
        try{
            int uploaded=VoiceMediaSync.sync(getApplicationContext());
            android.util.Log.i("DGM_WA_MEDIA","Voice notes uploaded: "+uploaded);
            return Result.success();
        }catch(Exception e){
            android.util.Log.e("DGM_WA_MEDIA","Voice media sync failed",e);
            return Result.retry();
        }
    }
}
