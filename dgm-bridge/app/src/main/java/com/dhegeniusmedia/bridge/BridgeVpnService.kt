package com.dhegeniusmedia.bridge

import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

class BridgeVpnService : VpnService() {
    companion object {
        const val EXTRA_MODE = "mode"
        const val MODE_HOST = "host"
        const val MODE_CLIENT = "client"
        private const val TAG = "DGMBridge"
    }

    private var vpnInterface: ParcelFileDescriptor? = null
    private var relay: BridgeRelayClient? = null
    private val running = AtomicBoolean(false)

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val mode = intent?.getStringExtra(EXTRA_MODE) ?: MODE_CLIENT
        establishInterface(mode)
        return START_STICKY
    }

    private fun establishInterface(mode: String) {
        if (running.getAndSet(true)) return
        vpnInterface = Builder()
            .setSession("DGM Bridge " + mode)
            .addAddress("10.77.0.2", 32)
            .addRoute("0.0.0.0", 0)
            .addDnsServer("1.1.1.1")
            .establish()

        val prefs = getSharedPreferences("dgm_bridge", MODE_PRIVATE)
        val token = if (mode == MODE_HOST) prefs.getString("host_relay_token", null)
                    else prefs.getString("session_token", null)
        val secret = prefs.getString("pair_secret", null)

        if (token != null && secret != null) {
            relay = BridgeRelayClient(token, mode, secret,
                onPacket = { packet -> Log.d(TAG, "Received remote frame: " + packet.size + " bytes") },
                onState = { state -> Log.d(TAG, state) }
            ).also { it.connect() }

            if (mode == MODE_CLIENT) {
                Thread {
                    val input = vpnInterface?.fileDescriptor ?: return@Thread
                    val stream = java.io.FileInputStream(input)
                    val buffer = ByteArray(32767)
                    try {
                        while (running.get()) {
                            val count = stream.read(buffer)
                            if (count > 0) relay?.sendPacket(buffer.copyOf(count))
                        }
                    } catch (e: Exception) {
                        if (running.get()) Log.e(TAG, "TUN reader stopped", e)
                    }
                }.start()
            }
        } else {
            Log.w(TAG, "Bridge relay session not paired; VPN boundary only")
        }
    }

    override fun onDestroy() {
        running.set(false)
        relay?.close()
        relay = null
        vpnInterface?.close()
        vpnInterface = null
        super.onDestroy()
    }
}
