const targets = await (await fetch("http://127.0.0.1:8088/json")).json();
const target = targets.find((entry) => entry.type === "page" && entry.url.includes("xpui"));
if (!target) throw new Error("Spotify remote-debugging target was not found on port 8088");

const socket = new WebSocket(target.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Spotify section-loop test timed out")), 20_000);
  socket.addEventListener("open", () => socket.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let attempt = 0; attempt < 50 && !globalThis.Spicetify?.GraphQL; attempt++) await wait(200);
        const response = await Spicetify.GraphQL.Request(
          { name: "searchTopResultsList", operation: "query", sha256Hash: "337d8b1b4f911fb12c60996623391703c2807550baccb51d95f5eabc8c8bdacd", value: null },
          {
            query: "Raghupati Raghav Krrish 3", limit: 10, offset: 0, numberOfTopResults: 10,
            includeArtistHasConcertsField: false, includeAudiobooks: true, includeAuthors: false,
            includePreReleases: true, includeAlbumPreReleases: false,
            includeEpisodeContentRatingsV2: true, isPrefix: null,
            sectionFilters: ["GENERIC", "VIDEO_CONTENT"]
          }
        );
        const track = response?.data?.searchV2?.topResultsV2?.itemsV2
          ?.map((entry) => entry.item?.data)
          .find((item) => item?.__typename === "Track" && item?.uri);
        if (!track) return { error: "Test track was not found" };
        await Spicetify.Player.playUri(track.uri);
        await wait(1800);
        const id = track.uri.split(":")[2];
        const lyricResponse = await Spicetify.CosmosAsync.get(
          "https://spclient.wg.spotify.com/color-lyrics/v2/track/" + id + "?format=json&vocalRemoval=false&market=from_token"
        );
        const lines = lyricResponse?.lyrics?.lines ?? [];
        if (lyricResponse?.lyrics?.syncType !== "LINE_SYNCED" || !lines.length) {
          return { error: "Test track has no synchronized lyrics", track: track.name };
        }
        const usable = lines.find((line) => Number(line.startTimeMs) > 1000 && line.words?.trim());
        if (!usable) return { error: "No usable timed lyric line", track: track.name };
        const aiResponse = await fetch("http://127.0.0.1:43821/api/lyrics/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phrase: "raghupati raghav raja ram", lines: lines.map((line) => line.words) })
        });
        const aiMatch = await aiResponse.json();
        if (!aiResponse.ok || !Number.isInteger(aiMatch.index)) {
          return { error: aiMatch.error || "Vertex AI did not match Romanized words to the live lyrics", track: track.name };
        }
        const startMs = Number(usable.startTimeMs);
        const previousRepeat = Spicetify.Player.getRepeat();
        Spicetify.Player.setRepeat(2);
        Spicetify.Player.seek(startMs);
        Spicetify.Player.play();
        await wait(700);
        const observedProgress = Spicetify.Player.getProgress();
        Spicetify.Player.setRepeat(previousRepeat);
        return {
          track: track.name,
          uri: track.uri,
          syncType: lyricResponse.lyrics.syncType,
          lyricLineCount: lines.length,
          selectedLine: usable.words,
          aiMatchedIndex: aiMatch.index,
          aiMatchedLine: lines[aiMatch.index]?.words,
          startMs,
          observedProgress,
          seekWorked: observedProgress >= startMs && observedProgress < startMs + 3000
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    }
  })));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    resolve(message.result?.result?.value ?? message);
    socket.close();
  });
  socket.addEventListener("error", () => reject(new Error("Spotify debugging socket failed")));
});

console.log(JSON.stringify(result, null, 2));
if (result.error || !result.seekWorked) throw new Error(result.error || "Spotify did not seek to the lyric timestamp");
console.log(`PASS: live Spotify synchronized lyrics and timestamp seeking work for ${result.track}`);
