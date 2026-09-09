package ai.beyondmarks.lyriclatch.voice

import android.content.Context
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer

class SileroVad(context: Context, private val environment: OrtEnvironment = OrtEnvironment.getEnvironment()) : AutoCloseable {
    private val session: OrtSession = context.assets.open("models/silero_vad.onnx").use {
        environment.createSession(it.readBytes(), OrtSession.SessionOptions())
    }
    private val inputName = session.inputNames.first()
    private val hName = session.inputNames.firstOrNull { it == "h" } ?: session.inputNames.elementAt(1)
    private val cName = session.inputNames.firstOrNull { it == "c" } ?: session.inputNames.elementAt(2)
    private val srName = session.inputNames.firstOrNull { it == "sr" } ?: session.inputNames.elementAt(3)
    private val outputName = session.outputNames.first()
    private val hnName = session.outputNames.elementAt(1)
    private val cnName = session.outputNames.elementAt(2)
    private var h = FloatArray(128)
    private var c = FloatArray(128)

    fun reset() {
        h.fill(0f)
        c.fill(0f)
    }

    fun predict(pcm: ShortArray): Float {
        val scores = mutableListOf<Float>()
        var offset = 0
        while (offset + FRAME <= pcm.size) {
            val frame = FloatArray(FRAME) { pcm[offset + it] / 32767f }
            OnnxTensor.createTensor(environment, FloatBuffer.wrap(frame), longArrayOf(1, FRAME.toLong())).use { input ->
                OnnxTensor.createTensor(environment, FloatBuffer.wrap(h.copyOf()), longArrayOf(2, 1, 64)).use { hTensor ->
                    OnnxTensor.createTensor(environment, FloatBuffer.wrap(c.copyOf()), longArrayOf(2, 1, 64)).use { cTensor ->
                        longScalar(environment, 16_000).use { sampleRate ->
                            session.run(mapOf(inputName to input, hName to hTensor, cName to cTensor, srName to sampleRate)).use { result ->
                                scores += floatValues(result.get(outputName).get() as OnnxTensor).firstOrNull() ?: 0f
                                h = floatValues(result.get(hnName).get() as OnnxTensor)
                                c = floatValues(result.get(cnName).get() as OnnxTensor)
                            }
                        }
                    }
                }
            }
            offset += FRAME
        }
        return if (scores.isEmpty()) 0f else scores.average().toFloat()
    }

    private fun floatValues(tensor: OnnxTensor): FloatArray {
        val buffer = tensor.floatBuffer
        return FloatArray(buffer.remaining()).also(buffer::get)
    }

    override fun close() = session.close()

    companion object {
        private const val FRAME = 480
    }
}
