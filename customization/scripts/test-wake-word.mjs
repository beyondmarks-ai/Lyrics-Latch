import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OpenWakeWord } from "openwakeword-web";
import * as ort from "onnxruntime-web";

const root = resolve(import.meta.dirname, "..");
const models = resolve(root, "assets", "models");
const clipPath = process.argv[2] ? resolve(process.argv[2]) : null;
const threshold = Number(process.env.WAKE_WORD_THRESHOLD || 0.5);

ort.env.wasm.numThreads = 1;
const classifier = await ort.InferenceSession.create(resolve(models, "hey_monday.onnx"), {
  executionProviders: ["wasm"]
});
const inputShape = classifier.inputMetadata[0]?.shape;
const outputShape = classifier.outputMetadata[0]?.shape;
if (JSON.stringify(inputShape) !== JSON.stringify([1, 16, 96]) || JSON.stringify(outputShape) !== JSON.stringify([1, 1])) {
  throw new Error(`Unexpected Hey Monday model shape: ${JSON.stringify(inputShape)} -> ${JSON.stringify(outputShape)}`);
}

const detector = await OpenWakeWord.create({
  baseUrl: `${models}\\`,
  wakewordModels: [{ name: "hey_monday", url: "hey_monday.onnx", inputFrames: 16 }],
  threshold
});

if (!clipPath) {
  for (let i = 0; i < 10; i++) await detector.predict(new Int16Array(1280));
  console.log("PASS: model shape, feature pipeline, and silence inference are valid.");
  process.exit(0);
}

const audio = readPcm16Wave(await readFile(clipPath));
const padded = new Int16Array(16000 + audio.length + 16000);
padded.set(audio, 16000);
let maximum = 0;
for (let offset = 0; offset < padded.length; offset += 1280) {
  const frame = new Int16Array(1280);
  frame.set(padded.subarray(offset, offset + 1280));
  const score = (await detector.predict(frame)).hey_monday ?? 0;
  maximum = Math.max(maximum, score);
}

console.log(`Hey Monday maximum score: ${maximum.toFixed(4)} (threshold ${threshold})`);
if (maximum < threshold) throw new Error("Wake word was not detected in the supplied clip.");
console.log("PASS: Hey Monday was detected.");

function readPcm16Wave(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Test audio must be a WAV file.");
  }

  let format;
  let data;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      format = {
        encoding: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bits: buffer.readUInt16LE(start + 14)
      };
    } else if (id === "data") {
      data = buffer.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }

  if (!format || !data || format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bits !== 16) {
    throw new Error(`Expected mono 16-bit PCM at 16 kHz, received ${JSON.stringify(format)}`);
  }
  return new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
}
