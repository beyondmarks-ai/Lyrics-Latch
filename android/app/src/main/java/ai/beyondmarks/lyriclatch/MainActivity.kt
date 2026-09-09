package ai.beyondmarks.lyriclatch

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import ai.beyondmarks.lyriclatch.data.ConfigStore
import ai.beyondmarks.lyriclatch.spotify.SpotifyAuth
import ai.beyondmarks.lyriclatch.voice.VoiceRuntime
import ai.beyondmarks.lyriclatch.voice.VoiceState
import ai.beyondmarks.lyriclatch.voice.WakeWordService
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var spotifyClientId: EditText
    private lateinit var voiceStatus: TextView
    private lateinit var spotifyStatus: TextView
    private lateinit var nowPlaying: TextView
    private var startAfterPermission = false
    private val voiceListener: (VoiceState) -> Unit = { state -> runOnUiThread { showVoiceState(state) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppGraph.initialize(this)
        setContentView(buildScreen())
        loadSettings()
        VoiceRuntime.addListener(voiceListener)
        AppGraph.spotify.addStateListener { track ->
            runOnUiThread {
                nowPlaying.text = track?.let { "${it.name}\n${it.artist}" } ?: "Nothing playing"
                spotifyStatus.text = if (AppGraph.spotify.isRemoteConnected()) "Spotify connected" else "Spotify not connected"
                spotifyStatus.setTextColor(if (AppGraph.spotify.isRemoteConnected()) CYAN else MUTED)
            }
        }
        handleAuthCallback(intent?.data)
        if (AppGraph.auth.isConnected()) connectRemote(false, startListener = true)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAuthCallback(intent.data)
    }

    private fun buildScreen(): View {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(22), dp(34), dp(22), dp(48))
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                intArrayOf(Color.rgb(25, 17, 58), MIDNIGHT, Color.rgb(4, 16, 27)),
            )
        }

        content.addView(ImageView(this).apply {
            setImageResource(R.drawable.lyriclatch_logo)
            scaleType = ImageView.ScaleType.CENTER_CROP
        }, LinearLayout.LayoutParams(dp(132), dp(132)).apply { bottomMargin = dp(12) })
        content.addView(label("LYRICLATCH", 13f, VIOLET, Typeface.BOLD).apply { letterSpacing = 0.16f })
        content.addView(label("Say it. Find it. Loop it.", 31f, Color.WHITE, Typeface.BOLD).apply {
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(8))
        })
        content.addView(label("Offline wake-word control for Spotify, with multilingual song search and precise lyric loops.", 16f, MUTED).apply {
            gravity = Gravity.CENTER
            setPadding(dp(8), 0, dp(8), dp(24))
        })

        voiceStatus = statusCard("Voice listener is off")
        spotifyStatus = statusCard("Spotify not connected")
        nowPlaying = statusCard("Nothing playing")
        content.addView(voiceStatus)
        content.addView(spotifyStatus)
        content.addView(nowPlaying)

        content.addView(sectionTitle("Voice controls"))
        content.addView(row(
            actionButton("Start listening") { requestVoiceStart() },
            actionButton("Stop") { stopVoice() },
        ))
        content.addView(row(
            actionButton("Previous") { runCommand { AppGraph.spotify.previous() } },
            actionButton("Play / pause") {
                runCommand {
                    if (AppGraph.spotify.currentTrack()?.paused == false) AppGraph.spotify.pause() else AppGraph.spotify.resume()
                }
            },
            actionButton("Next") { runCommand { AppGraph.spotify.next() } },
        ))

        content.addView(sectionTitle("Spotify setup"))
        content.addView(label(
            "One-time setup: enter the public Client ID registered for ai.beyondmarks.lyriclatch and lyriclatch-login://callback. Transcription and song search are configured automatically.",
            13f,
            MUTED,
        ).apply { setPadding(dp(4), 0, dp(4), dp(12)) })
        spotifyClientId = input("Spotify Client ID", secret = false)
        content.addView(spotifyClientId)
        content.addView(actionButton("Connect Spotify") { saveSettings(); authorizeSpotify() })

        content.addView(label(
            "Keep LyricLatch’s notification visible while listening. Android requires this for background microphone access.",
            12f,
            MUTED,
        ).apply { setPadding(dp(8), dp(18), dp(8), 0); gravity = Gravity.CENTER })

        return ScrollView(this).apply {
            isFillViewport = true
            addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        }
    }

    private fun requestVoiceStart() {
        saveSettings()
        val missing = buildList {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (missing.isNotEmpty()) {
            startAfterPermission = true
            requestPermissions(missing.toTypedArray(), REQUEST_PERMISSIONS)
        } else {
            startVoice()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_PERMISSIONS && startAfterPermission) {
            startAfterPermission = false
            if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) startVoice()
            else toast("Microphone and notification permissions are required")
        }
    }

    private fun startVoice() {
        val settings = AppGraph.store.settings()
        if (settings.backendUrl.isBlank()) {
            toast("This build is missing its managed service configuration")
            return
        }
        startForegroundService(Intent(this, WakeWordService::class.java).setAction(WakeWordService.ACTION_START))
    }

    private fun stopVoice() {
        startService(Intent(this, WakeWordService::class.java).setAction(WakeWordService.ACTION_STOP))
    }

    private fun authorizeSpotify() {
        if (AppGraph.store.settings().spotifyClientId.isBlank()) {
            toast("Enter the public Spotify Client ID first")
            return
        }
        runCatching { AppGraph.auth.begin(this) }.onFailure { toast(it.message ?: "Could not start Spotify login") }
    }

    private fun handleAuthCallback(uri: Uri?) {
        if (uri?.scheme != "lyriclatch-login") return
        spotifyStatus.setText(R.string.spotify_authorizing)
        executor.execute {
            runCatching { AppGraph.auth.complete(uri) }
                .onSuccess { runOnUiThread { connectRemote(true, startListener = true) } }
                .onFailure { runOnUiThread { toast(it.message ?: "Spotify authorization failed") } }
        }
    }

    private fun connectRemote(showAuth: Boolean, startListener: Boolean = false) {
        spotifyStatus.setText(R.string.spotify_connecting)
        AppGraph.spotify.connect(showAuth) { result ->
            runOnUiThread {
                result.onSuccess {
                    spotifyStatus.setText(R.string.spotify_connected)
                    spotifyStatus.setTextColor(CYAN)
                    if (startListener) requestVoiceStart()
                }.onFailure {
                    spotifyStatus.setText(R.string.spotify_connection_failed)
                    spotifyStatus.setTextColor(ERROR)
                    toast(it.message ?: "Spotify connection failed")
                }
            }
        }
    }

    private fun loadSettings() {
        val settings = AppGraph.store.settings()
        spotifyClientId.setText(settings.spotifyClientId)
    }

    private fun saveSettings() {
        AppGraph.store.put(ConfigStore.KEY_SPOTIFY_CLIENT_ID, spotifyClientId.text.toString())
    }

    private fun showVoiceState(state: VoiceState) {
        voiceStatus.text = state.message
        voiceStatus.setTextColor(if (state.error) ERROR else if (state.running) CYAN else MUTED)
    }

    private fun runCommand(block: () -> Unit) {
        executor.execute {
            runCatching(block).onFailure { runOnUiThread { toast(it.message ?: "Spotify command failed") } }
        }
    }

    private fun sectionTitle(text: String) = label(text, 20f, Color.WHITE, Typeface.BOLD).apply {
        setPadding(dp(2), dp(26), 0, dp(10))
        gravity = Gravity.START
    }

    private fun statusCard(text: String) = label(text, 15f, MUTED, Typeface.BOLD).apply {
        setPadding(dp(18), dp(16), dp(18), dp(16))
        background = rounded(Color.rgb(19, 22, 45), 18f, Color.rgb(48, 55, 91))
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            bottomMargin = dp(9)
        }
    }

    private fun input(hintText: String, secret: Boolean = true) = EditText(this).apply {
        hint = hintText
        setHintTextColor(Color.rgb(122, 132, 160))
        setTextColor(Color.WHITE)
        textSize = 14f
        setSingleLine(true)
        setPadding(dp(16), dp(13), dp(16), dp(13))
        background = rounded(Color.rgb(16, 19, 39), 14f, Color.rgb(54, 61, 99))
        inputType = if (secret) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(9) }
    }

    private fun row(vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER
        views.forEach { view -> addView(view, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { setMargins(dp(4), dp(4), dp(4), dp(4)) }) }
    }

    private fun actionButton(text: String, click: () -> Unit) = Button(this).apply {
        this.text = text
        isAllCaps = false
        setTextColor(Color.WHITE)
        textSize = 13f
        typeface = Typeface.DEFAULT_BOLD
        setPadding(dp(8), dp(12), dp(8), dp(12))
        background = rounded(Color.rgb(73, 53, 160), 22f, VIOLET)
        setOnClickListener { click() }
    }

    private fun label(text: String, size: Float, color: Int, style: Int = Typeface.NORMAL) = TextView(this).apply {
        this.text = text
        textSize = size
        setTextColor(color)
        setTypeface(Typeface.DEFAULT, style)
    }

    private fun rounded(fill: Int, radius: Float, stroke: Int) = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        setColor(fill)
        cornerRadius = dp(radius.toInt()).toFloat()
        setStroke(dp(1), stroke)
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    override fun onDestroy() {
        VoiceRuntime.removeListener(voiceListener)
        executor.shutdownNow()
        super.onDestroy()
    }

    companion object {
        private const val REQUEST_PERMISSIONS = 42
        private val MIDNIGHT = Color.rgb(7, 8, 20)
        private val VIOLET = Color.rgb(139, 92, 246)
        private val CYAN = Color.rgb(34, 211, 238)
        private val MUTED = Color.rgb(169, 177, 199)
        private val ERROR = Color.rgb(248, 113, 113)
    }
}
