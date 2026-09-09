package ai.beyondmarks.lyriclatch.voice

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import ai.beyondmarks.lyriclatch.AppGraph
import ai.beyondmarks.lyriclatch.MainActivity
import ai.beyondmarks.lyriclatch.R
import ai.beyondmarks.lyriclatch.commands.CommandResult
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class WakeWordService : Service() {
    private enum class Mode { WAKING, COMMAND, PROCESSING, FOLLOW_UP }

    private val alive = AtomicBoolean(false)
    private val worker = Executors.newSingleThreadExecutor()
    private var audioThread: Thread? = null
    private var recorder: AudioRecord? = null
    private var wakeWord: WakeWordEngine? = null
    private var vad: SileroVad? = null
    private var tts: TextToSpeech? = null
    @Volatile private var ttsReady = false
    @Volatile private var mode = Mode.WAKING
    private var speechStarted = false
    private var silenceFrames = 0
    private var captureFrames = 0
    private val capture = mutableListOf<ShortArray>()
    private var lastDetectionAt = 0L

    override fun onCreate() {
        super.onCreate()
        AppGraph.initialize(this)
        createChannel()
        startAsForeground(notification("Starting offline wake-word model…"))
        tts = TextToSpeech(this) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) {
                tts?.language = Locale.forLanguageTag("en-IN")
                tts?.setSpeechRate(1.02f)
            }
        }.also { engine ->
            engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = Unit
                @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
                override fun onError(utteranceId: String?) = onDone(utteranceId)
                override fun onDone(utteranceId: String?) {
                    if (utteranceId?.startsWith(FOLLOW_UP_PREFIX) == true && alive.get()) beginFollowUpCapture()
                }
            })
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (!alive.get()) startListening()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startListening() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            fail("Microphone permission is required")
            stopSelf()
            return
        }
        alive.set(true)
        AppGraph.spotify.connect(false) { result ->
            result.exceptionOrNull()?.let { publish("Open LyricLatch and connect Spotify", true) }
        }
        audioThread = Thread({ audioLoop() }, "LyricLatchAudio").apply { start() }
    }

    @Suppress("MissingPermission")
    private fun audioLoop() {
        try {
            publish("Loading Hey Monday model…")
            wakeWord = WakeWordEngine(this)
            vad = SileroVad(this)
            val minimum = AudioRecord.getMinBufferSize(
                WakeWordEngine.SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            recorder = AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                WakeWordEngine.SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minimum, WakeWordEngine.CHUNK * 4),
            )
            check(recorder?.state == AudioRecord.STATE_INITIALIZED) { "Android could not initialize the microphone" }
            recorder?.startRecording()
            publish("Listening — say Hey Monday")
            val frame = ShortArray(WakeWordEngine.CHUNK)
            while (alive.get()) {
                val read = recorder?.read(frame, 0, frame.size, AudioRecord.READ_BLOCKING) ?: break
                if (read <= 0) continue
                val audio = if (read == frame.size) frame.copyOf() else frame.copyOf(read)
                when (mode) {
                    Mode.WAKING -> processWakeFrame(audio)
                    Mode.COMMAND, Mode.FOLLOW_UP -> processCaptureFrame(audio)
                    Mode.PROCESSING -> Unit
                }
            }
        } catch (error: Throwable) {
            fail(error.message ?: "Voice listener failed")
        } finally {
            runCatching { recorder?.stop() }
            recorder?.release()
            recorder = null
        }
    }

    private fun processWakeFrame(frame: ShortArray) {
        val score = wakeWord?.predict(frame) ?: return
        val now = System.currentTimeMillis()
        if (score >= WakeWordEngine.THRESHOLD && now - lastDetectionAt > 2_000) {
            lastDetectionAt = now
            AppGraph.spotify.pause()
            mode = Mode.COMMAND
            resetCapture()
            publish("Hey Monday detected — say your command")
        }
    }

    private fun processCaptureFrame(frame: ShortArray) {
        capture += frame
        captureFrames++
        val score = vad?.predict(frame) ?: 0f
        if (!speechStarted && score >= 0.5f) speechStarted = true
        if (speechStarted) silenceFrames = if (score < 0.5f) silenceFrames + 1 else 0
        val finished = speechStarted && captureFrames >= 4 && silenceFrames >= 15
        val timedOut = captureFrames >= 100
        if (finished || timedOut) {
            val followUp = mode == Mode.FOLLOW_UP
            val audio = concatenate(capture)
            mode = Mode.PROCESSING
            publish("Understanding…")
            worker.execute { processCommandAudio(audio, followUp) }
        }
    }

    private fun processCommandAudio(audio: ShortArray, followUp: Boolean) {
        try {
            if (audio.isEmpty()) throw IllegalStateException("I didn't hear anything")
            val transcript = AppGraph.cloud.transcribe(audio)
            if (transcript.isBlank()) throw IllegalStateException("I didn't hear a command")
            val result = if (followUp) AppGraph.commands.executeFollowUp(transcript) else AppGraph.commands.execute(transcript)
            when (result) {
                is CommandResult.Done -> {
                    publish(result.message, result.isError)
                    speak(result.message)
                    resetWakeMode()
                }
                is CommandResult.FollowUp -> {
                    publish(result.question)
                    speak(result.question, FOLLOW_UP_PREFIX + UUID.randomUUID())
                }
            }
        } catch (error: Throwable) {
            AppGraph.spotify.resume()
            publish("Command failed: ${error.message ?: "unknown error"}", true)
            resetWakeMode()
        }
    }

    private fun beginFollowUpCapture() {
        resetCapture()
        mode = Mode.FOLLOW_UP
        publish("Listening for lyrics or a time range…")
    }

    private fun resetWakeMode() {
        runCatching { wakeWord?.reset() }
        resetCapture()
        mode = Mode.WAKING
        publish("Listening — say Hey Monday")
    }

    private fun resetCapture() {
        capture.clear()
        captureFrames = 0
        speechStarted = false
        silenceFrames = 0
        vad?.reset()
    }

    private fun speak(message: String, id: String = "status-${UUID.randomUUID()}") {
        if (!ttsReady) {
            if (id.startsWith(FOLLOW_UP_PREFIX)) beginFollowUpCapture()
            return
        }
        tts?.speak(message, TextToSpeech.QUEUE_FLUSH, Bundle(), id)
    }

    private fun concatenate(frames: List<ShortArray>): ShortArray {
        val result = ShortArray(frames.sumOf { it.size })
        var offset = 0
        frames.forEach {
            it.copyInto(result, offset)
            offset += it.size
        }
        return result
    }

    private fun publish(message: String, error: Boolean = false) {
        VoiceRuntime.update(VoiceState(true, message, error))
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(message))
    }

    private fun fail(message: String) = VoiceRuntime.update(VoiceState(false, message, true))

    private fun notification(message: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, WakeWordService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_voice)
            .setContentTitle("LyricLatch voice")
            .setContentText(message)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_voice), "Stop", stopIntent).build())
            .build()
    }

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW).apply {
                description = getString(R.string.notification_description)
            },
        )
    }

    private fun startAsForeground(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, 0)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    override fun onDestroy() {
        alive.set(false)
        audioThread?.interrupt()
        runCatching { recorder?.stop() }
        worker.shutdownNow()
        wakeWord?.close()
        vad?.close()
        tts?.stop()
        tts?.shutdown()
        VoiceRuntime.update(VoiceState(false, "Voice listener is off"))
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "ai.beyondmarks.lyriclatch.START_VOICE"
        const val ACTION_STOP = "ai.beyondmarks.lyriclatch.STOP_VOICE"
        private const val CHANNEL_ID = "lyriclatch_voice"
        private const val NOTIFICATION_ID = 2206
        private const val FOLLOW_UP_PREFIX = "loop-follow-up-"
    }
}
