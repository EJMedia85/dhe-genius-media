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
        if (running.getAndSet(true)) {
            Log.d(TAG, "Bridge service already running; ignoring duplicate start")
            return START_NOT_STICKY
        }

        startForegroundServiceNotification(mode)
        try {
            establish(mode)
        } catch (e: Exception) {
            Log.e(TAG, "Bridge data plane startup failed", e)
            if (mode == MODE_CLIENT && socks != null) {
                Log.w(TAG, "Local SOCKS remains available for diagnostics")
            } else {
                running.set(false)
                stopSelf(startId)
            }
        }
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
            throw IllegalStateException("Bridge session is not paired")
        }

        val currentRelay = BridgeRelayClient(
            token, mode, secret,
            onPacket = { frame -> socks?.onFrame(frame) },
            onState = { state ->
                Log.d(TAG, state)
                if (state == "RELAY RECONNECTING") socks?.stopStreams()
            }
        )
        relay = currentRelay

        if (mode == MODE_CLIENT) {
            socks = BridgeSocks(currentRelay, hostMode = false).also { it.start() }
        }

        currentRelay.connect()
        startHeartbeat(token)

        if (mode == MODE_HOST) {
            socks = BridgeSocks(currentRelay, hostMode = true).also { it.start() }
            return
        }

        vpnInterface = Builder()
            .setSession("DGM Bridge client")
            .setMtu(1500)
            .addAddress("198.18.0.1", 15)
            .addRoute("0.0.0.0", 0)
            .addRoute("198.18.0.0", 15)
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
              ipv4: 198.18.0.1
            socks5:
              address: 127.0.0.1
              port: 10808
              udp: udp
            misc:
              connect-timeout: 30000
              tcp-read-write-timeout: 300000
              udp-read-write-timeout: 60000
              log-file: stdout
              log-level: debug

            """.trimIndent()
        )
        try {
            val started = TProxyService.TProxyStartService(config.absolutePath, tun.fd)
            Log.d(TAG, "HEV start returned: $started")
            val runningNow = try { TProxyService.TProxyIsRunning() } catch (t: Throwable) {
                Log.e(TAG, "HEV running-state check failed", t)
                false
            }
            Log.d(TAG, "DGM Bridge client data plane: HEV running=$runningNow")
            if (!started || !runningNow) throw IllegalStateException("TUN-to-SOCKS engine did not start")
        } catch (t: Throwable) {
            Log.e(TAG, "HEV/TUN startup failed", t)
            throw IllegalStateException("Client tunnel engine failed", t)
        }
    }

    private fun startHeartbeat(token: String) {
        Thread {
            val client = okhttp3.OkHttpClient()
            while (running.get()) {
                try {
                    val request = okhttp3.Request.Builder()
                        .url("https://dhe-genius-media.onrender.com/api/bridge/heartbeat")
                        .header("Authorization", "Bearer " + token)
                        .post(okhttp3.RequestBody.create(null, ByteArray(0)))
                        .build()
                    client.newCall(request).execute().use { response ->
                        if (!response.isSuccessful) Log.w(TAG, "Bridge heartbeat failed: HTTP " + response.code)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Bridge heartbeat error: " + e.message)
                }
                try { Thread.sleep(20000) } catch (_: InterruptedException) { return@Thread }
            }
            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
        }.start()
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
