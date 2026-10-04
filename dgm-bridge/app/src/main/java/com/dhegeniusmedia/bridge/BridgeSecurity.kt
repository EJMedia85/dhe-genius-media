package com.dhegeniusmedia.bridge

import android.content.Context
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest

object BridgeSecurity {
    private const val ALIAS = "dgm_bridge_device_identity"
    private const val STORE = "AndroidKeyStore"

    fun publicKey(context: Context): String {
        val ks = KeyStore.getInstance(STORE).apply { load(null) }
        if (!ks.containsAlias(ALIAS)) {
            val gen = KeyPairGenerator.getInstance("RSA", STORE)
            gen.initialize(2048)
            gen.generateKeyPair().also {
                // AndroidKeyStore associates the generated key with ALIAS via the
                // generator parameter below; this branch is replaced by ensureIdentity().
            }
        }
        return ensureIdentity().public.encoded.let { Base64.encodeToString(it, Base64.NO_WRAP) }
    }

    private fun ensureIdentity(): java.security.KeyPair {
        val ks = KeyStore.getInstance(STORE).apply { load(null) }
        if (ks.containsAlias(ALIAS)) {
            return java.security.KeyPair(ks.getCertificate(ALIAS).publicKey, ks.getKey(ALIAS, null) as java.security.PrivateKey)
        }
        val spec = android.security.keystore.KeyGenParameterSpec.Builder(
            ALIAS,
            android.security.keystore.KeyProperties.PURPOSE_SIGN or android.security.keystore.KeyProperties.PURPOSE_VERIFY
        )
            .setDigests(android.security.keystore.KeyProperties.DIGEST_SHA256)
            .setSignaturePaddings(android.security.keystore.KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
            .build()
        val gen = KeyPairGenerator.getInstance("RSA", STORE)
        gen.initialize(spec)
        return gen.generateKeyPair()
    }

    fun fingerprint(context: Context): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(ensureIdentity().public.encoded)
        return digest.joinToString(":") { "%02X".format(it) }.take(47)
    }
}
