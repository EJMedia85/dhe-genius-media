package com.dhegeniusmedia.bridge

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.widget.EditText
import android.widget.Toast
import android.widget.Button
import android.widget.TextView
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var deviceId: TextView
    private val io = Executors.newSingleThreadExecutor()

    private val deviceIdValue by lazy {
        val prefs = getSharedPreferences("dgm_bridge", MODE_PRIVATE)
        prefs.getString("device_id", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("device_id", it).apply()
        }
    }

    private val api by lazy { BridgeApi() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        status = findViewById(R.id.status)
        deviceId = findViewById(R.id.deviceId)
        deviceId.text = "Device ID: $deviceIdValue\nFingerprint: ${BridgeSecurity.fingerprint(this)}"

        findViewById<Button>(R.id.hostButton).setOnClickListener { prepareHost() }
        findViewById<Button>(R.id.clientButton).setOnClickListener { showPairingDialog() }
        findViewById<Button>(R.id.stopButton).setOnClickListener {
            stopService(Intent(this, BridgeVpnService::class.java))
            status.text = "● DISCONNECTED"
        }
    }

    private fun prepareHost() {
        status.text = "● REGISTERING HOST"
        io.execute {
            try {
                api.register(deviceIdValue, BridgeVpnService.MODE_HOST, BridgeSecurity.publicKey(this))
                val pair = api.createPairing()
                val p = pair.getJSONObject("pairing")
                runOnUiThread {
                    AlertDialog.Builder(this)
                        .setTitle("DGM Bridge Pairing")
                        .setMessage(
                            "Give this pairing data to the client phone. It expires in 5 minutes.\n\n" +
                                "Code: ${p.getString("code")}\n\n" +
                                "Secret: ${p.getString("secret")}\n\n" +
                                "QR payload:\n${p.getString("qr_payload")}"
                        )
                        .setPositiveButton("Start Host VPN") { _, _ -> requestVpn(BridgeVpnService.MODE_HOST) }
                        .show()
                    status.text = "● PAIRING READY"
                }
            } catch (e: Exception) {
                runOnUiThread {
                    status.text = "● PAIRING ERROR"
                    Toast.makeText(this, e.message ?: "Pairing failed", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun showPairingDialog() {
        val input = EditText(this).apply {
            hint = "Paste QR payload or enter code|secret"
            setSingleLine(false)
            minLines = 2
        }
        AlertDialog.Builder(this)
            .setTitle("Connect to Host")
            .setMessage("Paste the host QR payload: DGM-BRIDGE|1|code|secret")
            .setView(input)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Pair") { _, _ -> claim(input.text.toString().trim()) }
            .show()
    }

    private fun claim(raw: String) {
        val parts = raw.split("|")
        val code: String
        val secret: String
        if (parts.size >= 4 && parts[0] == "DGM-BRIDGE") {
            code = parts[2]
            secret = parts[3]
        } else {
            val pieces = raw.split("\\s*[,|:]\\s*".toRegex())
            if (pieces.size != 2) {
                Toast.makeText(this, "Invalid pairing data", Toast.LENGTH_LONG).show()
                return
            }
            code = pieces[0]
            secret = pieces[1]
        }
        status.text = "● PAIRING CLIENT"
        io.execute {
            try {
                api.register(deviceIdValue, BridgeVpnService.MODE_CLIENT, BridgeSecurity.publicKey(this))
                val result = api.claimPairing(code, secret)
                getSharedPreferences("dgm_bridge", MODE_PRIVATE).edit()
                    .putString("session_id", result.getString("session_id"))
                    .putString("session_token", result.getString("session_token"))
                    .putString("pair_secret", secret)
                    .apply()
                runOnUiThread {
                    status.text = "● PAIRED"
                    requestVpn(BridgeVpnService.MODE_CLIENT)
                }
            } catch (e: Exception) {
                runOnUiThread {
                    status.text = "● PAIRING FAILED"
                    Toast.makeText(this, e.message ?: "Pairing failed", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun requestVpn(mode: String) {
        val intent = VpnService.prepare(this)
        if (intent != null) {
            startActivityForResult(intent, 1001)
            getSharedPreferences("dgm_bridge", MODE_PRIVATE).edit().putString("pending_mode", mode).apply()
        } else startVpn(mode)
    }

    private fun startVpn(mode: String) {
        startService(Intent(this, BridgeVpnService::class.java).putExtra(BridgeVpnService.EXTRA_MODE, mode))
        status.text = if (mode == BridgeVpnService.MODE_HOST) "● HOST STARTING" else "● CLIENT STARTING"
    }

    @Deprecated("Android callback API retained for compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 1001 && resultCode == RESULT_OK) {
            val mode = getSharedPreferences("dgm_bridge", MODE_PRIVATE)
                .getString("pending_mode", BridgeVpnService.MODE_CLIENT) ?: BridgeVpnService.MODE_CLIENT
            startVpn(mode)
        }
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }
}
