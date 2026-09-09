package ai.beyondmarks.lyriclatch.spotify

import android.content.Context
import android.os.SystemClock
import ai.beyondmarks.lyriclatch.data.ConfigStore
import ai.beyondmarks.lyriclatch.net.Http
import com.spotify.android.appremote.api.ConnectionParams
import com.spotify.android.appremote.api.Connector
import com.spotify.android.appremote.api.SpotifyAppRemote
import com.spotify.protocol.client.Subscription
import com.spotify.protocol.types.PlayerState
import com.spotify.protocol.types.Repeat
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.CopyOnWriteArrayList

data class TrackSnapshot(
    val uri: String,
    val name: String,
    val artist: String,
    val album: String,
    val durationMs: Long,
    val positionMs: Long,
    val paused: Boolean,
    val repeatMode: Int,
)

data class SpotifyTrackResult(val uri: String, val name: String, val artist: String)

class SpotifyController(
    private val context: Context,
    private val store: ConfigStore,
    private val auth: SpotifyAuth,
) {
    @Volatile private var remote: SpotifyAppRemote? = null
    @Volatile private var snapshot: TrackSnapshot? = null
    @Volatile private var snapshotAt = 0L
    private var playerSubscription: Subscription<PlayerState>? = null
    private val stateListeners = CopyOnWriteArrayList<(TrackSnapshot?) -> Unit>()

    fun connect(showAuthView: Boolean, callback: (Result<Unit>) -> Unit) {
        if (remote?.isConnected == true) {
            callback(Result.success(Unit))
            return
        }
        val clientId = store.settings().spotifyClientId
        if (clientId.isBlank()) {
            callback(Result.failure(IllegalStateException("Enter your Spotify Client ID first")))
            return
        }
        if (!SpotifyAppRemote.isSpotifyInstalled(context)) {
            callback(Result.failure(IllegalStateException("Install and sign in to the Spotify app first")))
            return
        }
        remote?.let(SpotifyAppRemote::disconnect)
        val params = ConnectionParams.Builder(clientId)
            .setRedirectUri(SpotifyAuth.REDIRECT_URI)
            .showAuthView(showAuthView)
            .build()
        SpotifyAppRemote.connect(context, params, object : Connector.ConnectionListener {
            override fun onConnected(appRemote: SpotifyAppRemote) {
                remote = appRemote
                subscribeToPlayer()
                callback(Result.success(Unit))
            }

            override fun onFailure(error: Throwable) = callback(Result.failure(error))
        })
    }

    fun disconnect() {
        playerSubscription?.cancel()
        playerSubscription = null
        remote?.let(SpotifyAppRemote::disconnect)
        remote = null
        snapshot = null
        stateListeners.forEach { it(null) }
    }

    fun isRemoteConnected() = remote?.isConnected == true
    fun isWebConnected() = auth.isConnected()
    fun currentTrack() = snapshot

    fun estimatedPositionMs(): Long {
        val state = snapshot ?: return 0
        if (state.paused) return state.positionMs
        return (state.positionMs + SystemClock.elapsedRealtime() - snapshotAt).coerceAtMost(state.durationMs)
    }

    fun addStateListener(listener: (TrackSnapshot?) -> Unit) {
        stateListeners += listener
        listener(snapshot)
    }

    fun pause() = playerApi().pause()
    fun resume() = playerApi().resume()
    fun next() = playerApi().skipNext()

    fun previous() {
        playerApi().seekTo(0)
        Thread.sleep(160)
        playerApi().skipPrevious()
        Thread.sleep(160)
        playerApi().resume()
    }

    fun seekTo(positionMs: Long) = playerApi().seekTo(positionMs.coerceAtLeast(0))
    fun seekRelative(deltaMs: Long) = playerApi().seekToRelativePosition(deltaMs)
    fun setRepeat(mode: Int) = playerApi().setRepeat(mode)
    fun playUri(uri: String) = playerApi().play(uri)

    fun setVolume(percent: Int) {
        webRequest("PUT", "/v1/me/player/volume?volume_percent=${percent.coerceIn(0, 100)}")
    }

    fun searchTrack(query: String): SpotifyTrackResult? {
        val response = webRequest(
            "GET",
            "/v1/search?q=${URLEncoder.encode(query, "UTF-8")}&type=track&limit=5",
        )
        val items = JSONObject(response).optJSONObject("tracks")?.optJSONArray("items") ?: return null
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            val uri = item.optString("uri")
            if (uri.isBlank()) continue
            val artists = item.optJSONArray("artists")
            val artist = buildList {
                if (artists != null) for (i in 0 until artists.length()) {
                    artists.optJSONObject(i)?.optString("name")?.takeIf(String::isNotBlank)?.let(::add)
                }
            }.joinToString(", ")
            return SpotifyTrackResult(uri, item.optString("name"), artist)
        }
        return null
    }

    private fun subscribeToPlayer() {
        playerSubscription?.cancel()
        val subscription = playerApi().subscribeToPlayerState()
        subscription.setEventCallback { state ->
                val track = state.track
                snapshot = TrackSnapshot(
                    uri = track.uri,
                    name = track.name,
                    artist = track.artists.joinToString(", ") { it.name },
                    album = track.album.name,
                    durationMs = track.duration,
                    positionMs = state.playbackPosition,
                    paused = state.isPaused,
                    repeatMode = state.playbackOptions.repeatMode,
                )
                snapshotAt = SystemClock.elapsedRealtime()
                stateListeners.forEach { it(snapshot) }
            }
        subscription.setErrorCallback { stateListeners.forEach { it(snapshot) } }
        playerSubscription = subscription
    }

    private fun playerApi() = remote?.takeIf { it.isConnected }?.playerApi
        ?: throw IllegalStateException("Connect Spotify before using playback commands")

    private fun webRequest(method: String, path: String): String {
        val token = auth.accessToken()
        val response = Http.request(
            method,
            "https://api.spotify.com$path",
            headers = mapOf("Authorization" to "Bearer $token"),
        )
        return Http.requireSuccess(response, "Spotify request failed").text()
    }
}
