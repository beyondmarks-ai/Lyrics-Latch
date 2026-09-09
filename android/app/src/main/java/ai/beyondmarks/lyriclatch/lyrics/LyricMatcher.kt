package ai.beyondmarks.lyriclatch.lyrics

import java.text.Normalizer
import java.util.Locale

data class TimedLyricLine(val startTimeMs: Long, val words: String)
data class LyricMatch(val index: Int, val score: Double, val text: String)
data class PhraseRange(val start: String, val end: String? = null)

object LyricMatcher {
    fun parsePhraseIntent(command: String): PhraseRange? {
        val patterns = listOf(
            Regex("^(?:loop|repeat)(?: the)?(?: part| section| verse| chorus)? from [\\\"']?(.+?)[\\\"']? (?:until|through|to) [\\\"']?(.+?)[\\\"']?$", RegexOption.IGNORE_CASE),
            Regex("^(?:please )?(?:loop|repeat)(?: the)?(?: part| section| verse| chorus)?(?: that)? (?:starts?|starting|begins?|beginning) (?:from|with|at)(?: the)?(?: words?|line|lyrics?)?(?: such as)? [\\\"']?(.+?)[\\\"']?$", RegexOption.IGNORE_CASE),
            Regex("^(?:in (?:this|the) song[, ]*)?(?:there (?:is|'s) (?:a )?part (?:where|that) )?(?:it )?(?:starts?|starting|begins?|beginning) (?:from|with|at)(?: the)?(?: words?|line|lyrics?)?(?: such as)? [\\\"']?(.+?)[\\\"']?$", RegexOption.IGNORE_CASE),
        )
        patterns.forEachIndexed { index, regex ->
            regex.matchEntire(command.trim())?.let { match ->
                return PhraseRange(clean(match.groupValues[1]), match.groupValues.getOrNull(2)?.takeIf(String::isNotBlank)?.let(::clean))
            }
        }
        return null
    }

    fun best(lines: List<TimedLyricLine>, phrase: String, afterIndex: Int = -1): LyricMatch? {
        val wanted = normalize(phrase)
        if (wanted.isBlank()) return null
        var best: LyricMatch? = null
        for (index in (afterIndex + 1).coerceAtLeast(0) until lines.size) {
            for (count in 1..3) {
                if (index + count > lines.size) break
                val text = lines.subList(index, index + count).joinToString(" ") { it.words }
                val score = similarity(wanted, normalize(text)) - (count - 1) * 0.03
                if (best == null || score > best!!.score) best = LyricMatch(index, score, text)
            }
        }
        return best
    }

    fun defaultEnd(lines: List<TimedLyricLine>, startIndex: Int, durationMs: Long): Long {
        val start = lines.getOrNull(startIndex)?.startTimeMs ?: 0
        val earliest = start + 7_000
        val latest = minOf(durationMs, start + 14_000)
        val boundary = lines.drop(startIndex + 1).firstOrNull { it.startTimeMs >= earliest }?.startTimeMs
        return maxOf(start + 2_000, minOf(boundary ?: latest, latest))
    }

    fun parseLrc(value: String): List<TimedLyricLine> {
        val timestamp = Regex("\\[(\\d{1,3}):(\\d{2}(?:\\.\\d{1,3})?)\\]")
        return buildList {
            value.lineSequence().forEach { raw ->
                val words = raw.replace(timestamp, "").trim()
                if (words.isBlank()) return@forEach
                timestamp.findAll(raw).forEach { match ->
                    val milliseconds = ((match.groupValues[1].toDouble() * 60 + match.groupValues[2].toDouble()) * 1000).toLong()
                    add(TimedLyricLine(milliseconds, words))
                }
            }
        }.sortedBy { it.startTimeMs }
    }

    private fun normalize(value: String) = Normalizer.normalize(value, Normalizer.Form.NFKD)
        .lowercase(Locale.ROOT)
        .replace(Regex("[\\p{M}]"), "")
        .replace(Regex("[^\\p{L}\\p{N}]+"), " ")
        .trim()
        .replace(Regex("\\s+"), " ")

    private fun similarity(wanted: String, candidate: String): Double {
        if (candidate.isBlank()) return 0.0
        if (candidate.contains(wanted)) return 1.0
        val wantedTokens = wanted.split(' ')
        val candidateTokens = candidate.split(' ')
        val covered = wantedTokens.count(candidateTokens.toSet()::contains)
        val tokenScore = covered.toDouble() / wantedTokens.size * 0.82 + covered.toDouble() / candidateTokens.size * 0.18
        val editScore = 1.0 - levenshtein(wanted, candidate).toDouble() / maxOf(wanted.length, candidate.length, 1)
        return maxOf(tokenScore, editScore).coerceIn(0.0, 1.0)
    }

    private fun levenshtein(left: String, right: String): Int {
        val previous = IntArray(right.length + 1) { it }
        for (leftIndex in 1..left.length) {
            var diagonal = previous[0]
            previous[0] = leftIndex
            for (rightIndex in 1..right.length) {
                val above = previous[rightIndex]
                previous[rightIndex] = minOf(
                    previous[rightIndex] + 1,
                    previous[rightIndex - 1] + 1,
                    diagonal + if (left[leftIndex - 1] == right[rightIndex - 1]) 0 else 1,
                )
                diagonal = above
            }
        }
        return previous[right.length]
    }

    private fun clean(value: String) = value.trim().trimEnd('.', ',', '!', '?', ';', ':').trim()
}
