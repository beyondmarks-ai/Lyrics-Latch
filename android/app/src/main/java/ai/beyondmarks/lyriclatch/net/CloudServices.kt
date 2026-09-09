package ai.beyondmarks.lyriclatch.net

import ai.beyondmarks.lyriclatch.data.ConfigStore
import ai.beyondmarks.lyriclatch.spotify.SpotifyAuth
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID

class CloudServices(private val store: ConfigStore) {
    fun transcribe(pcm: ShortArray): String {
        val settings = store.settings()
        if (settings.backendUrl.isNotBlank()) {
            val bytes = ByteBuffer.allocate(pcm.size * 2).order(ByteOrder.LITTLE_ENDIAN)
                .apply { pcm.forEach(::putShort) }.array()
            val response = Http.requireSuccess(
                Http.request("POST", "${settings.backendUrl}/api/speech/recognize", body = bytes, contentType = "application/octet-stream"),
                "Speech recognition failed",
            )
            return JSONObject(response.text()).optString("transcript").trim()
        }

        require(settings.sarvamApiKey.isNotBlank()) { "Configure a Sarvam API key or an HTTPS backend" }
        val boundary = "LyricLatch-${UUID.randomUUID()}"
        val body = Http.multipart(
            boundary,
            mapOf("model" to "saaras:v3", "mode" to "codemix"),
            "command.wav",
            "audio/wav",
            waveFile(pcm),
        )
        val response = Http.requireSuccess(
            Http.request(
                "POST",
                "https://api.sarvam.ai/speech-to-text",
                headers = mapOf("api-subscription-key" to settings.sarvamApiKey),
                body = body,
                contentType = "multipart/form-data; boundary=$boundary",
            ),
            "Sarvam transcription failed",
        )
        return JSONObject(response.text()).optString("transcript").trim()
    }

    fun identifySong(query: String): String? {
        val settings = store.settings()
        if (settings.backendUrl.isNotBlank()) {
            val response = Http.request(
                "GET",
                "${settings.backendUrl}/api/youtube/search?q=${encode("$query official song")}",
            )
            if (response.status !in 200..299) return null
            return youtubeTitle(JSONObject(response.text()))
        }
        if (settings.youtubeApiKey.isBlank()) return null
        val url = "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1" +
            "&q=${encode("$query official song")}&key=${encode(settings.youtubeApiKey)}"
        val response = Http.request("GET", url)
        if (response.status !in 200..299) return null
        return youtubeTitle(JSONObject(response.text()))
    }

    fun syncedLyrics(trackName: String, artistName: String, albumName: String, durationSeconds: Int): String? {
        val settings = store.settings()
        if (settings.backendUrl.isNotBlank()) {
            val json = JSONObject()
                .put("trackName", trackName)
                .put("artistName", artistName)
                .put("albumName", albumName)
                .put("durationSeconds", durationSeconds)
            val response = Http.request(
                "POST",
                "${settings.backendUrl}/api/lyrics/synced",
                body = json.toString().toByteArray(),
                contentType = "application/json",
            )
            if (response.status == 404) return null
            Http.requireSuccess(response, "Synchronized lyrics lookup failed")
            return JSONObject(response.text()).optString("syncedLyrics").takeIf(String::isNotBlank)
        }

        val url = "https://lrclib.net/api/get?track_name=${encode(trackName)}&artist_name=${encode(artistName)}" +
            "&album_name=${encode(albumName)}&duration=$durationSeconds"
        val response = Http.request("GET", url)
        if (response.status == 404) return null
        Http.requireSuccess(response, "Synchronized lyrics lookup failed")
        return JSONObject(response.text()).optString("syncedLyrics").takeIf(String::isNotBlank)
    }

    private fun youtubeTitle(json: JSONObject): String? {
        val items = json.optJSONArray("items") ?: return null
        val title = items.optJSONObject(0)?.optJSONObject("snippet")?.optString("title") ?: return null
        return title
            .replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'")
            .replace(Regex("\\s*[\\[(](?:official|lyrics?|audio|video|music video|visuali[sz]er)[^\\])]*[\\])]", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\s*[-|]\\s*(?:official|lyrics?|audio|video|music video).*$", RegexOption.IGNORE_CASE), "")
            .trim()
            .takeIf(String::isNotBlank)
    }

    private fun waveFile(pcm: ShortArray): ByteArray {
        val dataBytes = pcm.size * 2
        return ByteBuffer.allocate(44 + dataBytes).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray())
            putInt(36 + dataBytes)
            put("WAVEfmt ".toByteArray())
            putInt(16)
            putShort(1)
            putShort(1)
            putInt(16_000)
            putInt(32_000)
            putShort(2)
            putShort(16)
            put("data".toByteArray())
            putInt(dataBytes)
            pcm.forEach(::putShort)
        }.array()
    }

    private fun encode(value: String) = SpotifyAuth.formEncode(mapOf("v" to value)).substringAfter('=')
}
