package com.dhegeniusmedia.bridge

import android.content.Context
import android.util.Base64
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest

object BridgeSecurity {
    private const val ALIAS = "dgm_bridge_device_identity"
    private const val STORE = "AndroidKeyStore"

    private fun ensureIdentity(): KeyPair {
        val ks = KeyStore.getInstance(STORE).apply { load(null) }
        if (ks.containsAlias(ALIAS)) {
            return KeyPair(ks.getCertificate(ALIAS).publicKey, ks.getKey(ALIAS, null) as java.security.PrivateKey)
        }
        val spec = android.security.keystore.KeyGenParameterSpec.Builder(
            ALIAS,
            android.security.keystore.KeyProperties.PURPOSE_SIGN or
                android.security.keystore.KeyProperties.PURPOSE_VERIFY
        )
            .setDigests(android.security.keystore.KeyProperties.DIGEST_SHA256)
            .setSignaturePaddings(android.security.keystore.KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
            .build()
        return KeyPairGenerator.getInstance("RSA", STORE).apply { initialize(spec) }.generateKeyPair()
    }

    fun publicKey(context: Context): String =
        Base64.encodeToString(ensureIdentity().public.encoded, Base64.NO_WRAP)

    fun fingerprint(context: Context): String =
        MessageDigest.getInstance("SHA-256").digest(ensureIdentity().public.encoded)
            .joinToString(":") { "%02X".format(it) }.take(47)
}
