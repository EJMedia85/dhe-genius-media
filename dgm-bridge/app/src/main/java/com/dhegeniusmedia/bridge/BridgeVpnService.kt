package com.dhegeniusmedia.bridge

import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import java.util.concurrent.atomic.AtomicBoolean

class BridgeVpnService : VpnService() {
    companion object {
        const val EXTRA_MODE = "mode"
        const val MODE_HOST = "host"
        const val MODE_CLIENT = "client"
    }

    private var vpnInterface: ParcelFileDescriptor? = null
    private val running = AtomicBoolean(false)

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val mode = intent?.getStringExtra(EXTRA_MODE) ?: MODE_CLIENT
        establishInterface(mode)
        return START_STICKY
    }

    private fun establishInterface(mode: String) {
        if (running.getAndSet(true)) return

        vpnInterface = Builder()
            .setSession("DGM Bridge $mode")
            .addAddress("10.77.0.2", 32)
            .addRoute("0.0.0.0", 0)
            .addDnsServer("1.1.1.1")
            .establish()

        // This is the Android VPN boundary.
        // A real remote service requires the authenticated encrypted
        // transport and host-side packet forwarding engine next.
    }

    override fun onDestroy() {
        running.set(false)
        vpnInterface?.close()
        vpnInterface = null
        super.onDestroy()
    }
}
