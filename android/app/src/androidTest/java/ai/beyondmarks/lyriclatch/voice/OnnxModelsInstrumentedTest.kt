package ai.beyondmarks.lyriclatch.voice

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OnnxModelsInstrumentedTest {
    @Test
    fun wakeWordAndVadModelsLoadAndRunOnAndroid() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()

        WakeWordEngine(context).use { wakeWord ->
            repeat(6) {
                assertTrue(wakeWord.predict(ShortArray(WakeWordEngine.CHUNK)).isFinite())
            }
        }

        SileroVad(context).use { vad ->
            assertTrue(vad.predict(ShortArray(480)).isFinite())
        }
    }
}
