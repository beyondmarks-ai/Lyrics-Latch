import { fetchAlternativeSyncedLyrics, matchLyricWithAI } from "../shared/companion";
import { chooseDefaultLoopEnd, findBestLyricMatch, type LyricMatch, type TimedLyricLine } from "./lyric-match";

interface SpotifyLyricsResponse {
  lyrics?: {
    syncType?: string;
    lines?: Array<{ startTimeMs?: string; words?: string }>;
  };
}

interface ActiveSectionLoop {
  trackUri: string;
  startMs: number;
  endMs: number;
  previousRepeat: number;
  startPhrase?: string;
  endPhrase?: string;
  startIndex?: number;
  lines?: TimedLyricLine[];
  matchedText?: string;
}

interface SyncedLyricsResult {
  lines: TimedLyricLine[];
  provider: "spotify" | "lrclib";
}

const LOCAL_MATCH_CONFIDENCE = 0.72;
const MINIMUM_MATCH_CONFIDENCE = 0.44;
const MINIMUM_LOOP_MS = 1_500;

class SectionLoopController {
  private active: ActiveSectionLoop | null = null;
  private timer: number | null = null;
  private lastSeekAt = 0;
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    Spicetify.Player.addEventListener("songchange", () => {
      if (this.active && currentTrackUri() !== this.active.trackUri) this.stop(false);
    });
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  async startByPhrase(startPhrase: string, endPhrase?: string): Promise<string> {
    const trackUri = currentTrackUri();
    if (!trackUri?.startsWith("spotify:track:")) return "Play a Spotify track before creating a section loop";

    let lyrics: SyncedLyricsResult;
    try {
      lyrics = await fetchSyncedLyrics(trackUri);
    } catch (error) {
      return error instanceof Error ? error.message : "Couldn't load synchronized lyrics for this song";
    }
    const { lines } = lyrics;
    const startMatch = await resolveLyricMatch(lines, startPhrase);
    if (!startMatch) return `I couldn't match “${startPhrase}” in this song's synchronized lyrics`;

    const duration = Spicetify.Player.getDuration();
    let endMs: number;
    if (endPhrase) {
      const endMatch = await resolveLyricMatch(lines, endPhrase, Math.max(-1, startMatch.index - 1));
      if (!endMatch || endMatch.index < startMatch.index) {
        return `I found the start, but couldn't match the ending words “${endPhrase}” after it`;
      }
      endMs = lines[endMatch.index + 1]?.startTimeMs ?? Math.min(duration, lines[endMatch.index].startTimeMs + 5_000);
    } else {
      endMs = chooseDefaultLoopEnd(lines, startMatch.index, duration);
    }

    const startMs = Math.max(0, lines[startMatch.index].startTimeMs - 120);
    this.activate({
      trackUri,
      startMs,
      endMs: Math.max(startMs + MINIMUM_LOOP_MS, endMs),
      previousRepeat: Spicetify.Player.getRepeat(),
      startPhrase,
      endPhrase,
      startIndex: startMatch.index,
      lines,
      matchedText: startMatch.text
    });
    const provider = lyrics.provider === "lrclib" ? " using alternative synchronized lyrics" : "";
    return `Looping “${startMatch.text}” from ${formatTimestamp(startMs)} to ${formatTimestamp(endMs)}${provider}`;
  }

  startByTime(startMs: number, endMs: number): string {
    const trackUri = currentTrackUri();
    const duration = Spicetify.Player.getDuration();
    if (!trackUri || !duration) return "Play a song before creating a section loop";
    if (endMs <= startMs + MINIMUM_LOOP_MS) return "The loop ending must be at least 1.5 seconds after its start";
    if (startMs >= duration) return "The loop start is beyond the end of this song";

    const boundedEnd = Math.min(endMs, duration);
    this.activate({
      trackUri,
      startMs: Math.max(0, startMs),
      endMs: boundedEnd,
      previousRepeat: Spicetify.Player.getRepeat()
    });
    return `Looping from ${formatTimestamp(startMs)} to ${formatTimestamp(boundedEnd)}`;
  }

  stop(resume = true): boolean {
    if (!this.active) return false;
    const previousRepeat = this.active.previousRepeat;
    this.active = null;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    Spicetify.Player.setRepeat(previousRepeat);
    if (resume) Spicetify.Player.play();
    return true;
  }

  adjust(direction: "longer" | "shorter"): string {
    if (!this.active) return "There is no active section loop";
    const duration = Spicetify.Player.getDuration();
    const delta = direction === "longer" ? 2_000 : -2_000;
    this.active.endMs = Math.min(duration, Math.max(this.active.startMs + MINIMUM_LOOP_MS, this.active.endMs + delta));
    return `Loop is now ${formatTimestamp(this.active.endMs - this.active.startMs)} long`;
  }

