package com.dhegeniusmedia.bridge

import okhttp3.*
import okio.ByteString
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.random.Random

class BridgeRelayClient(
    private val sessionToken: String,
    private val role: String,
    private val secret: String,
    private val onPacket: (ByteArray) -> Unit,
    private val onState: (String) -> Unit
) {
    private val http = OkHttpClient()
    private var socket: WebSocket? = null

    private fun key(): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(secret.toByteArray(Charsets.UTF_8))

    fun connect() {
        val encoded = java.net.URLEncoder.encode(sessionToken, "UTF-8")
        val url = "wss://dhe-genius-media.onrender.com/api/bridge/relay?token=" + encoded + "&role=" + role
        socket = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { onState("RELAY CONNECTED") }
            override fun onMessage(webSocket: WebSocket, text: String) { onState(text) }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                try { onPacket(decrypt(bytes.toByteArray())) } catch (_: Exception) { onState("RELAY AUTH ERROR") }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onState("RELAY ERROR: " + (t.message ?: "connection failed"))
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { onState("RELAY CLOSED") }
        })
    }

    fun sendPacket(packet: ByteArray): Boolean =
        socket?.send(ByteString.of(*encrypt(packet))) ?: false

    fun close() {
        socket?.close(1000, "DGM Bridge disconnect")
        socket = null
        http.dispatcher.executorService.shutdown()
    }

    private fun encrypt(plain: ByteArray): ByteArray {
        val iv = ByteArray(12).also { Random.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key(), "AES"), GCMParameterSpec(128, iv))
        return byteArrayOf(1) + iv + cipher.doFinal(plain)
    }

    private fun decrypt(frame: ByteArray): ByteArray {
        require(frame.size > 13 && frame[0].toInt() == 1)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key(), "AES"),
            GCMParameterSpec(128, frame.copyOfRange(1, 13))
        )
        return cipher.doFinal(frame.copyOfRange(13, frame.size))
    }
}
