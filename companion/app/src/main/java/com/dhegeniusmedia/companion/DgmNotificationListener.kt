package com.dhegeniusmedia.companion
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
class DgmNotificationListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName != "com.whatsapp" && sbn.packageName != "com.whatsapp.w4b") return
        val extras = sbn.notification.extras
        val title = extras.getString("android.title") ?: return
        val body = extras.getCharSequence("android.text")?.toString() ?: return
        DgmRepository.enqueueIncoming(this, "whatsapp", title, body)
    }
}