  async nextOccurrence(): Promise<string> {
    const state = this.active;
    if (!state?.lines || !state.startPhrase || state.startIndex === undefined) {
      return "The active loop was not created from lyrics";
    }
    const match = await resolveLyricMatch(state.lines, state.startPhrase, state.startIndex);
    if (!match) return "There is no later matching occurrence in this song";

    state.startIndex = match.index;
    state.startMs = Math.max(0, state.lines[match.index].startTimeMs - 120);
    state.endMs = chooseDefaultLoopEnd(state.lines, match.index, Spicetify.Player.getDuration());
    state.matchedText = match.text;
    Spicetify.Player.seek(state.startMs);
    Spicetify.Player.play();
    return `Looping the next “${match.text}” at ${formatTimestamp(state.startMs)}`;
  }

  private activate(state: ActiveSectionLoop): void {
    if (this.active) {
      state.previousRepeat = this.active.previousRepeat;
      this.stop(false);
    }
    this.active = state;
    this.lastSeekAt = 0;
    Spicetify.Player.setRepeat(2);
    Spicetify.Player.seek(state.startMs);
    Spicetify.Player.play();
    this.timer = window.setInterval(() => this.enforceLoop(), 80);
  }

  private enforceLoop(): void {
    const state = this.active;
    if (!state) return;
    if (currentTrackUri() !== state.trackUri) {
      this.stop(false);
      return;
    }
    const now = performance.now();
    if (Spicetify.Player.getProgress() >= state.endMs - 40 && now - this.lastSeekAt > 300) {
      this.lastSeekAt = now;
      Spicetify.Player.seek(state.startMs);
    }
  }
}

async function fetchSyncedLyrics(trackUri: string): Promise<SyncedLyricsResult> {
  const id = trackUri.split(":")[2];
  let response: SpotifyLyricsResponse | null = null;
  try {
    response = await Spicetify.CosmosAsync.get(
      `https://spclient.wg.spotify.com/color-lyrics/v2/track/${id}?format=json&vocalRemoval=false&market=from_token`
    ) as SpotifyLyricsResponse;
  } catch {
    // Continue to the alternative synchronized-lyrics provider.
  }
  if (response?.lyrics?.syncType === "LINE_SYNCED") {
    const spotifyLines = response.lyrics.lines
      ?.map((line) => ({ startTimeMs: Number(line.startTimeMs), words: line.words?.trim() || "" }))
      .filter((line) => Number.isFinite(line.startTimeMs) && Boolean(line.words)) || [];
    if (spotifyLines.length) return { lines: spotifyLines, provider: "spotify" };
  }

  const track = Spicetify.Player.data?.item;
  const trackName = track?.name || track?.metadata?.title || "";
  const artistName = track?.artists?.map((artist) => artist.name).filter(Boolean).join(", ")
    || track?.metadata?.artist_name || "";
  const albumName = track?.album?.name || track?.metadata?.album_title || "";
  const syncedLyrics = await fetchAlternativeSyncedLyrics({
    trackName,
    artistName,
    albumName,
    durationSeconds: Math.round(Spicetify.Player.getDuration() / 1_000)
  });
  const alternativeLines = syncedLyrics ? parseLrc(syncedLyrics) : [];
  if (alternativeLines.length) return { lines: alternativeLines, provider: "lrclib" };

  throw new Error(
    "Couldn't find synchronized lyrics from Spotify or the alternative provider. Say “loop from 1 minute to 1 minute 10 seconds”."
  );
}

export function parseLrc(value: string): TimedLyricLine[] {
  const lines: TimedLyricLine[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const words = rawLine.replace(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g, "").trim();
    if (!words) continue;
    for (const timestamp of rawLine.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g)) {
      const startTimeMs = Math.round((Number(timestamp[1]) * 60 + Number(timestamp[2])) * 1_000);
      if (Number.isFinite(startTimeMs)) lines.push({ startTimeMs, words });
    }
  }
  return lines.sort((left, right) => left.startTimeMs - right.startTimeMs);
}

async function resolveLyricMatch(
  lines: TimedLyricLine[],
  phrase: string,
  afterIndex = -1
): Promise<LyricMatch | null> {
  const local = findBestLyricMatch(lines, phrase, afterIndex);
  if (local && local.score >= LOCAL_MATCH_CONFIDENCE) return local;

  try {
    const subsetStart = Math.max(0, afterIndex + 1);
    const aiIndex = await matchLyricWithAI(phrase, lines.slice(subsetStart).map((line) => line.words));
    if (aiIndex !== null) {
      const index = subsetStart + aiIndex;
      return { index, score: 1, text: lines[index].words };
    }
  } catch (error) {
    console.warn("[LyricLatch] Vertex lyric matching unavailable; using local matcher", error);
  }
  return local && local.score >= MINIMUM_MATCH_CONFIDENCE ? local : null;
}

function currentTrackUri(): string | null {
  return Spicetify.Player.data?.item?.uri || null;
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export const sectionLoop = new SectionLoopController();
