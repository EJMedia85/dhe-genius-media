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

    private val clientPin by lazy {
        val prefs = getSharedPreferences("dgm_bridge", MODE_PRIVATE)
        prefs.getString("client_pin", null) ?: (100000..999999).random().toString().also {
            prefs.edit().putString("client_pin", it).apply()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        status = findViewById(R.id.status)
        deviceId = findViewById(R.id.deviceId)
        deviceId.text = "Device ID: $deviceIdValue\nFingerprint: ${BridgeSecurity.fingerprint(this)}"

        findViewById<Button>(R.id.hostButton).setOnClickListener { showAdminLogin() }
        findViewById<Button>(R.id.clientButton).setOnClickListener { registerClient() }
        findViewById<Button>(R.id.stopButton).setOnClickListener {
            stopService(Intent(this, BridgeVpnService::class.java))
            status.text = "● DISCONNECTED"
        }
    }

    private fun showAdminLogin() {
        val container = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(32, 8, 32, 0)
        }
        val email = EditText(this).apply {
            hint = "Admin email"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
        }
        val password = EditText(this).apply {
            hint = "Admin password"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        container.addView(email)
        container.addView(password)
        AlertDialog.Builder(this)
            .setTitle("DGM Admin Login")
            .setMessage("Host access requires the DGM Admin account.")
            .setView(container)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Login") { _, _ ->
                status.text = "● ADMIN LOGIN"
                io.execute {
                    try {
                        api.adminLogin(email.text.toString().trim(), password.text.toString())
                        runOnUiThread { prepareHost() }
                    } catch (e: Exception) {
                        runOnUiThread {
                            status.text = "● LOGIN FAILED"
                            Toast.makeText(this, e.message ?: "Admin login failed", Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }
            .show()
    }

    private fun prepareHost() {
        status.text = "● REGISTERING HOST"
        io.execute {
            try {
                api.register(deviceIdValue, BridgeVpnService.MODE_HOST, BridgeSecurity.publicKey(this))
                runOnUiThread { status.text = "● WAITING FOR ADMIN APPROVAL" }
                awaitAuthorization()
                val pair = api.createPairing()
                val p = pair.getJSONObject("pairing")
                getSharedPreferences("dgm_bridge", MODE_PRIVATE).edit()
                    .putString("session_id", p.getString("session_id"))
                    .putString("host_relay_token", p.getString("host_relay_token"))
                    .putString("pair_secret", p.getString("secret"))
                    .apply()
                runOnUiThread {
                    showCopyablePairingDialog(
                        p.getString("code"),
                        p.getString("secret"),
                        p.getString("qr_payload")
                    )
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

    private fun showCopyablePairingDialog(code: String, secret: String, qrPayload: String) {
        val container = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(32, 8, 32, 0)
        }

        fun addCopyRow(label: String, value: String) {
            val title = TextView(this).apply {
                text = label
                textSize = 14f
                setPadding(0, 12, 0, 4)
            }
            val valueView = EditText(this).apply {
                setText(value)
                isFocusable = true
                isFocusableInTouchMode = true
                isLongClickable = true
                setSingleLine(false)
                maxLines = 4
                setTextIsSelectable(true)
            }
            val copy = Button(this).apply {
                text = "COPY $label"
                setOnClickListener {
                    val clipboard = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    clipboard.setPrimaryClip(
                        android.content.ClipData.newPlainText(label, value)
                    )
                    Toast.makeText(this@MainActivity, "$label copied", Toast.LENGTH_SHORT).show()
                }
            }
            container.addView(title)
            container.addView(valueView)
            container.addView(copy)
        }

        addCopyRow("CODE", code)
        addCopyRow("SECRET", secret)
        addCopyRow("QR PAYLOAD", qrPayload)

        AlertDialog.Builder(this)
            .setTitle("DGM Bridge Pairing")
            .setMessage("Copy any value below and send it to the Client device. This pairing expires in 5 minutes.")
            .setView(container)
            .setNegativeButton("Close", null)
            .setPositiveButton("START HOST VPN") { _, _ ->
                requestVpn(BridgeVpnService.MODE_HOST)
            }
            .show()
    }

    private fun awaitAuthorization() {
        while (true) {
            val result = api.registrationStatus(deviceIdValue)
            val state = result.optString("approval_status", "pending")
            if (state == "approved") return
            if (state == "denied") throw IllegalStateException("Registration denied by DGM Admin.")
            Thread.sleep(3000)
        }
    }

    private fun registerClient() {
        status.text = "● REGISTERING CLIENT"
        io.execute {
            try {
                api.register(
                    deviceIdValue,
                    BridgeVpnService.MODE_CLIENT,
                    BridgeSecurity.publicKey(this),
                    pin = clientPin
                )
                runOnUiThread {
                    status.text = "● WAITING FOR ADMIN APPROVAL"
                    Toast.makeText(
                        this,
                        "Client registered. DGM Admin must authorize this device before pairing.",
                        Toast.LENGTH_LONG
                    ).show()
                }
                awaitAuthorization()
                runOnUiThread {
                    status.text = "● CLIENT AUTHORIZED"
                    showPairingDialog()
                }
            } catch (e: Exception) {
                runOnUiThread {
                    status.text = "● REGISTRATION FAILED"
                    Toast.makeText(
                        this,
                        e.message ?: "Client registration failed",
                        Toast.LENGTH_LONG
                    ).show()
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
