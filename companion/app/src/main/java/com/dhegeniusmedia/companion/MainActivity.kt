package com.dhegeniusmedia.companion
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {
    private lateinit var smsStatus: TextView
    private lateinit var whatsappStatus: TextView
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); setContentView(R.layout.activity_main)
        smsStatus = findViewById(R.id.smsStatus); whatsappStatus = findViewById(R.id.whatsappStatus)
        findViewById<Button>(R.id.smsButton).setOnClickListener { requestSmsPermissions() }
        findViewById<Button>(R.id.whatsappButton).setOnClickListener { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
        findViewById<Button>(R.id.settingsButton).setOnClickListener { startActivity(Intent(Settings.ACTION_SETTINGS)) }
    }
    override fun onResume() { super.onResume(); refreshStatus() }
    private fun requestSmsPermissions() {
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS, Manifest.permission.SEND_SMS), 100)
    }
    private fun refreshStatus() {
        val read = ContextCompat.checkSelfPermission(this, Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED
        val receive = ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        val send = ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
        smsStatus.text = if (read && receive && send) "SMS access: Granted ✓" else "SMS access: Required"
        val enabledPackages = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: ""
        whatsappStatus.text = if (enabledPackages.contains(packageName)) "WhatsApp notification access: Enabled ✓" else "WhatsApp notification access: Not enabled"
    }
}