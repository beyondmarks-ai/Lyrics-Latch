import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GoogleAuth } from "google-auth-library";

const port = Number(process.env.COMPANION_PORT || 43821);
const publicRoot = resolve(import.meta.dirname, "public");
const googleAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const googleCloudProject = process.env.GOOGLE_CLOUD_PROJECT?.trim() || "";
const sarvamApiKey = process.env.SARVAM_API_KEY?.trim() || "";
const adcPath = process.env.APPDATA
  ? resolve(process.env.APPDATA, "gcloud", "application_default_credentials.json")
  : "";
const lyricsCache = new Map<string, { expiresAt: number; syncedLyrics: string | null }>();
let lastLyricsRequestAt = 0;

const staticFiles: Record<string, { path: string; type: string }> = {
  "/models/melspectrogram.onnx": { path: "models/melspectrogram.onnx", type: "application/octet-stream" },
  "/models/embedding_model.onnx": { path: "models/embedding_model.onnx", type: "application/octet-stream" },
  "/models/hey_monday.onnx": { path: "models/hey_monday.onnx", type: "application/octet-stream" },
  "/models/silero_vad.onnx": { path: "models/silero_vad.onnx", type: "application/octet-stream" },
  "/mic-worklet.js": { path: "mic-worklet.js", type: "text/javascript; charset=utf-8" },
  "/ort/ort-wasm-simd-threaded.mjs": {
    path: "ort/ort-wasm-simd-threaded.mjs",
    type: "text/javascript; charset=utf-8"
  },
  "/ort/ort-wasm-simd-threaded.wasm": {
    path: "ort/ort-wasm-simd-threaded.wasm",
    type: "application/wasm"
  },
  "/ort/ort-wasm-simd-threaded.jsep.mjs": {
    path: "ort/ort-wasm-simd-threaded.jsep.mjs",
    type: "text/javascript; charset=utf-8"
  },
  "/ort/ort-wasm-simd-threaded.jsep.wasm": {
    path: "ort/ort-wasm-simd-threaded.jsep.wasm",
    type: "application/wasm"
  }
};

