import { build } from "esbuild";
import { resolve } from "node:path";

const entry = process.argv[2];
if (!entry) throw new Error("A TypeScript test entry is required");
const result = await build({
  entryPoints: [resolve(entry)],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22"
});
const source = result.outputFiles[0].text;
await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
