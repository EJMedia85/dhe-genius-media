package com.dhegeniusmedia.sms;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class SecureTokenStore {
    private static final String KS="AndroidKeyStore", ALIAS="dgm_device_token_v1", PREF="dgm_secure";
    private SecureTokenStore(){}
    private static SecretKey key() throws Exception {
        KeyStore ks=KeyStore.getInstance(KS); ks.load(null);
        if(!ks.containsAlias(ALIAS)){
            KeyGenerator kg=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,KS);
            kg.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            kg.generateKey();
        }
        return ((KeyStore.SecretKeyEntry)ks.getEntry(ALIAS,null)).getSecretKey();
    }
    public static void put(Context c,String value){
        try{
            if(value==null||value.isEmpty()){clear(c);return;}
            Cipher cp=Cipher.getInstance("AES/GCM/NoPadding"); cp.init(Cipher.ENCRYPT_MODE,key());
            String blob=Base64.encodeToString(cp.getIV(),Base64.NO_WRAP)+"."+Base64.encodeToString(cp.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
            c.getSharedPreferences(PREF,Context.MODE_PRIVATE).edit().putString("token",blob).apply();
        }catch(Exception ignored){}
    }
    public static String get(Context c){
        try{
            String blob=c.getSharedPreferences(PREF,Context.MODE_PRIVATE).getString("token","");
            if(blob.isEmpty()) {
                String legacy=c.getSharedPreferences("dgm_sms",Context.MODE_PRIVATE).getString("token","");
                if(legacy!=null&&!legacy.isEmpty()){ put(c,legacy); return legacy; }
                return "";
            }
            String[] p=blob.split("\\.",2); if(p.length!=2)return "";
            Cipher cp=Cipher.getInstance("AES/GCM/NoPadding");
            cp.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(p[0],Base64.NO_WRAP)));
            return new String(cp.doFinal(Base64.decode(p[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);
        }catch(Exception e){return "";}
    }
    public static void clear(Context c){c.getSharedPreferences(PREF,Context.MODE_PRIVATE).edit().remove("token").apply();}
}