function send(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    response.end();
    return;
  }

  const asset = staticFiles[url.pathname];
  if (request.method === "GET" && asset) {
    try {
      const body = await readFile(resolve(publicRoot, asset.path));
      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": asset.type,
        "Cache-Control": "public, max-age=3600"
      });
      response.end(body);
    } catch {
      send(response, 404, { error: "Wake-word asset not found; rebuild the companion" });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    send(response, 200, {
      ready: true,
      wakeWordModelReady: existsSync(resolve(publicRoot, "models", "hey_monday.onnx")),
      speechConfigured: Boolean(sarvamApiKey || process.env.GOOGLE_APPLICATION_CREDENTIALS || (adcPath && existsSync(adcPath))),
      sarvamConfigured: Boolean(sarvamApiKey),
      speechProvider: sarvamApiKey ? "sarvam" : "google",
      aiLyricMatchingConfigured: Boolean(googleCloudProject && (process.env.GOOGLE_APPLICATION_CREDENTIALS || (adcPath && existsSync(adcPath)))),
      youtubeConfigured: Boolean(process.env.YOUTUBE_API_KEY)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/speech/recognize") {
    try {
      const audio = await readRequestBody(request, 1_000_000);
      if (audio.length < 3_200) return send(response, 400, { error: "Voice command audio is too short" });

      if (sarvamApiKey) {
        try {
          const transcript = await recognizeWithSarvam(audio);
          return send(response, 200, { transcript, provider: "sarvam" });
        } catch (error) {
          console.warn(`[LyricLatch] Sarvam recognition failed; using Google fallback: ${errorMessage(error)}`);
        }
      }
      const transcript = await recognizeWithGoogle(audio);
      send(response, 200, { transcript, provider: "google" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Speech recognition failed";
      send(response, message.includes("too large") ? 413 : 502, { error: message });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/lyrics/match") {
    try {
      const body = JSON.parse((await readRequestBody(request, 250_000)).toString("utf8")) as {
        phrase?: unknown;
        lines?: unknown;
      };
      const phrase = typeof body.phrase === "string" ? body.phrase.trim() : "";
      const lines = Array.isArray(body.lines)
        ? body.lines.filter((line): line is string => typeof line === "string").slice(0, 500)
        : [];
      if (!phrase || !lines.length) return send(response, 400, { error: "A phrase and lyric lines are required" });

      const index = await matchLyricsWithGemini(phrase, lines);
      send(response, 200, { index, provider: "vertex-gemini" });
    } catch (error) {
      send(response, 502, { error: errorMessage(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/lyrics/synced") {
    try {
      const body = JSON.parse((await readRequestBody(request, 50_000)).toString("utf8")) as Record<string, unknown>;
      const trackName = typeof body.trackName === "string" ? body.trackName.trim() : "";
      const artistName = typeof body.artistName === "string" ? body.artistName.trim() : "";
      const albumName = typeof body.albumName === "string" ? body.albumName.trim() : "";
      const durationSeconds = typeof body.durationSeconds === "number" ? Math.round(body.durationSeconds) : 0;
      if (!trackName || !artistName || durationSeconds <= 0) {
        return send(response, 400, { error: "Track name, artist, and duration are required" });
      }
      const syncedLyrics = await fetchLrclibLyrics({ trackName, artistName, albumName, durationSeconds });
      if (!syncedLyrics) return send(response, 404, { error: "No alternative synchronized lyrics found" });
      send(response, 200, { syncedLyrics, provider: "lrclib" });
    } catch (error) {
      send(response, 502, { error: errorMessage(error) });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/youtube/search") {
    const query = url.searchParams.get("q")?.trim();
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return send(response, 503, { error: "YouTube API is not configured" });
    if (!query) return send(response, 400, { error: "A search query is required" });

    try {
      const endpoint = new URL("https://www.googleapis.com/youtube/v3/search");
      endpoint.search = new URLSearchParams({
        part: "snippet",
        type: "video",
        maxResults: "1",
        q: query,
        key: apiKey
      }).toString();
      const youtubeResponse = await fetch(endpoint);
      const payload = await youtubeResponse.json();
      send(response, youtubeResponse.status, payload);
    } catch (error) {
      send(response, 502, { error: error instanceof Error ? error.message : "YouTube request failed" });
    }
    return;
  }

  send(response, 404, { error: "Not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`LyricLatch companion listening at http://127.0.0.1:${port}`);
});

async function readRequestBody(request: import("node:http").IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error("Voice command audio is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function recognizeWithSarvam(audio: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([createWaveFile(audio)], { type: "audio/wav" }), "command.wav");
  form.append("model", "saaras:v3");
  form.append("mode", "codemix");

  const response = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: { "api-subscription-key": sarvamApiKey },
    body: form,
    signal: AbortSignal.timeout(25_000)
  });
  const payload = await response.json() as { transcript?: string; error?: { message?: string }; message?: string };
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.message || `Sarvam returned ${response.status}`);
  }
  return payload.transcript?.trim() || "";
}

async function recognizeWithGoogle(audio: Buffer): Promise<string> {
  if (!googleCloudProject) throw new Error("GOOGLE_CLOUD_PROJECT is not configured");
  const token = await googleAuth.getAccessToken();
  if (!token) throw new Error("Google Cloud credentials are unavailable");
  const response = await fetch(
    `https://us-speech.googleapis.com/v2/projects/${googleCloudProject}/locations/us/recognizers/_:recognize`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Goog-User-Project": googleCloudProject
      },
      body: JSON.stringify({
        config: {
          explicitDecodingConfig: {
            encoding: "LINEAR16",
            sampleRateHertz: 16000,
            audioChannelCount: 1
          },
          languageCodes: ["auto"],
          model: "chirp_3",
          features: { enableAutomaticPunctuation: false }
        },
        content: audio.toString("base64")
      }),
      signal: AbortSignal.timeout(25_000)
    }
  );
  const payload = await response.json() as {
    results?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(payload.error?.message || `Google Speech returned ${response.status}`);
  return payload.results
    ?.map((result) => result.alternatives?.[0]?.transcript || "")
    .join(" ")
    .trim() || "";
}

function createWaveFile(pcm: Buffer): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(44 + pcm.length);
  const wave = Buffer.from(arrayBuffer);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(36 + pcm.length, 4);
  wave.write("WAVE", 8);
  wave.write("fmt ", 12);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(16_000, 24);
  wave.writeUInt32LE(32_000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(pcm.length, 40);
  pcm.copy(wave, 44);
  return arrayBuffer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function matchLyricsWithGemini(phrase: string, lines: string[]): Promise<number | null> {
  if (!googleCloudProject) throw new Error("GOOGLE_CLOUD_PROJECT is not configured");
  const token = await googleAuth.getAccessToken();
  if (!token) throw new Error("Google Cloud credentials are unavailable");
  const numberedLyrics = lines.map((line, index) => `${index}: ${line}`).join("\n");
  const response = await fetch(
    `https://aiplatform.googleapis.com/v1/projects/${googleCloudProject}/locations/global/publishers/google/models/gemini-2.5-flash:generateContent`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Goog-User-Project": googleCloudProject
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ text: [
            "Match the user's possibly misspelled, transliterated, or translated phrase to one lyric line.",
            "Return null when there is no credible match. Return only the supplied zero-based line index.",
            `User phrase: ${phrase}`,
            "Numbered lyric lines:",
            numberedLyrics
          ].join("\n") }]
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 128,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: { index: { type: "INTEGER", nullable: true } },
            required: ["index"]
          }
        }
      }),
      signal: AbortSignal.timeout(20_000)
    }
  );
  const payload = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(payload.error?.message || `Vertex AI returned ${response.status}`);
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  const parsed = JSON.parse(text) as { index?: unknown };
  const index = typeof parsed.index === "number" && Number.isInteger(parsed.index) ? parsed.index : null;
  return index !== null && index >= 0 && index < lines.length ? index : null;
}

