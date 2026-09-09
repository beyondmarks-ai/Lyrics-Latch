package ai.beyondmarks.lyriclatch.net

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

data class HttpResponse(val status: Int, val body: ByteArray, val headers: Map<String, List<String>>) {
    fun text(): String = body.toString(Charsets.UTF_8)
}

class HttpException(val status: Int, message: String) : Exception(message)

object Http {
    fun request(
        method: String,
        url: String,
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        contentType: String? = null,
    ): HttpResponse {
        val connection = URL(url).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = method
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = true
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", "LyricLatch-Android/1.0")
            headers.forEach(connection::setRequestProperty)
            if (body != null) {
                connection.doOutput = true
                contentType?.let { connection.setRequestProperty("Content-Type", it) }
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val payload = stream?.use { it.readBytes() } ?: ByteArray(0)
            val responseHeaders = connection.headerFields.entries
                .mapNotNull { (name, values) -> name?.let { it to values } }
                .toMap()
            HttpResponse(status, payload, responseHeaders)
        } finally {
            connection.disconnect()
        }
    }

    fun requireSuccess(response: HttpResponse, fallback: String): HttpResponse {
        if (response.status in 200..299) return response
        throw HttpException(response.status, response.text().takeIf { it.isNotBlank() } ?: fallback)
    }

    fun multipart(boundary: String, fields: Map<String, String>, fileName: String, mime: String, file: ByteArray): ByteArray {
        val output = ByteArrayOutputStream()
        fun write(value: String) = output.write(value.toByteArray(Charsets.UTF_8))
        fields.forEach { (name, value) ->
            write("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n")
        }
        write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"$fileName\"\r\n")
        write("Content-Type: $mime\r\n\r\n")
        output.write(file)
        write("\r\n--$boundary--\r\n")
        return output.toByteArray()
    }
}
