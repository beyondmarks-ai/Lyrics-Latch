import { searchYouTube } from "../shared/companion";
import { parseSectionPhraseIntent } from "./lyric-match";
import { sectionLoop } from "./section-loop";

interface SpotifyTrack {
  uri: string;
  name: string;
  artists?: Array<{ name: string }>;
}

interface SpotifySearchResponse {
  data?: {
    searchV2?: {
      topResultsV2?: {
        itemsV2?: Array<{
          item?: {
            data?: SpotifyTrack & {
              __typename?: string;
              playability?: { playable?: boolean };
              artists?: { items?: Array<{ profile?: { name?: string } }> };
            };
          };
        }>;
      };
    };
  };
}

interface YouTubeSearchResponse {
  items?: Array<{ snippet?: { title?: string } }>;
}

export interface VoiceFollowUpRequest {
  message: string;
  followUp: "section-loop-details";
}

export type VoiceCommandResult = string | VoiceFollowUpRequest;

export async function executeVoiceCommand(rawCommand: string): Promise<VoiceCommandResult> {
  const command = rawCommand.trim().toLowerCase();

  if (/^(play|resume|continue)(?: (?:music|song|playback))?$/.test(command)) {
    Spicetify.Player.play();
    return "Playing";
  }
  if (/^(pause|stop)(?: (?:music|song|playback))?$/.test(command)) {
    Spicetify.Player.pause();
    return "Paused";
  }

  const absoluteSeek = command.match(/^(?:skip|jump|seek|go) to (.+)$/);
  if (absoluteSeek) {
    const milliseconds = parseDuration(absoluteSeek[1]);
    if (milliseconds) {
      Spicetify.Player.seek(milliseconds);
      Spicetify.Player.play();
      return `Jumped to ${formatDuration(milliseconds)}`;
    }
  }

  const forwardSeek = command.match(/^(?:(?:skip|jump|go) (?:forward|ahead)|fast forward|forward|skip) (.+)$/);
  if (forwardSeek) {
    const milliseconds = parseDuration(forwardSeek[1]);
    if (milliseconds) {
      Spicetify.Player.skipForward(milliseconds);
      Spicetify.Player.play();
      return `Skipped forward ${formatDuration(milliseconds)}`;
    }
  }

  const backwardSeek = command.match(/^(?:rewind|back|(?:skip|jump|go) back) (.+)$/);
  if (backwardSeek) {
    const milliseconds = parseDuration(backwardSeek[1]);
    if (milliseconds) {
      Spicetify.Player.skipBack(milliseconds);
      Spicetify.Player.play();
      return `Rewound ${formatDuration(milliseconds)}`;
    }
  }

  if (/^(next|next (?:song|track)|skip|skip (?:song|track))$/.test(command)) {
    Spicetify.Player.next();
    Spicetify.Player.play();
    return "Skipping";
  }
  if (/^(previous|previous (?:song|track)|last (?:song|track)|go back)$/.test(command)) {
    // Spotify's first Previous press restarts a track once it is a few seconds in.
    // Seek to the beginning first so the following press always changes queue items.
    Spicetify.Player.seek(0);
    await wait(150);
    Spicetify.Player.back();
    await wait(150);
    Spicetify.Player.play();
    return "Going back";
  }

  if (/^(?:please )?(?:loop|repeat) (?:(?:a|the|this) )?(?:song )?(?:part|section)(?: of (?:this|the) song)?$/.test(command)) {
    return {
      message: "Which part should I loop? Say the starting lyrics, or a time range like from one minute twenty seconds to one minute thirty seconds.",
      followUp: "section-loop-details"
    };
  }

  const timedSection = command.match(
    /^(?:loop|repeat)(?: the)?(?: part| section)? from (.+?) (?:to|until|through) (.+)$/
  );
  if (timedSection) {
    const startMs = parseDuration(timedSection[1]);
    const endMs = parseDuration(timedSection[2]);
    if (startMs && endMs) return sectionLoop.startByTime(startMs, endMs);
  }

  const phraseIntent = parseSectionPhraseIntent(command);
  if (phraseIntent) return sectionLoop.startByPhrase(phraseIntent.startPhrase, phraseIntent.endPhrase);

  if (/^(?:make (?:the loop|it) |loop )(?:a little )?longer$|^extend (?:the )?loop$/.test(command)) {
    return sectionLoop.adjust("longer");
  }
  if (/^(?:make (?:the loop|it) |loop )(?:a little )?shorter$|^shorten (?:the )?loop$/.test(command)) {
    return sectionLoop.adjust("shorter");
  }
  if (/^(?:next|another) occurrence$|^(?:loop|use) the next (?:one|occurrence)$/.test(command)) {
    return sectionLoop.nextOccurrence();
  }

  if (/^(?:repeat|loop)(?: (?:this|current))?(?: song| track)?$/.test(command)) {
    Spicetify.Player.setRepeat(2);
    Spicetify.Player.play();
    return "Looping this song";
  }
  if (/^(?:repeat|loop)(?: all| queue| playlist)$/.test(command)) {
    Spicetify.Player.setRepeat(1);
    Spicetify.Player.play();
    return "Looping the queue";
  }
  if (/^(?:(?:stop|disable|turn off) (?:repeat|loop)(?:ing)?|i(?:'m| am) satisfied|that(?:'s| is) enough|done with (?:the )?loop)$/.test(command)) {
    if (sectionLoop.stop()) return "Section loop stopped";
    Spicetify.Player.setRepeat(0);
    Spicetify.Player.play();
    return "Loop off";
  }

  const volume = command.match(/^volume(?: to)? (\d{1,3})(?: percent)?$/);
  if (volume) {
    const percent = Math.min(100, Number(volume[1]));
    Spicetify.Player.setVolume(percent / 100);
    return `Volume ${percent}%`;
  }

  const songQuery = command
    .replace(/^(?:play|search(?: spotify)? for|find)(?: the)?(?: song| track)?\s+/, "")
    .trim();
  if (!songQuery) return "Tell me which song to play";

  Spicetify.showNotification(`Identifying “${songQuery}”...`);

  // Resolve spoken lyrics, misspellings, and incomplete titles through YouTube first.
  const youtubeTitle = await findYouTubeTitle(songQuery);
  let track: SpotifyTrack | null = null;
  if (youtubeTitle) track = await findSpotifyTrack(youtubeTitle);

  // Preserve direct Spotify lookup when YouTube is unavailable or its title is not on Spotify.
  if (!track) track = await findSpotifyTrack(songQuery);

  if (!track) return `Couldn't find “${songQuery}” on Spotify`;
  await Spicetify.Player.playUri(track.uri);
  const artists = track.artists?.map((artist) => artist.name).filter(Boolean).join(", ");
  return artists ? `Playing ${track.name} by ${artists}` : `Playing ${track.name}`;
}