async function fetchLrclibLyrics(track: {
  trackName: string;
  artistName: string;
  albumName: string;
  durationSeconds: number;
}): Promise<string | null> {
  const cacheKey = JSON.stringify(track).toLocaleLowerCase();
  const cached = lyricsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.syncedLyrics;

  await throttleLrclib();

  const endpoint = new URL("https://lrclib.net/api/get");
  const parameters = new URLSearchParams({
    track_name: track.trackName,
    artist_name: track.artistName,
    duration: String(track.durationSeconds)
  });
  if (track.albumName) parameters.set("album_name", track.albumName);
  endpoint.search = parameters.toString();
  const result = await fetch(endpoint, {
    headers: { "User-Agent": "SpotifyCustomClient/0.1 (personal accessibility integration)" },
    signal: AbortSignal.timeout(15_000)
  });

  let syncedLyrics: string | null = null;
  if (result.ok) {
    const payload = await result.json() as { syncedLyrics?: string | null };
    syncedLyrics = payload.syncedLyrics?.trim() || null;
  } else if (result.status === 404) {
    await throttleLrclib();
    const searchEndpoint = new URL("https://lrclib.net/api/search");
    searchEndpoint.search = new URLSearchParams({
      track_name: track.trackName,
      artist_name: track.artistName
    }).toString();
    const searchResponse = await fetch(searchEndpoint, {
      headers: { "User-Agent": "SpotifyCustomClient/0.1 (personal accessibility integration)" },
      signal: AbortSignal.timeout(15_000)
    });
    if (searchResponse.ok) {
      const candidates = await searchResponse.json() as Array<{ duration?: number; syncedLyrics?: string | null }>;
      syncedLyrics = candidates
        .filter((candidate) => candidate.syncedLyrics && Math.abs((candidate.duration || 0) - track.durationSeconds) <= 8)
        .sort((left, right) =>
          Math.abs((left.duration || 0) - track.durationSeconds) - Math.abs((right.duration || 0) - track.durationSeconds)
        )[0]?.syncedLyrics?.trim() || null;
    } else if (searchResponse.status !== 404) {
      throw new Error(`LRCLIB search returned ${searchResponse.status}`);
    }
  } else {
    const payload = await result.json().catch(() => null) as { message?: string } | null;
    throw new Error(payload?.message || `LRCLIB returned ${result.status}`);
  }

  lyricsCache.set(cacheKey, {
    expiresAt: Date.now() + (syncedLyrics ? 24 * 60 * 60_000 : 10 * 60_000),
    syncedLyrics
  });
  return syncedLyrics;
}

async function throttleLrclib(): Promise<void> {
  const delay = Math.max(0, 300 - (Date.now() - lastLyricsRequestAt));
  if (delay) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  lastLyricsRequestAt = Date.now();
}
