package com.dhegeniusmedia.bridge
import java.nio.ByteBuffer
object BridgeMux {
    const val OPEN: Byte = 1
    const val OPEN_OK: Byte = 2
    const val OPEN_FAIL: Byte = 3
    const val DATA: Byte = 4
    const val CLOSE: Byte = 5
    const val UDP: Byte = 6
    fun frame(type: Byte, id: Int, payload: ByteArray = ByteArray(0)): ByteArray {
        val out = ByteBuffer.allocate(10 + payload.size)
        out.put(1).put(type).putInt(id).putInt(payload.size).put(payload)
        return out.array()
    }
    data class Parsed(val type: Byte, val id: Int, val payload: ByteArray)
    fun parse(bytes: ByteArray): Parsed {
        require(bytes.size >= 10 && bytes[0].toInt() == 1)
        val b = ByteBuffer.wrap(bytes); b.get()
        val type=b.get(); val id=b.int; val length=b.int
        require(length >= 0 && length == b.remaining())
        return Parsed(type,id,ByteArray(length).also{b.get(it)})
    }
}
