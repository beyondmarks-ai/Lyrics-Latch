package ai.beyondmarks.lyriclatch.lyrics

import ai.beyondmarks.lyriclatch.net.CloudServices
import ai.beyondmarks.lyriclatch.spotify.SpotifyController
import com.spotify.protocol.types.Repeat
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

private data class ActiveLoop(
    val trackUri: String,
    var startMs: Long,
    var endMs: Long,
    val previousRepeat: Int,
    val phrase: String? = null,
    var phraseIndex: Int? = null,
    val lines: List<TimedLyricLine>? = null,
)

class SectionLooper(
    private val spotify: SpotifyController,
    private val cloud: CloudServices,
) {
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var active: ActiveLoop? = null
    private var enforcement: ScheduledFuture<*>? = null
    @Volatile private var lastSeekAt = 0L

    fun startByTime(startMs: Long, endMs: Long): String {
        val track = spotify.currentTrack() ?: return "Play a song before creating a section loop"
        if (endMs <= startMs + MIN_LOOP_MS) return "The loop must be at least 1.5 seconds long"
        if (startMs >= track.durationMs) return "The loop start is beyond the end of this song"
        activate(ActiveLoop(track.uri, startMs.coerceAtLeast(0), endMs.coerceAtMost(track.durationMs), track.repeatMode))
        return "Looping from ${format(startMs)} to ${format(endMs.coerceAtMost(track.durationMs))}"
    }

    fun startByPhrase(startPhrase: String, endPhrase: String? = null): String {
        val track = spotify.currentTrack() ?: return "Play a song before creating a section loop"
        val lrc = cloud.syncedLyrics(track.name, track.artist, track.album, (track.durationMs / 1000).toInt())
            ?: return "No synchronized lyrics were found. Give me a time range instead."
        val lines = LyricMatcher.parseLrc(lrc)
        if (lines.isEmpty()) return "The lyrics did not contain usable timestamps"
        val start = LyricMatcher.best(lines, startPhrase)
            ?.takeIf { it.score >= MIN_MATCH }
            ?: return "I couldn't match $startPhrase in this song"
        val endMs = if (endPhrase != null) {
            val end = LyricMatcher.best(lines, endPhrase, start.index - 1)
                ?.takeIf { it.score >= MIN_MATCH && it.index >= start.index }
                ?: return "I found the start, but not the ending words"
            lines.getOrNull(end.index + 1)?.startTimeMs ?: minOf(track.durationMs, lines[end.index].startTimeMs + 5_000)
        } else {
            LyricMatcher.defaultEnd(lines, start.index, track.durationMs)
        }
        val startMs = (lines[start.index].startTimeMs - 120).coerceAtLeast(0)
        activate(ActiveLoop(track.uri, startMs, maxOf(startMs + MIN_LOOP_MS, endMs), track.repeatMode, startPhrase, start.index, lines))
        return "Looping ${start.text} from ${format(startMs)} to ${format(endMs)}"
    }

    fun adjust(longer: Boolean): String {
        val loop = active ?: return "There is no active section loop"
        val duration = spotify.currentTrack()?.durationMs ?: loop.endMs
        loop.endMs = (loop.endMs + if (longer) 2_000 else -2_000)
            .coerceIn(loop.startMs + MIN_LOOP_MS, duration)
        return "Loop is now ${format(loop.endMs - loop.startMs)} long"
    }

    fun nextOccurrence(): String {
        val loop = active ?: return "There is no active section loop"
        val phrase = loop.phrase ?: return "The current loop was not created from lyrics"
        val lines = loop.lines ?: return "The current loop was not created from lyrics"
        val match = LyricMatcher.best(lines, phrase, loop.phraseIndex ?: -1)
            ?.takeIf { it.score >= MIN_MATCH }
            ?: return "There is no later matching occurrence"
        loop.phraseIndex = match.index
        loop.startMs = (lines[match.index].startTimeMs - 120).coerceAtLeast(0)
        loop.endMs = LyricMatcher.defaultEnd(lines, match.index, spotify.currentTrack()?.durationMs ?: loop.endMs)
        spotify.seekTo(loop.startMs)
        spotify.resume()
        return "Looping the next ${match.text} at ${format(loop.startMs)}"
    }

    fun stop(resume: Boolean = true): Boolean {
        val loop = active ?: return false
        active = null
        enforcement?.cancel(false)
        enforcement = null
        spotify.setRepeat(loop.previousRepeat)
        if (resume) spotify.resume()
        return true
    }

    fun isActive() = active != null

    private fun activate(loop: ActiveLoop) {
        val previousRepeat = active?.previousRepeat ?: loop.previousRepeat
        stop(false)
        active = loop.copy(previousRepeat = previousRepeat)
        lastSeekAt = 0
        spotify.setRepeat(Repeat.ONE)
        spotify.seekTo(loop.startMs)
        spotify.resume()
        enforcement = scheduler.scheduleWithFixedDelay(::enforce, 80, 80, TimeUnit.MILLISECONDS)
    }

    private fun enforce() {
        val loop = active ?: return
        val track = spotify.currentTrack()
        if (track?.uri != loop.trackUri) {
            stop(false)
            return
        }
        val now = System.currentTimeMillis()
        if (spotify.estimatedPositionMs() >= loop.endMs - 45 && now - lastSeekAt > 300) {
            lastSeekAt = now
            spotify.seekTo(loop.startMs)
        }
    }

    private fun format(ms: Long): String {
        val seconds = (ms.coerceAtLeast(0) / 1000).toInt()
        return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
    }

    companion object {
        private const val MIN_LOOP_MS = 1_500L
        private const val MIN_MATCH = 0.44
    }
}
