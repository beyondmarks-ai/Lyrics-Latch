import assert from "node:assert/strict";
import { chooseDefaultLoopEnd, findBestLyricMatch, parseSectionPhraseIntent } from "../src/extension/lyric-match";
import { parseLrc, sectionLoop } from "../src/extension/section-loop";

const lines = [
  { startTimeMs: 0, words: "Music" },
  { startTimeMs: 8_000, words: "Raghupati Raghav Raja Ram" },
  { startTimeMs: 12_000, words: "Non stop party aaj ki party" },
  { startTimeMs: 17_000, words: "Celebrations tere naam" },
  { startTimeMs: 24_000, words: "Raghupati Raghav Raja Ram" }
];

assert.deepEqual(parseSectionPhraseIntent("loop the part starting from words Raghupati Raghav"), {
  startPhrase: "Raghupati Raghav"
});
assert.deepEqual(parseSectionPhraseIntent("loop from Raghupati Raghav to celebrations tere naam"), {
  startPhrase: "Raghupati Raghav",
  endPhrase: "celebrations tere naam"
});
assert.deepEqual(parseSectionPhraseIntent("in this song there is a part where it starts from word such as raghupati raghav"), {
  startPhrase: "raghupati raghav"
});

const fuzzy = findBestLyricMatch(lines, "raghupathi ragav raja ram");
assert.equal(fuzzy?.index, 1);
assert.ok((fuzzy?.score || 0) >= 0.7);
assert.equal(findBestLyricMatch(lines, "raghupati raghav", 1)?.index, 4);
assert.equal(chooseDefaultLoopEnd(lines, 1, 30_000), 17_000);

let progress = 0;
let repeat = 0;
const seeks: number[] = [];
const listeners = new Map<string, () => void>();
Object.assign(globalThis, {
  window: globalThis,
  Spicetify: {
    Player: {
      data: { item: { uri: "spotify:track:test" } },
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      getDuration: () => 30_000,
      getProgress: () => progress,
      getRepeat: () => repeat,
      setRepeat: (value: number) => { repeat = value; },
      seek: (value: number) => { progress = value; seeks.push(value); },
      play: () => undefined
    },
    CosmosAsync: {
      get: async () => ({
        lyrics: {
          syncType: "LINE_SYNCED",
          lines: lines.map((line) => ({ startTimeMs: String(line.startTimeMs), words: line.words }))
        }
      })
    }
  }
});

sectionLoop.initialize();
const response = await sectionLoop.startByPhrase("Raghupati Raghav Raja Ram");
assert.match(response, /^Looping/);
assert.equal(repeat, 2);
assert.equal(seeks.at(-1), 7_880);
const seeksBeforeBoundary = seeks.length;
progress = 17_000;
await new Promise((resolve) => setTimeout(resolve, 360));
assert.equal(seeks.length, seeksBeforeBoundary + 1);
assert.equal(seeks.at(-1), 7_880, "the active loop should seek back to its A point");
assert.equal(sectionLoop.stop(false), true);
assert.equal(repeat, 0, "stopping should restore the user's previous repeat mode");

const parsedLrc = parseLrc("[00:08.25]Raghupati Raghav Raja Ram\n[00:12.500]Non stop party");
assert.deepEqual(parsedLrc, [
  { startTimeMs: 8_250, words: "Raghupati Raghav Raja Ram" },
  { startTimeMs: 12_500, words: "Non stop party" }
]);
(globalThis as any).Spicetify.CosmosAsync.get = async () => ({ lyrics: { syncType: "UNSYNCED" } });
Object.assign(globalThis, {
  fetch: async () => new Response(JSON.stringify({
    syncedLyrics: "[00:08.25]Raghupati Raghav Raja Ram\n[00:12.50]Non stop party\n[00:18.00]Celebrations"
  }), { status: 200, headers: { "Content-Type": "application/json" } })
});
const fallbackResponse = await sectionLoop.startByPhrase("Raghupati Raghav");
assert.match(fallbackResponse, /alternative synchronized lyrics/);
assert.equal(seeks.at(-1), 8_130);
sectionLoop.stop(false);

console.log("PASS: intent parsing, fuzzy matching, boundaries, enforcement, repeat restoration, and alternative lyrics fallback");
