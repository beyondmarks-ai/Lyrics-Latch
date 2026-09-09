package ai.beyondmarks.lyriclatch.commands

import ai.beyondmarks.lyriclatch.lyrics.LyricMatcher
import ai.beyondmarks.lyriclatch.lyrics.SectionLooper
import ai.beyondmarks.lyriclatch.net.CloudServices
import ai.beyondmarks.lyriclatch.spotify.SpotifyController
import com.spotify.protocol.types.Repeat

sealed interface CommandResult {
    data class Done(val message: String, val isError: Boolean = false) : CommandResult
    data class FollowUp(val question: String) : CommandResult
}

class CommandEngine(
    private val spotify: SpotifyController,
    private val cloud: CloudServices,
    private val looper: SectionLooper,
) {
    fun execute(raw: String): CommandResult {
        val command = stripWakePhrase(raw).trim().lowercase()
        if (command.isBlank()) return CommandResult.Done("I didn't hear a command", true)

        if (Regex("^(?:stop|disable|turn off) (?:repeat|loop)(?:ing)?|i(?:'m| am) satisfied|that(?:'s| is) enough|done with (?:the )?loop$").matches(command)) {
            if (looper.stop()) return done("Section loop stopped")
            spotify.setRepeat(Repeat.OFF)
            spotify.resume()
            return done("Repeat is off")
        }
        if (Regex("^(play|resume|continue)(?: (?:music|song|playback))?$").matches(command)) {
            spotify.resume(); return done("Playing")
        }
        if (Regex("^(pause|stop)(?: (?:music|song|playback))?$").matches(command)) {
            spotify.pause(); return done("Paused")
        }

        Regex("^(?:skip|jump|seek|go) to (.+)$").matchEntire(command)?.let {
            parseDuration(it.groupValues[1])?.let { position ->
                spotify.seekTo(position); spotify.resume(); return done("Jumped to ${formatDuration(position)}")
            }
        }
        Regex("^(?:(?:skip|jump|go) (?:forward|ahead)|fast forward|forward|skip) (.+)$").matchEntire(command)?.let {
            parseDuration(it.groupValues[1])?.let { duration ->
                spotify.seekRelative(duration); spotify.resume(); return done("Skipped forward ${formatDuration(duration)}")
            }
        }
        Regex("^(?:rewind|back|(?:skip|jump|go) back) (.+)$").matchEntire(command)?.let {
            parseDuration(it.groupValues[1])?.let { duration ->
                spotify.seekRelative(-duration); spotify.resume(); return done("Rewound ${formatDuration(duration)}")
            }
        }
        if (Regex("^(next|next (?:song|track)|skip|skip (?:song|track))$").matches(command)) {
            spotify.next(); spotify.resume(); return done("Skipping")
        }
        if (Regex("^(previous|previous (?:song|track)|last (?:song|track)|go back)$").matches(command)) {
            spotify.previous(); return done("Going back")
        }

        if (Regex("^(?:please )?(?:loop|repeat) (?:(?:a|the|this) )?(?:song )?(?:part|section)(?: of (?:this|the) song)?$").matches(command)) {
            return CommandResult.FollowUp("Which part should I loop? Say the starting lyrics, or a time range like from one minute twenty to one minute thirty.")
        }
        Regex("^(?:loop|repeat)(?: the)?(?: part| section)? from (.+?) (?:to|until|through) (.+)$").matchEntire(command)?.let {
            val start = parseDuration(it.groupValues[1])
            val end = parseDuration(it.groupValues[2])
            if (start != null && end != null) return done(looper.startByTime(start, end))
        }
        LyricMatcher.parsePhraseIntent(command)?.let { return done(looper.startByPhrase(it.start, it.end)) }
        if (Regex("^(?:make (?:the loop|it) |loop )(?:a little )?longer$|^extend (?:the )?loop$").matches(command)) {
            return done(looper.adjust(true))
        }
        if (Regex("^(?:make (?:the loop|it) |loop )(?:a little )?shorter$|^shorten (?:the )?loop$").matches(command)) {
            return done(looper.adjust(false))
        }
        if (Regex("^(?:next|another) occurrence$|^(?:loop|use) the next (?:one|occurrence)$").matches(command)) {
            return done(looper.nextOccurrence())
        }
        if (Regex("^(?:repeat|loop)(?: (?:this|current))?(?: song| track)?$").matches(command)) {
            spotify.setRepeat(Repeat.ONE); spotify.resume(); return done("Looping this song")
        }
        if (Regex("^(?:repeat|loop)(?: all| queue| playlist)$").matches(command)) {
            spotify.setRepeat(Repeat.ALL); spotify.resume(); return done("Looping the queue")
        }
        Regex("^volume(?: to)? (\\d{1,3})(?: percent)?$").matchEntire(command)?.let {
            val percent = it.groupValues[1].toInt().coerceIn(0, 100)
            spotify.setVolume(percent)
            return done("Volume $percent percent")
        }

        val query = command.replace(Regex("^(?:play|search(?: spotify)? for|find)(?: the)?(?: song| track)?\\s+"), "").trim()
        if (query.isBlank()) return CommandResult.Done("Tell me which song to play", true)
        val identified = runCatching { cloud.identifySong(query) }.getOrNull()
        val track = identified?.let(spotify::searchTrack) ?: spotify.searchTrack(query)
            ?: return CommandResult.Done("Couldn't find $query on Spotify", true)
        spotify.playUri(track.uri)
        return done(if (track.artist.isBlank()) "Playing ${track.name}" else "Playing ${track.name} by ${track.artist}")
    }

    fun executeFollowUp(answer: String): CommandResult {
        val clean = stripWakePhrase(answer).trim().trimEnd('.', '!', '?')
        if (Regex("^(?:cancel|never mind|nevermind|stop listening|forget it)$", RegexOption.IGNORE_CASE).matches(clean)) {
            spotify.resume()
            return done("Loop request cancelled")
        }
        val command = when {
            Regex("^(?:loop|repeat)\\b", RegexOption.IGNORE_CASE).containsMatchIn(clean) -> clean
            Regex("^from\\s+.+\\s+(?:to|until|through)\\s+.+$", RegexOption.IGNORE_CASE).matches(clean) -> "loop $clean"
            Regex("^start (?:at|from) (.+?) (?:and )?end (?:at|on) (.+)$", RegexOption.IGNORE_CASE).matches(clean) -> {
                val match = Regex("^start (?:at|from) (.+?) (?:and )?end (?:at|on) (.+)$", RegexOption.IGNORE_CASE).find(clean)!!
                "loop from ${match.groupValues[1]} to ${match.groupValues[2]}"
            }
            Regex("^(.+?)\\s+(?:to|until|through)\\s+(.+)$", RegexOption.IGNORE_CASE).matches(clean) &&
                Regex("\\d|seconds?|minutes?|\\d{1,2}:\\d{2}", RegexOption.IGNORE_CASE).containsMatchIn(clean) -> "loop from $clean"
            else -> "loop the part starting with " + clean.replace(
                Regex("^(?:the )?(?:lyrics?|words?|line)(?: are| is| starting with| from)?\\s+", RegexOption.IGNORE_CASE),
                "",
            )
        }
        return execute(command)
    }

    private fun done(message: String) = CommandResult.Done(message, message.startsWith("Couldn't") || message.startsWith("No "))

    companion object {
        fun stripWakePhrase(value: String) = value.trim()
            .replace(Regex("^(?:hey\\s+)?monday\\b[\\s,.:;-]*", RegexOption.IGNORE_CASE), "")
            .trim()

        fun parseDuration(value: String): Long? {
            Regex("^(\\d{1,2}):(\\d{2})$").matchEntire(value.trim())?.let {
                return (it.groupValues[1].toLong() * 60 + it.groupValues[2].toLong()) * 1000
            }
            val words = mapOf(
                "a" to 1.0, "an" to 1.0, "half" to 0.5, "one" to 1.0, "two" to 2.0,
                "three" to 3.0, "four" to 4.0, "five" to 5.0, "six" to 6.0, "seven" to 7.0,
                "eight" to 8.0, "nine" to 9.0, "ten" to 10.0, "fifteen" to 15.0,
                "twenty" to 20.0, "thirty" to 30.0, "forty" to 40.0, "fifty" to 50.0, "sixty" to 60.0,
            )
            val regex = Regex("(\\d+(?:\\.\\d+)?|a|an|half|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty)\\s*(?:a\\s+)?(hours?|hrs?|minutes?|mins?|seconds?|secs?)")
            var milliseconds = 0.0
            regex.findAll(value.lowercase()).forEach {
                val amount = it.groupValues[1].toDoubleOrNull() ?: words[it.groupValues[1]] ?: 0.0
                val unit = it.groupValues[2]
                milliseconds += when {
                    unit.startsWith("hour") || unit.startsWith("hr") -> amount * 3_600_000
                    unit.startsWith("min") -> amount * 60_000
                    else -> amount * 1000
                }
            }
            return milliseconds.takeIf { it > 0 }?.toLong()?.coerceAtMost(3_600_000)
        }

        private fun formatDuration(milliseconds: Long): String {
            val total = milliseconds / 1000
            val minutes = total / 60
            val seconds = total % 60
            return when {
                minutes == 0L -> "$seconds seconds"
                seconds == 0L -> "$minutes minutes"
                else -> "$minutes minutes $seconds seconds"
            }
        }
    }
}
