package com.dhegeniusmedia.bridge

import java.io.*
import java.net.*
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

class BridgeSocks(
    private val relay: BridgeRelayClient,
    private val hostMode: Boolean,
    private val port: Int = 10808
) {
    private val executor = Executors.newCachedThreadPool()
    private val streams = ConcurrentHashMap<Int, Stream>()
    private val udpSockets = ConcurrentHashMap<Int, DatagramSocket>()
    private val nextId = AtomicInteger(1)
    @Volatile private var server: ServerSocket? = null

    private data class Stream(
        val socket: Socket,
        val input: BufferedInputStream,
        val output: BufferedOutputStream
    )

    fun start() {
        if (hostMode) return

        server = ServerSocket(port, 64, InetAddress.getByName("127.0.0.1"))
        executor.execute {
            while (server?.isClosed == false) {
                try {
                    executor.execute { clientHandshake(server!!.accept()) }
                } catch (_: Exception) {
                    break
                }
            }
        }
    }

    fun onFrame(frame: ByteArray) {
        val p = try { BridgeMux.parse(frame) } catch (_: Exception) { return }

        when (p.type) {
            BridgeMux.OPEN -> if (hostMode) executor.execute { openRemote(p.id, p.payload) }
            BridgeMux.OPEN_OK -> streams[p.id]?.let { sendClientReply(it.socket, 0) }
            BridgeMux.OPEN_FAIL -> streams.remove(p.id)?.let { close(it.socket) }
            BridgeMux.DATA -> streams[p.id]?.let { write(it.output, p.payload) }
            BridgeMux.UDP -> if (hostMode) executor.execute { openRemoteUdp(p.id, p.payload) }
            BridgeMux.CLOSE -> {
                streams.remove(p.id)?.let { close(it.socket) }
                udpSockets.remove(p.id)?.close()
            }
        }
    }

    private fun clientHandshake(socket: Socket) {
        val input = BufferedInputStream(socket.getInputStream())
        val output = BufferedOutputStream(socket.getOutputStream())

        try {
            if (input.read() != 5) throw IOException("Not SOCKS5")
            val n = input.read()
            if (n < 0) throw IOException("Invalid SOCKS5 methods")
            repeat(n) { input.read() }

            output.write(byteArrayOf(5, 0))
            output.flush()

            if (input.read() != 5) throw IOException("Invalid SOCKS5 request")
            val cmd = input.read()
            input.read()
            val atyp = input.read()

            val host = readAddress(input, atyp)
            val portBytes = ByteArray(2)
            input.readFully(portBytes)
            val dstPort = ByteBuffer.wrap(portBytes).short.toInt() and 65535

            val id = nextId.getAndIncrement()

            when (cmd) {
                1 -> {
                    streams[id] = Stream(socket, input, output)
                    val hostBytes = host.toByteArray(Charsets.UTF_8)
                    val payload = ByteBuffer.allocate(2 + hostBytes.size + 2)
                        .putShort(hostBytes.size.toShort())
                        .put(hostBytes)
                        .putShort(dstPort.toShort())
                        .array()
                    relay.sendFrame(BridgeMux.frame(BridgeMux.OPEN, id, payload))
                    executor.execute { readClient(id) }
                }

                3 -> {
                    // Standard SOCKS5 UDP ASSOCIATE. The VPN engine sends UDP
                    // datagrams to this local UDP socket while keeping this
                    // TCP control connection alive.
                    val udp = DatagramSocket(0, InetAddress.getByName("127.0.0.1"))
                    udpSockets[id] = udp
                    val boundPort = udp.localPort
                    sendUdpAssociateReply(output, boundPort)
                    executor.execute { readClientUdp(id, udp) }
                }

                else -> throw IOException("Unsupported SOCKS5 command")
            }
        } catch (_: Exception) {
            close(socket)
        }
    }

    private fun readClient(id: Int) {
        val s = streams[id] ?: return
        val buf = ByteArray(32768)
        try {
            while (!s.socket.isClosed) {
                val n = s.input.read(buf)
                if (n < 0) break
                if (n > 0) relay.sendFrame(BridgeMux.frame(BridgeMux.DATA, id, buf.copyOf(n)))
            }
        } catch (_: Exception) {
        } finally {
            relay.sendFrame(BridgeMux.frame(BridgeMux.CLOSE, id))
            streams.remove(id)
            close(s.socket)
        }
    }

    private fun readClientUdp(id: Int, udp: DatagramSocket) {
        val packetBuffer = ByteArray(65535)
        try {
            while (!udp.isClosed) {
                val packet = DatagramPacket(packetBuffer, packetBuffer.size)
                udp.receive(packet)
                val parsed = parseSocksUdp(packet.data, packet.length) ?: continue
                val hostBytes = parsed.host.toByteArray(Charsets.UTF_8)

                val payload = ByteBuffer.allocate(2 + hostBytes.size + 2 + 4 + parsed.data.size)
                    .putShort(hostBytes.size.toShort())
                    .put(hostBytes)
                    .putShort(parsed.port.toShort())
                    .putInt(parsed.data.size)
                    .put(parsed.data)
                    .array()

                relay.sendFrame(BridgeMux.frame(BridgeMux.UDP, id, payload))
            }
        } catch (_: Exception) {
        } finally {
            relay.sendFrame(BridgeMux.frame(BridgeMux.CLOSE, id))
            udpSockets.remove(id)
            udp.close()
        }
    }

    private fun openRemote(id: Int, payload: ByteArray) {
        try {
            val b = ByteBuffer.wrap(payload)
            val len = b.short.toInt() and 65535
            val hb = ByteArray(len)
            b.get(hb)
            val dstPort = b.short.toInt() and 65535

            val socket = Socket()
            socket.connect(
                InetSocketAddress(String(hb, Charsets.UTF_8), dstPort),
                10000
            )
            streams[id] = Stream(
                socket,
                BufferedInputStream(socket.getInputStream()),
                BufferedOutputStream(socket.getOutputStream())
            )
            relay.sendFrame(BridgeMux.frame(BridgeMux.OPEN_OK, id))
            executor.execute { readRemote(id) }
        } catch (_: Exception) {
            relay.sendFrame(BridgeMux.frame(BridgeMux.OPEN_FAIL, id))
        }
    }

    private fun openRemoteUdp(id: Int, payload: ByteArray) {
        try {
            val b = ByteBuffer.wrap(payload)
            val hostLen = b.short.toInt() and 65535
            require(hostLen <= b.remaining())
            val hostBytes = ByteArray(hostLen)
            b.get(hostBytes)
            val dstPort = b.short.toInt() and 65535
            val dataLen = b.int
            require(dataLen >= 0 && dataLen <= b.remaining())
            val data = ByteArray(dataLen)
            b.get(data)

            val udp = udpSockets.computeIfAbsent(id) { DatagramSocket() }
            val destination = InetAddress.getByName(String(hostBytes, Charsets.UTF_8))
            udp.send(DatagramPacket(data, data.size, destination, dstPort))

            udp.soTimeout = 1500
            val responseBytes = ByteArray(65535)
            val response = DatagramPacket(responseBytes, responseBytes.size)

            try {
                udp.receive(response)
                val source = response.address
                val sourceHost = source.hostAddress
                val sourceBytes = sourceHost.toByteArray(Charsets.UTF_8)

                val responsePayload = ByteBuffer.allocate(
                    2 + sourceBytes.size + 2 + 4 + response.length
                )
                    .putShort(sourceBytes.size.toShort())
                    .put(sourceBytes)
                    .putShort(response.port.toShort())
                    .putInt(response.length)
                    .put(response.data, response.offset, response.length)
                    .array()

                relay.sendFrame(BridgeMux.frame(BridgeMux.UDP, id, responsePayload))
            } catch (_: SocketTimeoutException) {
                // UDP is connectionless; no response is a normal condition.
            }
        } catch (_: Exception) {
        }
    }

    private fun readRemote(id: Int) {
        val s = streams[id] ?: return
        val buf = ByteArray(32768)
        try {
            while (!s.socket.isClosed) {
                val n = s.input.read(buf)
                if (n < 0) break
                if (n > 0) relay.sendFrame(BridgeMux.frame(BridgeMux.DATA, id, buf.copyOf(n)))
            }
        } catch (_: Exception) {
        } finally {
            relay.sendFrame(BridgeMux.frame(BridgeMux.CLOSE, id))
            streams.remove(id)
            close(s.socket)
        }
    }

    private fun readAddress(input: InputStream, atyp: Int): String {
        return when (atyp) {
            1 -> ByteArray(4).also { input.readFully(it) }
                .joinToString(".") { (it.toInt() and 255).toString() }

            3 -> {
                val len = input.read()
                if (len <= 0) throw IOException("Invalid domain")
                ByteArray(len).also { input.readFully(it) }.toString(Charsets.UTF_8)
            }

            4 -> ByteArray(16).also { input.readFully(it) }
                .let { InetAddress.getByAddress(it).hostAddress }

            else -> throw IOException("Unsupported SOCKS address type")
        }
    }

    private data class UdpRequest(
        val host: String,
        val port: Int,
        val data: ByteArray
    )

    private fun parseSocksUdp(bytes: ByteArray, length: Int): UdpRequest? {
        if (length < 4) return null
        val b = ByteBuffer.wrap(bytes, 0, length)
        if (b.get().toInt() != 0 || b.get().toInt() != 0) return null
        if (b.get().toInt() != 0) return null
        val atyp = b.get().toInt() and 255

        val host = when (atyp) {
            1 -> {
                val ip = ByteArray(4)
                b.get(ip)
                ip.joinToString(".") { (it.toInt() and 255).toString() }
            }
            3 -> {
                val len = b.get().toInt() and 255
                val domain = ByteArray(len)
                b.get(domain)
                domain.toString(Charsets.UTF_8)
            }
            4 -> {
                val ip = ByteArray(16)
                b.get(ip)
                InetAddress.getByAddress(ip).hostAddress
            }
            else -> return null
        }

        val dstPort = b.short.toInt() and 65535
        val data = ByteArray(b.remaining())
        b.get(data)
        return UdpRequest(host, dstPort, data)
    }

    private fun sendUdpAssociateReply(output: OutputStream, port: Int) {
        output.write(
            byteArrayOf(
                5, 0, 0, 1,
                127, 0, 0, 1,
                (port ushr 8).toByte(), port.toByte()
            )
        )
        output.flush()
    }

    private fun sendClientReply(socket: Socket, code: Int) {
        try {
            val o = BufferedOutputStream(socket.getOutputStream())
            o.write(byteArrayOf(5, code.toByte(), 0, 1, 0, 0, 0, 0, 0, 0))
            o.flush()
        } catch (_: Exception) {
            close(socket)
        }
    }

    private fun write(out: BufferedOutputStream, bytes: ByteArray) {
        try {
            synchronized(out) {
                out.write(bytes)
                out.flush()
            }
        } catch (_: Exception) {
        }
    }

    private fun close(socket: Socket) {
        try { socket.close() } catch (_: Exception) {}
    }

    fun stopStreams() {
        streams.values.forEach { close(it.socket) }
        streams.clear()
        udpSockets.values.forEach { it.close() }
        udpSockets.clear()
    }

    fun stop() {
        try { server?.close() } catch (_: Exception) {}
        stopStreams()
        executor.shutdownNow()
    }
}

private fun InputStream.readFully(bytes: ByteArray) {
    var offset = 0
    while (offset < bytes.size) {
        val n = read(bytes, offset, bytes.size - offset)
        if (n < 0) throw EOFException()
        offset += n
    }
}