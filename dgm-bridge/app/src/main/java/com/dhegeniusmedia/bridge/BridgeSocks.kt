package com.dhegeniusmedia.bridge
import java.io.*
import java.net.*
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

class BridgeSocks(private val relay: BridgeRelayClient, private val hostMode: Boolean, private val port:Int=10808) {
    private val executor=Executors.newCachedThreadPool()
    private val streams=ConcurrentHashMap<Int,Stream>()
    private val nextId=AtomicInteger(1)
    @Volatile private var server:ServerSocket?=null
    private data class Stream(val socket:Socket,val input:BufferedInputStream,val output:BufferedOutputStream)

    fun start() {
        if(hostMode)return
        server=ServerSocket(port,64,InetAddress.getByName("127.0.0.1"))
        executor.execute {
            while(server?.isClosed==false) try { executor.execute{clientHandshake(server!!.accept())} } catch(_:Exception){break}
        }
    }
    fun onFrame(frame:ByteArray) {
        val p=try{BridgeMux.parse(frame)}catch(_:Exception){return}
        when(p.type){
            BridgeMux.OPEN->if(hostMode)executor.execute{openRemote(p.id,p.payload)}
            BridgeMux.OPEN_OK->streams[p.id]?.socket?.let{sendClientReply(it,0)}
            BridgeMux.OPEN_FAIL->streams.remove(p.id)?.let{close(it.socket)}
            BridgeMux.DATA->streams[p.id]?.let{write(it.output,p.payload)}
            BridgeMux.CLOSE->streams.remove(p.id)?.let{close(it.socket)}
        }
    }
    private fun clientHandshake(socket:Socket){
        val input=BufferedInputStream(socket.getInputStream()); val output=BufferedOutputStream(socket.getOutputStream())
        try{
            if(input.read()!=5)throw IOException()
            val n=input.read(); if(n<0)throw IOException(); repeat(n){input.read()}
            output.write(byteArrayOf(5,0));output.flush()
            if(input.read()!=5||input.read()!=1)throw IOException()
            input.read();input.read();val atyp=input.read()
            val host=when(atyp){
                1->ByteArray(4).also{input.readFully(it)}.joinToString("."){(it.toInt()and 255).toString()}
                3->{val len=input.read();ByteArray(len).also{input.readFully(it)}.toString(Charsets.UTF_8)}
                4->ByteArray(16).also{input.readFully(it)}.let{InetAddress.getByAddress(it).hostAddress}
                else->throw IOException()
            }
            val pb=ByteArray(2);input.readFully(pb);val dstPort=ByteBuffer.wrap(pb).short.toInt()and 65535
            val id=nextId.getAndIncrement();streams[id]=Stream(socket,input,output)
            val hb=host.toByteArray(Charsets.UTF_8)
            relay.sendFrame(BridgeMux.frame(BridgeMux.OPEN,id,ByteBuffer.allocate(2+hb.size+2).putShort(hb.size.toShort()).put(hb).putShort(dstPort.toShort()).array()))
            executor.execute{readClient(id)}
        }catch(_:Exception){close(socket)}
    }
    private fun readClient(id:Int){
        val s=streams[id]?:return;val buf=ByteArray(32768)
        try{while(!s.socket.isClosed){val n=s.input.read(buf);if(n<0)break;if(n>0)relay.sendFrame(BridgeMux.frame(BridgeMux.DATA,id,buf.copyOf(n)))}}catch(_:Exception){}
        finally{relay.sendFrame(BridgeMux.frame(BridgeMux.CLOSE,id));streams.remove(id);close(s.socket)}
    }
    private fun openRemote(id:Int,payload:ByteArray){
        try{
            val b=ByteBuffer.wrap(payload);val len=b.short.toInt()and 65535;val hb=ByteArray(len);b.get(hb);val port=b.short.toInt()and 65535
            val socket=Socket();socket.connect(InetSocketAddress(String(hb,Charsets.UTF_8),port),10000)
            streams[id]=Stream(socket,BufferedInputStream(socket.getInputStream()),BufferedOutputStream(socket.getOutputStream()))
            relay.sendFrame(BridgeMux.frame(BridgeMux.OPEN_OK,id));executor.execute{readRemote(id)}
        }catch(_:Exception){relay.sendFrame(BridgeMux.frame(BridgeMux.OPEN_FAIL,id))}
    }
    private fun readRemote(id:Int){
        val s=streams[id]?:return;val buf=ByteArray(32768)
        try{while(!s.socket.isClosed){val n=s.input.read(buf);if(n<0)break;if(n>0)relay.sendFrame(BridgeMux.frame(BridgeMux.DATA,id,buf.copyOf(n)))}}catch(_:Exception){}
        finally{relay.sendFrame(BridgeMux.frame(BridgeMux.CLOSE,id));streams.remove(id);close(s.socket)}
    }
    private fun sendClientReply(socket:Socket,code:Int){try{val o=BufferedOutputStream(socket.getOutputStream());o.write(byteArrayOf(5,code.toByte(),0,1,0,0,0,0,0,0));o.flush()}catch(_:Exception){close(socket)}}
    private fun write(out:BufferedOutputStream,bytes:ByteArray){try{synchronized(out){out.write(bytes);out.flush()}}catch(_:Exception){}}
    private fun close(s:Socket){try{s.close()}catch(_:Exception){}}
    fun stopStreams(){streams.values.forEach{close(it.socket)};streams.clear()}
    fun stop(){try{server?.close()}catch(_:Exception){};stopStreams();executor.shutdownNow()}
}
private fun InputStream.readFully(bytes:ByteArray){var o=0;while(o<bytes.size){val n=read(bytes,o,bytes.size-o);if(n<0)throw EOFException();o+=n}}
