package ai.beyondmarks.lyriclatch.voice

import java.util.concurrent.CopyOnWriteArrayList

data class VoiceState(val running: Boolean, val message: String, val error: Boolean = false)

object VoiceRuntime {
    @Volatile var state = VoiceState(false, "Voice listener is off")
        private set
    private val listeners = CopyOnWriteArrayList<(VoiceState) -> Unit>()

    fun update(value: VoiceState) {
        state = value
        listeners.forEach { it(value) }
    }

    fun addListener(listener: (VoiceState) -> Unit) {
        listeners += listener
        listener(state)
    }

    fun removeListener(listener: (VoiceState) -> Unit) {
        listeners -= listener
    }
}
