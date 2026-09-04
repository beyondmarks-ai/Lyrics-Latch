import { readFile } from "node:fs/promises";

const file = process.argv[2];
if (!file) throw new Error("Usage: npm run test:speech -- C:\\path\\to\\mono-16khz.wav");

const wave = await readFile(file);
if (wave.toString("ascii", 0, 4) !== "RIFF" || wave.toString("ascii", 8, 12) !== "WAVE") {
  throw new Error("The test file must be a WAV file");
}

let pcm;
for (let offset = 12; offset + 8 <= wave.length;) {
  const chunk = wave.toString("ascii", offset, offset + 4);
  const size = wave.readUInt32LE(offset + 4);
  if (chunk === "data") {
    pcm = wave.subarray(offset + 8, offset + 8 + size);
    break;
  }
  offset += 8 + size + (size % 2);
}
if (!pcm?.length) throw new Error("No PCM data chunk was found in the WAV file");

const response = await fetch("http://127.0.0.1:43821/api/speech/recognize", {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream" },
  body: pcm
});
const payload = await response.json();
if (!response.ok) throw new Error(payload.error || `Speech recognition returned ${response.status}`);
if (!payload.transcript) throw new Error("Speech recognition returned an empty transcript");
console.log(`PASS: ${payload.provider || "speech"} transcript: “${payload.transcript}”`);
