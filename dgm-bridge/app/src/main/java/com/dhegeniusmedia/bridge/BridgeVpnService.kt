package com.dhegeniusmedia.bridge

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.core.app.NotificationCompat
import hev.htproxy.TProxyService
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

class BridgeVpnService : VpnService() {
    companion object {
        const val EXTRA_MODE = "mode"
        const val MODE_HOST = "host"
        const val MODE_CLIENT = "client"
        private const val TAG = "DGMBridge"
        private const val CHANNEL = "dgm_bridge"
        private const val NOTIFICATION = 77
    }

    private var vpnInterface: ParcelFileDescriptor? = null
    private var relay: BridgeRelayClient? = null
    private var socks: BridgeSocks? = null
    private val running = AtomicBoolean(false)

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val mode = intent?.getStringExtra(EXTRA_MODE) ?: MODE_CLIENT
        if (!running.getAndSet(true)) startForegroundServiceNotification(mode)
        establish(mode)
        return START_STICKY
    }

    private fun startForegroundServiceNotification(mode: String) {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "DGM Bridge", NotificationManager.IMPORTANCE_LOW))
        }
        val pending = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("DGM Bridge")
            .setContentText(if (mode == MODE_HOST) "Host Internet sharing is active" else "Remote Internet tunnel is active")
            .setOngoing(true)
            .setContentIntent(pending)
            .build()
        startForeground(NOTIFICATION, notification)
    }

    private fun establish(mode: String) {
        val prefs = getSharedPreferences("dgm_bridge", MODE_PRIVATE)
        val token = if (mode == MODE_HOST) prefs.getString("host_relay_token", null)
                    else prefs.getString("session_token", null)
        val secret = prefs.getString("pair_secret", null)
        if (token == null || secret == null) {
            Log.w(TAG, "Bridge session is not paired")
            stopSelf()
            return
        }

        relay = BridgeRelayClient(token, mode, secret,
            onPacket = { frame -> socks?.onFrame(frame) },
            onState = { state -> Log.d(TAG, state) }
        ).also { it.connect() }

        if (mode == MODE_HOST) {
            // Host uses its normal mobile/Wi-Fi network directly. It does not
            // create a VPN for itself; doing so would capture its own traffic.
            socks = BridgeSocks(relay!!, hostMode = true).also { it.start() }
            return
        }

        socks = BridgeSocks(relay!!, hostMode = false).also { it.start() }

        vpnInterface = Builder()
            .setSession("DGM Bridge client")
            .setMtu(1500)
            .addAddress("10.77.0.2", 32)
            .addRoute("0.0.0.0", 0)
            .addDnsServer("1.1.1.1")
            .apply {
                try { addDisallowedApplication(packageName) } catch (_: Exception) {}
            }
            .establish()

        val tun = vpnInterface ?: throw IllegalStateException("Could not establish VPN")
        val config = File(cacheDir, "dgm-bridge-tun.yaml")
        config.writeText(
            """
            tunnel:
              name: tun0
              mtu: 1500
              ipv4: 10.77.0.2
            socks5:
              address: 127.0.0.1
              port: 10808
              udp: tcp
            misc:
              icmp: off
            """.trimIndent()
        )
        if (!TProxyService.TProxyStartService(config.absolutePath, tun.fileDescriptor)) {
            throw IllegalStateException("TUN-to-SOCKS engine could not start")
        }
        Log.d(TAG, "DGM Bridge client data plane started")
    }

    override fun onDestroy() {
        running.set(false)
        try { TProxyService.TProxyStopService() } catch (_: Throwable) {}
        socks?.stop()
        socks = null
        relay?.close()
        relay = null
        vpnInterface?.close()
        vpnInterface = null
        super.onDestroy()
    }

    override fun onRevoke() {
        stopSelf()
        super.onRevoke()
    }
}
