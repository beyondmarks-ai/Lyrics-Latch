import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OpenWakeWord } from "openwakeword-web";

const clipPath = process.argv[2] ? resolve(process.argv[2]) : null;
if (!clipPath) throw new Error("Pass a mono 16 kHz PCM WAV containing ‘Hey Monday’ followed by a command.");

const root = resolve(import.meta.dirname, "..");
const models = resolve(root, "assets", "models");
let capturedAudio;
const captured = new Promise((resolveCapture) => {
  capturedAudio = resolveCapture;
});
const detector = await OpenWakeWord.create({
  baseUrl: `${models}\\`,
  wakewordModels: [{ name: "hey_monday", url: "hey_monday.onnx", inputFrames: 16 }],
  threshold: 0.5,
  onUtterance: ({ audio }) => capturedAudio(audio),
  vadStopThreshold: 0.5,
  vadStopFrames: 15,
  maxCaptureDuration: 8,
  ort: { numThreads: 1 }
});

const command = readPcm16Wave(await readFile(clipPath));
const padded = new Int16Array(16000 + command.length + 48000);
padded.set(command, 16000);
for (let offset = 0; offset < padded.length; offset += 1280) {
  const frame = new Int16Array(1280);
  frame.set(padded.subarray(offset, offset + 1280));
  await detector.predict(frame);
}

const audio = await Promise.race([
  captured,
  new Promise((_, reject) => setTimeout(() => reject(new Error("Wake/utterance capture did not fire")), 1000))
]);
const response = await fetch("http://127.0.0.1:43821/api/speech/recognize", {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream" },
  body: Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
});
const payload = await response.json();
if (!response.ok) throw new Error(payload.error || `Speech endpoint returned ${response.status}`);
console.log(`PASS: wake word detected, command captured, ${payload.provider || "speech"} transcript: “${payload.transcript}”`);

function readPcm16Wave(buffer) {
  let format;
  let data;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      format = [buffer.readUInt16LE(start), buffer.readUInt16LE(start + 2), buffer.readUInt32LE(start + 4), buffer.readUInt16LE(start + 14)];
    } else if (id === "data") data = buffer.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!data || JSON.stringify(format) !== JSON.stringify([1, 1, 16000, 16])) {
    throw new Error(`Expected mono 16-bit PCM at 16 kHz, received ${JSON.stringify(format)}`);
  }
  return new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
}
