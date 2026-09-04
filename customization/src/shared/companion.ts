export interface CompanionStatus {
  ready: boolean;
  wakeWordModelReady: boolean;
  speechConfigured: boolean;
  sarvamConfigured: boolean;
  speechProvider: "sarvam" | "google";
  aiLyricMatchingConfigured: boolean;
  youtubeConfigured: boolean;
}

const COMPANION_URL = "http://127.0.0.1:43821";

export async function getCompanionStatus(): Promise<CompanionStatus> {
  const response = await fetch(`${COMPANION_URL}/health`);
  if (!response.ok) throw new Error(`Companion returned ${response.status}`);
  return response.json() as Promise<CompanionStatus>;
}

export async function searchYouTube(query: string) {
  const response = await fetch(`${COMPANION_URL}/api/youtube/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error(`YouTube search returned ${response.status}`);
  return response.json();
}

export async function recognizeVoiceCommand(audio: Int16Array): Promise<string> {
  const pcm = audio.slice().buffer as ArrayBuffer;
  const response = await fetch(`${COMPANION_URL}/api/speech/recognize`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: pcm
  });
  const payload = await response.json() as { transcript?: string; error?: string };
  if (!response.ok) throw new Error(payload.error || `Speech recognition returned ${response.status}`);
  return payload.transcript?.trim() || "";
}

export async function matchLyricWithAI(phrase: string, lines: string[]): Promise<number | null> {
  const response = await fetch(`${COMPANION_URL}/api/lyrics/match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phrase, lines })
  });
  const payload = await response.json() as { index?: number | null; error?: string };
  if (!response.ok) throw new Error(payload.error || `Lyric matching returned ${response.status}`);
  return Number.isInteger(payload.index) ? payload.index! : null;
}

export async function fetchAlternativeSyncedLyrics(track: {
  trackName: string;
  artistName: string;
  albumName?: string;
  durationSeconds: number;
}): Promise<string | null> {
  const response = await fetch(`${COMPANION_URL}/api/lyrics/synced`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(track)
  });
  const payload = await response.json() as { syncedLyrics?: string | null; error?: string };
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(payload.error || `Alternative lyrics returned ${response.status}`);
  return payload.syncedLyrics?.trim() || null;
}
