const targets = await (await fetch("http://127.0.0.1:8088/json")).json();
const query = process.argv.slice(2).join(" ").trim() || "shape of you";
const target = targets.find((entry) => entry.type === "page" && entry.url.includes("xpui"));
if (!target) throw new Error("Spotify remote-debugging target was not found on port 8088.");

const socket = new WebSocket(target.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Spotify evaluation timed out")), 10000);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: {
        expression: `(async () => {
          try {
            const response = await Spicetify.GraphQL.Request(
              { name: "searchTopResultsList", operation: "query", sha256Hash: "337d8b1b4f911fb12c60996623391703c2807550baccb51d95f5eabc8c8bdacd", value: null },
              {
                query: ${JSON.stringify(query)}, limit: 10, offset: 0, numberOfTopResults: 10,
                includeArtistHasConcertsField: false, includeAudiobooks: true, includeAuthors: false,
                includePreReleases: true, includeAlbumPreReleases: false,
                includeEpisodeContentRatingsV2: true, isPrefix: null,
                sectionFilters: ["GENERIC", "VIDEO_CONTENT"]
              }
            );
            const data = response?.data?.searchV2?.topResultsV2?.itemsV2
              ?.map((entry) => entry.item?.data)
              .find((item) => item?.__typename === "Track" && item.playability?.playable !== false && item.uri);
            if (!data) return { error: "No playable track in Spotify search response" };
            await Spicetify.Player.playUri(data.uri);
            return {
              track: {
                uri: data.uri,
                name: data.name,
                artists: data.artists?.items?.map((artist) => artist.profile?.name).filter(Boolean) ?? []
              }
            };
          } catch (error) {
            return { error: String(error), stack: error?.stack };
          }
        })()`,
        awaitPromise: true,
        returnByValue: true
      }
    }));
  });
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
if (!result.track) throw new Error(result.error || "Spotify did not return a playable track");
console.log(`PASS: Spotify is playing ${result.track.name} by ${result.track.artists.join(", ")}`);
