package ai.beyondmarks.lyriclatch.commands

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CommandEngineTest {
    @Test fun parsesClockAndNaturalDurations() {
        assertEquals(80_000L, CommandEngine.parseDuration("1:20"))
        assertEquals(150_000L, CommandEngine.parseDuration("2 minutes 30 seconds"))
        assertEquals(30_000L, CommandEngine.parseDuration("half a minute"))
        assertNull(CommandEngine.parseDuration("sometime later"))
    }

    @Test fun removesWakePhraseWithoutDamagingTheCommand() {
        assertEquals("play monta re", CommandEngine.stripWakePhrase("Hey Monday, play Monta Re").lowercase())
    }
}