async function findSpotifyTrack(query: string): Promise<SpotifyTrack | null> {
  const definition = {
    name: "searchTopResultsList",
    operation: "query",
    sha256Hash: "337d8b1b4f911fb12c60996623391703c2807550baccb51d95f5eabc8c8bdacd",
    value: null
  };
  const result = await Spicetify.GraphQL.Request(definition as never, {
    query,
    limit: 10,
    offset: 0,
    numberOfTopResults: 10,
    includeArtistHasConcertsField: false,
    includeAudiobooks: true,
    includeAuthors: false,
    includePreReleases: true,
    includeAlbumPreReleases: false,
    includeEpisodeContentRatingsV2: true,
    isPrefix: null,
    sectionFilters: ["GENERIC", "VIDEO_CONTENT"]
  }) as SpotifySearchResponse;
  const data = result.data?.searchV2?.topResultsV2?.itemsV2
    ?.map((entry) => entry.item?.data)
    .find((item) => item?.__typename === "Track" && item.playability?.playable !== false && item.uri);
  if (!data) return null;
  return {
    uri: data.uri,
    name: data.name,
    artists: data.artists?.items
      ?.map((artist) => artist.profile?.name)
      .filter((name): name is string => Boolean(name))
      .map((name) => ({ name }))
  };
}

async function findYouTubeTitle(query: string): Promise<string | null> {
  try {
    const result = await searchYouTube(`${query} official song`) as YouTubeSearchResponse;
    const title = result.items?.[0]?.snippet?.title;
    return title ? cleanYouTubeTitle(title) : null;
  } catch (error) {
    console.warn("[LyricLatch] YouTube song lookup failed", error);
    return null;
  }
}

export function cleanYouTubeTitle(title: string): string {
  const decoded = decodeHtml(title).trim();
  const quotedTitle = decoded.match(/^["“](.+?)["”]/)?.[1]?.trim();
  if (quotedTitle) return quotedTitle;

  return decoded
    .replace(/\s*[\[(](?:official|lyrics?|audio|video|music video|visuali[sz]er)[^\])]*[\])]/gi, "")
    .replace(/\s*[-|]\s*(?:official|lyrics?|audio|video|music video).*$/gi, "")
    .replace(/\s+(?:full\s+)?(?:official\s+)?(?:video|audio|lyrics?|song|music video|visuali[sz]er)(?:\s+song)?(?:\s+teaser)?\b.*$/i, "")
    .trim();
}

function decodeHtml(value: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseDuration(value: string): number | null {
  const clock = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (clock) return (Number(clock[1]) * 60 + Number(clock[2])) * 1_000;
  const numberWords: Record<string, number> = {
    a: 1,
    an: 1,
    half: 0.5,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    fifteen: 15,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60
  };
  const parts = value.matchAll(
    /(\d+(?:\.\d+)?|a|an|half|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)/g
  );
  let milliseconds = 0;
  for (const part of parts) {
    const amount = Number(part[1]) || numberWords[part[1]];
    const unit = part[2];
    if (unit.startsWith("hour") || unit.startsWith("hr")) milliseconds += amount * 3_600_000;
    else if (unit.startsWith("min")) milliseconds += amount * 60_000;
    else milliseconds += amount * 1_000;
  }
  return milliseconds > 0 ? Math.min(milliseconds, 3_600_000) : null;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.round(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  if (!seconds) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"} ${seconds} seconds`;
}
