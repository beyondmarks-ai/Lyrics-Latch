import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const watching = process.argv.includes("--watch");

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "CustomApps", "lyriclatch"), { recursive: true });
await mkdir(resolve(dist, "Extensions"), { recursive: true });
await mkdir(resolve(dist, "companion"), { recursive: true });

const appOptions = {
  entryPoints: [resolve(root, "src", "app", "index.ts")],
  outfile: resolve(dist, "CustomApps", "lyriclatch", "index.js"),
  bundle: true,
  format: "iife",
  globalName: "LyricLatchApp",
  footer: { js: "function render() { return LyricLatchApp.render(); }" },
  target: "es2022",
  sourcemap: true
};

const extensionOptions = {
  entryPoints: [resolve(root, "src", "extension", "index.ts")],
  outfile: resolve(dist, "Extensions", "lyriclatch.js"),
  bundle: true,
  format: "iife",
  target: "es2022",
  sourcemap: true
};

const companionOptions = {
  entryPoints: [resolve(root, "src", "companion", "server.ts")],
  outfile: resolve(dist, "companion", "server.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  target: "node22",
  sourcemap: true
};

await cp(
  resolve(root, "src", "app", "manifest.json"),
  resolve(dist, "CustomApps", "lyriclatch", "manifest.json")
);
await cp(
  resolve(root, "src", "styles", "app.css"),
  resolve(dist, "CustomApps", "lyriclatch", "style.css")
);
await cp(
  resolve(root, "assets", "models"),
  resolve(dist, "companion", "public", "models"),
  { recursive: true }
);
await cp(
  resolve(root, "node_modules", "openwakeword-web", "src", "mic-worklet.js"),
  resolve(dist, "companion", "public", "mic-worklet.js")
);
await mkdir(resolve(dist, "companion", "public", "ort"), { recursive: true });
for (const file of [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm"
]) {
  await cp(
    resolve(root, "node_modules", "onnxruntime-web", "dist", file),
    resolve(dist, "companion", "public", "ort", file)
  );
}

if (watching) {
  const app = await context(appOptions);
  const extension = await context(extensionOptions);
  const companion = await context(companionOptions);
  await Promise.all([app.watch(), extension.watch(), companion.watch()]);
  console.log("Watching custom app, extension, and companion sources...");
} else {
  await Promise.all([build(appOptions), build(extensionOptions), build(companionOptions)]);
  console.log(`Built LyricLatch into ${dist}`);
}
