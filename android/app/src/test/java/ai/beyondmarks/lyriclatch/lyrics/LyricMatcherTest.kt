package ai.beyondmarks.lyriclatch.lyrics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LyricMatcherTest {
    private val lyrics = listOf(
        TimedLyricLine(0, "instrumental"),
        TimedLyricLine(12_000, "Raghupati Raghav Raja Ram"),
        TimedLyricLine(18_000, "Patit Pavan Sita Ram"),
        TimedLyricLine(30_000, "Raghupati Raghav Raja Ram"),
    )

    @Test fun parsesAndMatchesTransliteratedPhrase() {
        val intent = LyricMatcher.parsePhraseIntent("loop the part starting with raghupati raghav")
        assertEquals("raghupati raghav", intent?.start)
        val match = LyricMatcher.best(lyrics, "raghupati ragav raja ram")
        assertNotNull(match)
        assertEquals(1, match?.index)
        assertTrue((match?.score ?: 0.0) > 0.7)
    }

    @Test fun findsTheNextOccurrence() {
        assertEquals(3, LyricMatcher.best(lyrics, "raghupati raghav", afterIndex = 1)?.index)
    }

    @Test fun parsesLrcTimestamps() {
        val parsed = LyricMatcher.parseLrc("[01:20.50]first line\n[01:25.00]second line")
        assertEquals(80_500L, parsed.first().startTimeMs)
        assertEquals("second line", parsed.last().words)
    }
}
