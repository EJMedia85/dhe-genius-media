package com.dhegeniusmedia.bridge

import okhttp3.*
import okio.ByteString
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class BridgeRelayClient(
    private val sessionToken: String,
    private val role: String,
    private val secret: String,
    private val onPacket: (ByteArray) -> Unit,
    private val onState: (String) -> Unit
) {
    private val http = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private var socket: WebSocket? = null
    private var reconnectDelay = 1000L
    @Volatile private var closed = false
    @Volatile private var connecting = false
    private val reconnectScheduled = AtomicBoolean(false)

    private fun key() =
        MessageDigest.getInstance("SHA-256").digest(secret.toByteArray(Charsets.UTF_8))

    fun connect() {
        if (closed || connecting) return
        connecting = true
        reconnectScheduled.set(false)

        val encoded = java.net.URLEncoder.encode(sessionToken, "UTF-8")
        val url = "wss://dhe-genius-media.onrender.com/api/bridge/relay?token=$encoded&role=$role"

        socket = http.newWebSocket(
            Request.Builder()
                .url(url)
                .header("Cache-Control", "no-cache")
                .build(),
            object : WebSocketListener() {
                override fun onOpen(w: WebSocket, r: Response) {
                    connecting = false
                    reconnectDelay = 1000L
                    reconnectScheduled.set(false)
                    onState("RELAY CONNECTED")
                }

                override fun onMessage(w: WebSocket, t: String) {
                    onState(t)
                }

                override fun onMessage(w: WebSocket, b: ByteString) {
                    try {
                        onPacket(decrypt(b.toByteArray()))
                    } catch (_: Exception) {
                        onState("RELAY AUTH ERROR")
                    }
                }

                override fun onFailure(w: WebSocket, t: Throwable, r: Response?) {
                    connecting = false
                    if (!closed) {
                        onState("RELAY RECONNECTING")
                        scheduleReconnect()
                    }
                }

                override fun onClosed(w: WebSocket, c: Int, reason: String) {
                    connecting = false
                    if (!closed) {
                        onState("RELAY RECONNECTING")
                        scheduleReconnect()
                    }
                }
            }
        )
    }

    private fun scheduleReconnect() {
        if (closed || scheduler.isShutdown) return
        if (!reconnectScheduled.compareAndSet(false, true)) return

        val delay = reconnectDelay
        reconnectDelay = minOf(reconnectDelay * 2, 10000L)

        scheduler.schedule({
            reconnectScheduled.set(false)
            if (!closed) connect()
        }, delay, TimeUnit.MILLISECONDS)
    }

    fun sendFrame(frame: ByteArray): Boolean {
        val s = socket
        if (s == null) {
            scheduleReconnect()
            return false
        }
        return try {
            val ok = s.send(ByteString.of(*encrypt(frame)))
            if (!ok) scheduleReconnect()
            ok
        } catch (_: Exception) {
            scheduleReconnect()
            false
        }
    }

    fun sendPacket(packet: ByteArray) = sendFrame(packet)

    fun close() {
        closed = true
        reconnectScheduled.set(false)
        try { socket?.close(1000, "DGM Bridge disconnect") } catch (_: Exception) {}
        socket = null
        scheduler.shutdownNow()
        http.dispatcher.executorService.shutdown()
        http.connectionPool.evictAll()
    }

    private fun encrypt(p: ByteArray): ByteArray {
        val iv = ByteArray(12).also { kotlin.random.Random.nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key(), "AES"),
            GCMParameterSpec(128, iv)
        )
        return byteArrayOf(1) + iv + c.doFinal(p)
    }

    private fun decrypt(f: ByteArray): ByteArray {
        require(f.size > 13 && f[0].toInt() == 1)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key(), "AES"),
            GCMParameterSpec(128, f.copyOfRange(1, 13))
        )
        return c.doFinal(f.copyOfRange(13, f.size))
    }
}
