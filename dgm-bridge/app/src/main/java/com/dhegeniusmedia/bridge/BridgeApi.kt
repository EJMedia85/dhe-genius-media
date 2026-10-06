package com.dhegeniusmedia.bridge

import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class BridgeApi(private val baseUrl: String = "https://dhe-genius-media.onrender.com") {
    private val cookieStore = mutableMapOf<String, MutableList<Cookie>>()

    private val cookieJar = object : CookieJar {
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            cookieStore[url.host] = cookies.toMutableList()
        }

        override fun loadForRequest(url: HttpUrl): List<Cookie> {
            return cookieStore[url.host].orEmpty()
        }
    }

    private val client = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonType = "application/json".toMediaType()

    var authToken: String? = null
        private set

    fun adminLogin(email: String, password: String): JSONObject {
        return post(
            "/api/admin/login",
            JSONObject()
                .put("email", email)
                .put("password", password)
        )
    }

    fun register(
        deviceId: String,
        role: String,
        publicKey: String,
        country: String = "unknown"
    ): JSONObject {
        val body = JSONObject()
            .put("device_id", deviceId)
            .put("role", role)
            .put("public_key", publicKey)
            .put("country", country)

        val result = post("/api/bridge/register", body)
        authToken = result.optString("token").ifBlank { authToken }
        return result
    }

    fun registrationStatus(deviceId: String): JSONObject {
        val encoded = URLEncoder.encode(deviceId, "UTF-8")
        val result = get("/api/bridge/registration-status?device_id=$encoded")
        result.optString("token")
            .takeIf { it.isNotBlank() }
            ?.let { authToken = it }
        return result
    }

    private fun get(path: String): JSONObject {
        val request = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .get()
            .build()

        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val obj = if (text.isBlank()) JSONObject() else JSONObject(text)

            if (!response.isSuccessful || !obj.optBoolean("success", false)) {
                throw IllegalStateException(
                    obj.optString("message", "DGM Bridge request failed")
                )
            }
            return obj
        }
    }

    fun createPairing(): JSONObject {
        return post("/api/bridge/pair/create", JSONObject(), auth = true)
    }

    fun claimPairing(code: String, secret: String): JSONObject {
        return post(
            "/api/bridge/pair/claim",
            JSONObject()
                .put("code", code)
                .put("secret", secret),
            auth = true
        )
    }

    private fun post(
        path: String,
        body: JSONObject,
        auth: Boolean = false
    ): JSONObject {
        val builder = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .post(body.toString().toRequestBody(jsonType))

        if (auth) {
            authToken?.let { builder.header("Authorization", "Bearer $it") }
        }

        client.newCall(builder.build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val obj = if (text.isBlank()) JSONObject() else JSONObject(text)

            if (!response.isSuccessful || !obj.optBoolean("success", false)) {
                throw IllegalStateException(
                    obj.optString("message", "DGM Bridge request failed")
                )
            }
            return obj
        }
    }
}
