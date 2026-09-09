package ai.beyondmarks.lyriclatch.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import ai.beyondmarks.lyriclatch.BuildConfig
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class AppSettings(
    val spotifyClientId: String,
    val sarvamApiKey: String,
    val youtubeApiKey: String,
    val backendUrl: String,
    val backendToken: String,
)

class ConfigStore private constructor(context: Context) {
    private val preferences = context.getSharedPreferences("lyriclatch_secure", Context.MODE_PRIVATE)
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun settings() = AppSettings(
        spotifyClientId = get(KEY_SPOTIFY_CLIENT_ID).ifBlank { BuildConfig.SPOTIFY_CLIENT_ID },
        sarvamApiKey = get(KEY_SARVAM_API_KEY),
        youtubeApiKey = get(KEY_YOUTUBE_API_KEY),
        backendUrl = BuildConfig.BACKEND_URL.ifBlank { get(KEY_BACKEND_URL) }.trimEnd('/'),
        backendToken = BuildConfig.BACKEND_TOKEN,
    )

    fun put(name: String, value: String) {
        if (value.isBlank()) {
            preferences.edit().remove(name).apply()
            return
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
        val ciphertext = cipher.doFinal(value.trim().toByteArray(Charsets.UTF_8))
        val packed = cipher.iv + ciphertext
        preferences.edit().putString(name, Base64.encodeToString(packed, Base64.NO_WRAP)).apply()
    }

    fun get(name: String): String {
        val encoded = preferences.getString(name, null) ?: return ""
        return runCatching {
            val packed = Base64.decode(encoded, Base64.NO_WRAP)
            require(packed.size > IV_BYTES)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                encryptionKey(),
                GCMParameterSpec(128, packed.copyOfRange(0, IV_BYTES)),
            )
            cipher.doFinal(packed.copyOfRange(IV_BYTES, packed.size)).toString(Charsets.UTF_8)
        }.getOrDefault("")
    }

    fun clearSpotifySession() {
        preferences.edit()
            .remove(KEY_ACCESS_TOKEN)
            .remove(KEY_REFRESH_TOKEN)
            .remove(KEY_TOKEN_EXPIRY)
            .remove(KEY_PKCE_VERIFIER)
            .remove(KEY_OAUTH_STATE)
            .apply()
    }

    private fun encryptionKey(): SecretKey {
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generateKey()
        }
    }

    companion object {
        const val KEY_SPOTIFY_CLIENT_ID = "spotify_client_id"
        const val KEY_SARVAM_API_KEY = "sarvam_api_key"
        const val KEY_YOUTUBE_API_KEY = "youtube_api_key"
        const val KEY_BACKEND_URL = "backend_url"
        const val KEY_ACCESS_TOKEN = "spotify_access_token"
        const val KEY_REFRESH_TOKEN = "spotify_refresh_token"
        const val KEY_TOKEN_EXPIRY = "spotify_token_expiry"
        const val KEY_PKCE_VERIFIER = "spotify_pkce_verifier"
        const val KEY_OAUTH_STATE = "spotify_oauth_state"

        private const val KEY_ALIAS = "lyriclatch-config-v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12

        @Volatile private var instance: ConfigStore? = null

        fun get(context: Context): ConfigStore = instance ?: synchronized(this) {
            instance ?: ConfigStore(context.applicationContext).also { instance = it }
        }
    }
}
