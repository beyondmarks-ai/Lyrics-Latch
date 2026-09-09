package ai.beyondmarks.lyriclatch.voice

import android.content.Context
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.util.ArrayDeque
import kotlin.random.Random

class WakeWordEngine(context: Context) : AutoCloseable {
    private val environment = OrtEnvironment.getEnvironment()
    private val options = OrtSession.SessionOptions().apply {
        setIntraOpNumThreads(1)
        setInterOpNumThreads(1)
    }
    private val melSession = load(context, "models/melspectrogram.onnx")
    private val embeddingSession = load(context, "models/embedding_model.onnx")
    private val wakeSession = load(context, "models/hey_monday.onnx")
    private val features = AudioFeatures(environment, melSession, embeddingSession)
    private val predictions = ArrayDeque<Float>()

    init {
        features.warmup()
    }

    fun predict(pcm: ShortArray): Float {
        val prepared = features.streaming(pcm)
        val score = if (prepared >= CHUNK && features.featureCount >= INPUT_FRAMES) {
            val input = features.latest(INPUT_FRAMES)
            runFloatModel(
                environment,
                wakeSession,
                wakeSession.inputNames.first(),
                input,
                longArrayOf(1, INPUT_FRAMES.toLong(), EMBED_DIM.toLong()),
            ).first.firstOrNull() ?: 0f
        } else {
            predictions.lastOrNull() ?: 0f
        }
        val warmedScore = if (predictions.size < 5) 0f else score
        predictions.addLast(warmedScore)
        while (predictions.size > 30) predictions.removeFirst()
        return warmedScore
    }

    fun reset() {
        predictions.clear()
        features.reset()
        features.warmup()
    }

    private fun load(context: Context, name: String): OrtSession = context.assets.open(name).use {
        environment.createSession(it.readBytes(), options)
    }

    override fun close() {
        wakeSession.close()
        embeddingSession.close()
        melSession.close()
        options.close()
    }

    private class AudioFeatures(
        private val environment: OrtEnvironment,
        private val melSession: OrtSession,
        private val embeddingSession: OrtSession,
    ) {
        private val raw = ArrayList<Short>(160_000)
        private var remainder = ShortArray(0)
        private var accumulated = 0
        private val mel = ArrayList<FloatArray>()
        private val embeddings = ArrayList<FloatArray>()

        val featureCount get() = embeddings.size

        init { reset() }

        fun reset() {
            raw.clear()
            remainder = ShortArray(0)
            accumulated = 0
            mel.clear()
            repeat(WINDOW_SIZE) { mel += FloatArray(MEL_BINS) { 1f } }
            embeddings.clear()
        }

        fun warmup() {
            val audio = ShortArray(64_000) { Random.nextInt(-1000, 1000).toShort() }
            embeddings += embeddingsFor(audio)
        }

        fun streaming(inputFrame: ShortArray): Int {
            var frame = if (remainder.isNotEmpty()) remainder + inputFrame else inputFrame
            remainder = ShortArray(0)
            if (accumulated + frame.size >= CHUNK) {
                val trailing = (accumulated + frame.size) % CHUNK
                if (trailing != 0) {
                    val even = frame.copyOfRange(0, frame.size - trailing)
                    bufferRaw(even)
                    accumulated += even.size
                    remainder = frame.copyOfRange(frame.size - trailing, frame.size)
                } else {
                    bufferRaw(frame)
                    accumulated += frame.size
                }
            } else {
                bufferRaw(frame)
                accumulated += frame.size
            }

            if (accumulated >= CHUNK && accumulated % CHUNK == 0) {
                streamingMel(accumulated)
                for (index in accumulated / CHUNK - 1 downTo 0) {
                    val end = mel.size - STEP_SIZE * index
                    val start = end - WINDOW_SIZE
                    if (start >= 0) embeddings += embedWindow(mel.subList(start, end))
                }
                val processed = accumulated
                accumulated = 0
                while (embeddings.size > 120) embeddings.removeAt(0)
                return processed
            }
            return accumulated
        }

        fun latest(count: Int): FloatArray {
            val frames = embeddings.takeLast(count)
            return FloatArray(frames.size * EMBED_DIM).also { output ->
                frames.forEachIndexed { index, values -> values.copyInto(output, index * EMBED_DIM) }
            }
        }

        private fun bufferRaw(frame: ShortArray) {
            frame.forEach(raw::add)
            if (raw.size > 160_000) raw.subList(0, raw.size - 160_000).clear()
        }

        private fun streamingMel(samples: Int) {
            val count = minOf(raw.size, samples + 480)
            val tail = ShortArray(count) { raw[raw.size - count + it] }
            mel += melspectrogram(tail)
            while (mel.size > 970) mel.removeAt(0)
        }

        private fun embeddingsFor(pcm: ShortArray): List<FloatArray> {
            val spectrum = melspectrogram(pcm)
            return buildList {
                var index = 0
                while (index + WINDOW_SIZE <= spectrum.size) {
                    add(embedWindow(spectrum.subList(index, index + WINDOW_SIZE)))
                    index += STEP_SIZE
                }
            }
        }

        private fun melspectrogram(pcm: ShortArray): List<FloatArray> {
            val input = FloatArray(pcm.size) { pcm[it].toFloat() }
            val (output, shape) = runFloatModel(
                environment,
                melSession,
                melSession.inputNames.first(),
                input,
                longArrayOf(1, input.size.toLong()),
            )
            val bins = shape.last().toInt()
            val frames = shape[shape.size - 2].toInt()
            return List(frames) { frame -> FloatArray(bins) { bin -> output[frame * bins + bin] / 10f + 2f } }
        }

        private fun embedWindow(window: List<FloatArray>): FloatArray {
            val input = FloatArray(WINDOW_SIZE * MEL_BINS)
            window.forEachIndexed { row, values -> values.copyInto(input, row * MEL_BINS) }
            return runFloatModel(
                environment,
                embeddingSession,
                embeddingSession.inputNames.first(),
                input,
                longArrayOf(1, WINDOW_SIZE.toLong(), MEL_BINS.toLong(), 1),
            ).first.copyOf(EMBED_DIM)
        }
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        const val CHUNK = 1_280
        const val THRESHOLD = 0.5f
        private const val MEL_BINS = 32
        private const val EMBED_DIM = 96
        private const val WINDOW_SIZE = 76
        private const val STEP_SIZE = 8
        private const val INPUT_FRAMES = 16
    }
}
