package ai.beyondmarks.lyriclatch.voice

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer
import java.nio.LongBuffer

internal fun runFloatModel(
    environment: OrtEnvironment,
    session: OrtSession,
    inputName: String,
    data: FloatArray,
    shape: LongArray,
): Pair<FloatArray, LongArray> {
    OnnxTensor.createTensor(environment, FloatBuffer.wrap(data), shape).use { input ->
        session.run(mapOf(inputName to input)).use { result ->
            val output = result[0] as OnnxTensor
            val buffer = output.floatBuffer
            val values = FloatArray(buffer.remaining())
            buffer.get(values)
            return values to output.info.shape
        }
    }
}

internal fun longScalar(environment: OrtEnvironment, value: Long): OnnxTensor =
    OnnxTensor.createTensor(environment, LongBuffer.wrap(longArrayOf(value)), longArrayOf())
