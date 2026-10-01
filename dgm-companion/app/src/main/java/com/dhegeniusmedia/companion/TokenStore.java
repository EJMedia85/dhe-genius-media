package com.dhegeniusmedia.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.nio.charset.StandardCharsets;
import android.util.Base64;

public final class TokenStore {
    private static final String PREFS="dgm_companion";
    private static final String TOKEN="token";
    private static final String KEY_ALIAS="DGM_COMPANION_KEY";
    private TokenStore(){}

    private static SecretKey key() throws Exception {
        var ks=java.security.KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if(!ks.containsAlias(KEY_ALIAS)){
            KeyGenerator kg=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            kg.generateKey();
        }
        return ((java.security.KeyStore.SecretKeyEntry)ks.getEntry(KEY_ALIAS,null)).getSecretKey();
    }

    public static void save(Context c,String token) throws Exception {
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE,key());
        byte[] cipherText=cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        String packed=Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(cipherText,Base64.NO_WRAP);
        c.getSharedPreferences(PREFS,Context.MODE_PRIVATE).edit().putString(TOKEN,packed).apply();
    }

    public static String get(Context c){
        try{
            String packed=c.getSharedPreferences(PREFS,Context.MODE_PRIVATE).getString(TOKEN,null);
            if(packed==null)return null;
            String[] p=packed.split(":",2);
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(p[0],Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(p[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);
        }catch(Exception e){return null;}
    }

    public static void clear(Context c){c.getSharedPreferences(PREFS,Context.MODE_PRIVATE).edit().remove(TOKEN).apply();}
}
