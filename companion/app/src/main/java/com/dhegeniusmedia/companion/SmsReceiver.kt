package com.dhegeniusmedia.companion
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        Telephony.Sms.Intents.getMessagesFromIntent(intent).forEach { DgmRepository.enqueueIncoming(context, "sms", it.originatingAddress ?: "Unknown", it.messageBody ?: "") }
    }
}