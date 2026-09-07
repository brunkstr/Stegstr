/**
 * Verify a folder of images that have been through a real platform.
 *
 *   node testkit/verify.mjs returned/
 *
 * Matching is by recovered payload, not by filename, because WhatsApp and
 * Instagram both rename what they hand back. Anything that decodes to a
 * payload the kit issued counts; anything else is reported so a genuine
 * failure is never quietly scored as a pass.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { MODES, detectFromRgba, minimumEdge } from "../src/stego-stdm.ts";
import { decodeImage } from "../cli/image-io.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = join(ROOT, "testkit", "out", "manifest.json");

const folder = process.argv[2];
if (!folder) {
  console.error("usage: node testkit/verify.mjs <folder-of-returned-images>");
  process.exit(2);
}
if (!existsSync(folder)) {
  console.error(`no such folder: ${folder}`);
  process.exit(2);
}

const expected = existsSync(MANIFEST)
  ? JSON.parse(readFileSync(MANIFEST, "utf8"))
  : [];
const expectedTexts = new Set(expected.map((e) => e.expected));

const files = readdirSync(folder).filter((f) =>
  [".jpg", ".jpeg", ".png", ".webp"].includes(extname(f).toLowerCase()),
);

if (files.length === 0) {
  console.error(`no images found in ${folder}`);
  process.exit(2);
}

console.log(`\nChecking ${files.length} image(s) from ${folder}\n`);
console.log(`${"file".padEnd(34)}${"size".padEnd(13)}${"mode".padEnd(10)}result`);
console.log("-".repeat(72));

let recovered = 0;
let known = 0;

for (const file of files) {
  const path = join(folder, file);
  let raster;
  try {
    raster = decodeImage(new Uint8Array(readFileSync(path)));
  } catch (err) {
    console.log(`${basename(file).padEnd(34)}${"-".padEnd(13)}${"-".padEnd(10)}unreadable (${err.message})`);
    continue;
  }

  const size = `${raster.width}x${raster.height}`;
  let found = null;
  let foundMode = null;

  for (const mode of Object.keys(MODES)) {
    if (Math.min(raster.width, raster.height) < minimumEdge(MODES[mode])) continue;
    const bytes = detectFromRgba(raster.data, raster.width, raster.height, MODES[mode]);
    if (bytes) {
      found = new TextDecoder().decode(bytes);
      foundMode = mode;
      break;
    }
  }

  if (!found) {
    console.log(`${basename(file).padEnd(34)}${size.padEnd(13)}${"-".padEnd(10)}NO PAYLOAD`);
    continue;
  }

  recovered++;
  const isKnown = expectedTexts.has(found);
  if (isKnown) known++;
  console.log(
    `${basename(file).padEnd(34)}${size.padEnd(13)}${foundMode.padEnd(10)}` +
      (isKnown ? "RECOVERED" : `recovered, but not a kit payload: "${found.slice(0, 40)}"`),
  );
}

console.log("-".repeat(72));
console.log(`\n${recovered}/${files.length} image(s) still carried a payload.`);
if (expectedTexts.size > 0) {
  console.log(`${known}/${files.length} matched a payload this kit issued.`);
}
process.exit(recovered === files.length ? 0 : 1);
