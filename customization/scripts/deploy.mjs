import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

if (process.platform !== "win32" || !process.env.APPDATA) {
  throw new Error("This deployment helper currently targets Windows.");
}

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const spicetify = resolve(process.env.APPDATA, "spicetify");

await mkdir(resolve(spicetify, "CustomApps"), { recursive: true });
await mkdir(resolve(spicetify, "Extensions"), { recursive: true });
await cp(
  resolve(dist, "CustomApps", "lyriclatch"),
  resolve(spicetify, "CustomApps", "lyriclatch"),
  { recursive: true, force: true }
);
await cp(
  resolve(dist, "Extensions", "lyriclatch.js"),
  resolve(spicetify, "Extensions", "lyriclatch.js")
);

console.log(`Deployed files to ${spicetify}`);
console.log("Enable them with:");
console.log("  spicetify config custom_apps lyriclatch");
console.log("  spicetify config extensions lyriclatch.js");
console.log("  spicetify apply");
