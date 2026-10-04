package com.dhegeniusmedia.bridge
import okhttp3.*
import okio.ByteString
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.random.Random
class BridgeRelayClient(private val sessionToken:String,private val role:String,private val secret:String,private val onPacket:(ByteArray)->Unit,private val onState:(String)->Unit){
 private val http=OkHttpClient();private var socket:WebSocket?=null
 private fun key()=MessageDigest.getInstance("SHA-256").digest(secret.toByteArray(Charsets.UTF_8))
 fun connect(){val encoded=java.net.URLEncoder.encode(sessionToken,"UTF-8");val url="wss://dhe-genius-media.onrender.com/api/bridge/relay?token="+encoded+"&role="+role
  socket=http.newWebSocket(Request.Builder().url(url).build(),object:WebSocketListener(){
   override fun onOpen(w:WebSocket,r:Response){onState("RELAY CONNECTED")}
   override fun onMessage(w:WebSocket,t:String){onState(t)}
   override fun onMessage(w:WebSocket,b:ByteString){try{onPacket(decrypt(b.toByteArray()))}catch(_:Exception){onState("RELAY AUTH ERROR")}}
   override fun onFailure(w:WebSocket,t:Throwable,r:Response?){onState("RELAY ERROR: "+(t.message?:"connection failed"))}
   override fun onClosed(w:WebSocket,c:Int,reason:String){onState("RELAY CLOSED")}
  })}
 fun sendFrame(frame:ByteArray)=socket?.send(ByteString.of(*encrypt(frame)))?:false
 fun sendPacket(packet:ByteArray)=sendFrame(packet)
 fun close(){socket?.close(1000,"DGM Bridge disconnect");socket=null;http.dispatcher.executorService.shutdown()}
 private fun encrypt(p:ByteArray):ByteArray{val iv=ByteArray(12).also{kotlin.random.Random.nextBytes(it)};val c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,SecretKeySpec(key(),"AES"),GCMParameterSpec(128,iv));return byteArrayOf(1)+iv+c.doFinal(p)}
 private fun decrypt(f:ByteArray):ByteArray{require(f.size>13&&f[0].toInt()==1);val c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,SecretKeySpec(key(),"AES"),GCMParameterSpec(128,f.copyOfRange(1,13)));return c.doFinal(f.copyOfRange(13,f.size))}
}