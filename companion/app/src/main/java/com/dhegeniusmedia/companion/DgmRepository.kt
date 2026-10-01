package com.dhegeniusmedia.companion
import android.content.Context
import android.util.Log
object DgmRepository {
    private const val TAG = "DGM_COMPANION"
    fun enqueueIncoming(context: Context, channel: String, sender: String, body: String) {
        val prefs = context.getSharedPreferences("dgm_queue", Context.MODE_PRIVATE)
        val key = "${System.currentTimeMillis()}_$channel"
        prefs.edit().putString(key, "$sender\n$body").apply()
        Log.d(TAG, "Queued $channel message from $sender")
    }
}