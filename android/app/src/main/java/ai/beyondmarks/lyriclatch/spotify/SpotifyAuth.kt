package ai.beyondmarks.lyriclatch.spotify

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Base64
import ai.beyondmarks.lyriclatch.data.ConfigStore
import ai.beyondmarks.lyriclatch.net.Http
import org.json.JSONObject
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom

class SpotifyAuth(private val store: ConfigStore) {
    fun begin(activity: Activity) {
        val clientId = store.settings().spotifyClientId
        require(clientId.isNotBlank()) { "Enter your Spotify Client ID first" }
        val verifier = randomUrlSafe(64)
        val state = randomUrlSafe(24)
        val challenge = Base64.encodeToString(
            MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()),
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        )
        store.put(ConfigStore.KEY_PKCE_VERIFIER, verifier)
        store.put(ConfigStore.KEY_OAUTH_STATE, state)
        val query = formEncode(
            mapOf(
                "client_id" to clientId,
                "response_type" to "code",
                "redirect_uri" to REDIRECT_URI,
                "scope" to SCOPES,
                "code_challenge_method" to "S256",
                "code_challenge" to challenge,
                "state" to state,
            ),
        )
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://accounts.spotify.com/authorize?$query")))
    }

    fun complete(uri: Uri) {
        uri.getQueryParameter("error")?.let { throw IllegalStateException("Spotify authorization failed: $it") }
        val state = uri.getQueryParameter("state") ?: throw IllegalStateException("Spotify response has no state")
        require(state == store.get(ConfigStore.KEY_OAUTH_STATE)) { "Spotify authorization state did not match" }
        val code = uri.getQueryParameter("code") ?: throw IllegalStateException("Spotify response has no code")
        val response = Http.requireSuccess(
            Http.request(
                "POST",
                "https://accounts.spotify.com/api/token",
                body = formEncode(
                    mapOf(
                        "client_id" to store.settings().spotifyClientId,
                        "grant_type" to "authorization_code",
                        "code" to code,
                        "redirect_uri" to REDIRECT_URI,
                        "code_verifier" to store.get(ConfigStore.KEY_PKCE_VERIFIER),
                    ),
                ).toByteArray(),
                contentType = "application/x-www-form-urlencoded",
            ),
            "Spotify token exchange failed",
        )
        saveTokens(JSONObject(response.text()))
    }

    fun accessToken(): String {
        val token = store.get(ConfigStore.KEY_ACCESS_TOKEN)
        val expiry = store.get(ConfigStore.KEY_TOKEN_EXPIRY).toLongOrNull() ?: 0L
        if (token.isNotBlank() && System.currentTimeMillis() < expiry - 60_000) return token
        val refreshToken = store.get(ConfigStore.KEY_REFRESH_TOKEN)
        require(refreshToken.isNotBlank()) { "Connect Spotify first" }
        val response = Http.requireSuccess(
            Http.request(
                "POST",
                "https://accounts.spotify.com/api/token",
                body = formEncode(
                    mapOf(
                        "client_id" to store.settings().spotifyClientId,
                        "grant_type" to "refresh_token",
                        "refresh_token" to refreshToken,
                    ),
                ).toByteArray(),
                contentType = "application/x-www-form-urlencoded",
            ),
            "Spotify token refresh failed",
        )
        return saveTokens(JSONObject(response.text()))
    }

    fun isConnected(): Boolean = store.get(ConfigStore.KEY_REFRESH_TOKEN).isNotBlank()

    private fun saveTokens(json: JSONObject): String {
        val accessToken = json.getString("access_token")
        store.put(ConfigStore.KEY_ACCESS_TOKEN, accessToken)
        json.optString("refresh_token").takeIf { it.isNotBlank() }?.let {
            store.put(ConfigStore.KEY_REFRESH_TOKEN, it)
        }
        val expiresAt = System.currentTimeMillis() + json.optLong("expires_in", 3600) * 1000
        store.put(ConfigStore.KEY_TOKEN_EXPIRY, expiresAt.toString())
        return accessToken
    }

    private fun randomUrlSafe(bytes: Int): String {
        val value = ByteArray(bytes).also(SecureRandom()::nextBytes)
        return Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    companion object {
        const val REDIRECT_URI = "lyriclatch-login://callback"
        private const val SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing"

        fun formEncode(values: Map<String, String>): String = values.entries.joinToString("&") {
            "${URLEncoder.encode(it.key, "UTF-8") }=${URLEncoder.encode(it.value, "UTF-8") }"
        }
    }
}
