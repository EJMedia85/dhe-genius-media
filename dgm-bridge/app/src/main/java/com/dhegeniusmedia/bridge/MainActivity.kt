package com.dhegeniusmedia.bridge

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import java.util.UUID

class MainActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var deviceId: TextView

    private val deviceIdValue by lazy {
        val prefs = getSharedPreferences("dgm_bridge", MODE_PRIVATE)
        prefs.getString("device_id", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("device_id", it).apply()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        status = findViewById(R.id.status)
        deviceId = findViewById(R.id.deviceId)
        deviceId.text = "Device ID: $deviceIdValue"

        findViewById<Button>(R.id.hostButton).setOnClickListener {
            requestVpn(BridgeVpnService.MODE_HOST)
        }
        findViewById<Button>(R.id.clientButton).setOnClickListener {
            requestVpn(BridgeVpnService.MODE_CLIENT)
        }
        findViewById<Button>(R.id.stopButton).setOnClickListener {
            stopService(Intent(this, BridgeVpnService::class.java))
            status.text = "● DISCONNECTED"
        }
    }

    private fun requestVpn(mode: String) {
        val intent = VpnService.prepare(this)
        if (intent != null) {
            startActivityForResult(intent, 1001)
            getSharedPreferences("dgm_bridge", MODE_PRIVATE)
                .edit().putString("pending_mode", mode).apply()
        } else {
            startVpn(mode)
        }
    }

    private fun startVpn(mode: String) {
        startService(
            Intent(this, BridgeVpnService::class.java)
                .putExtra(BridgeVpnService.EXTRA_MODE, mode)
        )
        status.text = if (mode == BridgeVpnService.MODE_HOST) {
            "● HOST STARTING"
        } else {
            "● CLIENT STARTING"
        }
    }

    @Deprecated("Android callback API retained for compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 1001 && resultCode == RESULT_OK) {
            val mode = getSharedPreferences("dgm_bridge", MODE_PRIVATE)
                .getString("pending_mode", BridgeVpnService.MODE_CLIENT)
                ?: BridgeVpnService.MODE_CLIENT
            startVpn(mode)
        }
    }
}
