/**
 * Build a real-device test kit.
 *
 * Simulated channels can only ever be an argument about what real platforms
 * do. This produces a folder of stego images with known payloads plus a
 * verifier, so anyone can settle it directly: send the images through WhatsApp,
 * Telegram or Instagram, save what comes back, and run `verify`.
 *
 *   node testkit/make-kit.mjs            # writes testkit/out/
 *   node testkit/verify.mjs <folder>     # checks whatever came back
 */

import { mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { MODES, embedIntoRgba, minimumEdge, payloadBytes } from "../src/stego-stdm.ts";
import { decodeImage, encodeJpeg, readImage } from "../cli/image-io.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "testkit", "out");
const COVERS = join(ROOT, "robust_lab", "covers");

/**
 * Payload text per image, so a decode is obviously right or obviously wrong.
 *
 * Locator mode holds 48 bytes, which is the whole point of it - it is sized to
 * carry a reference rather than a message - so it gets the short form. Standard
 * gets a longer one so the kit actually exercises the extra capacity.
 */
function payloadFor(name, mode) {
  return mode === "locator"
    ? `stegstr|${name}|locator`
    : `stegstr-testkit|${name}|${mode}|the quick brown fox jumps over the lazy dog`;
}

function syntheticCover(width, height, seed) {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed >>> 0;
  // Layered value noise: photograph-like statistics rather than flat colour,
  // which would make both hiding and surviving unrealistically easy.
  const octaves = [4, 8, 16, 48, 160];
  const fields = octaves.map((cells) => {
    const g = new Float64Array(cells * cells);
    for (let i = 0; i < g.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      g[i] = s / 4294967296;
    }
    return { cells, g };
  });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      let amp = 1;
      let norm = 0;
      for (const { cells, g } of fields) {
        const gx = (x / width) * (cells - 1);
        const gy = (y / height) * (cells - 1);
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = gx - x0;
        const fy = gy - y0;
        const x1 = Math.min(cells - 1, x0 + 1);
        const y1 = Math.min(cells - 1, y0 + 1);
        v +=
          amp *
          (g[y0 * cells + x0] * (1 - fx) * (1 - fy) +
            g[y0 * cells + x1] * fx * (1 - fy) +
            g[y1 * cells + x0] * (1 - fx) * fy +
            g[y1 * cells + x1] * fx * fy);
        norm += amp;
        amp *= 0.55;
      }
      v = (v / norm) * 210 + 25;
      const i = (y * width + x) * 4;
      data[i] = Math.min(255, v * 1.02);
      data[i + 1] = Math.min(255, v * 0.94);
      data[i + 2] = Math.min(255, v * 0.86);
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

function loadCovers() {
  const found = [];
  if (existsSync(COVERS)) {
    for (const file of readdirSync(COVERS)) {
      if (![".png", ".jpg", ".jpeg"].includes(extname(file).toLowerCase())) continue;
      if (!file.includes("1600x1200")) continue;
      found.push({ name: file.split("_")[0], raster: readImage(join(COVERS, file)) });
    }
  }
  if (found.length === 0) {
    found.push(
      { name: "texture", raster: syntheticCover(1600, 1200, 1234) },
      { name: "portrait", raster: syntheticCover(1200, 1600, 99) },
    );
  }
  return found;
}

mkdirSync(OUT, { recursive: true });

const manifest = [];
const covers = loadCovers();

for (const { name, raster } of covers) {
  for (const mode of ["locator", "standard"]) {
    const params = MODES[mode];
    if (Math.min(raster.width, raster.height) < minimumEdge(params)) continue;

    const text = payloadFor(name, mode);
    const payload = new TextEncoder().encode(text);
    if (payload.length > payloadBytes(params)) {
      // Loudly, rather than skipping: a kit that quietly omits the mode it is
      // meant to demonstrate is worse than no kit.
      console.log(`SKIP ${name}-${mode}: payload is ${payload.length} B, mode holds ${payloadBytes(params)} B`);
      continue;
    }

    const embedded = embedIntoRgba(raster.data, raster.width, raster.height, payload, params);
    const jpeg = encodeJpeg(
      { data: embedded, width: raster.width, height: raster.height },
      params.quality,
    );

    const file = `${name}-${mode}.jpg`;
    writeFileSync(join(OUT, file), jpeg);

    // Verify what we just wrote, so the kit cannot ship a dud.
    const check = decodeImage(jpeg);
    const { detectFromRgba } = await import("../src/stego-stdm.ts");
    const back = detectFromRgba(check.data, check.width, check.height, params);
    const ok = back !== null && new TextDecoder().decode(back) === text;

    manifest.push({ file, mode, expected: text, verifiedAtBuild: ok });
    console.log(`${ok ? "ok  " : "BAD "} ${file}  (${raster.width}x${raster.height}, ${mode})`);
  }
}

writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(
  join(OUT, "README.txt"),
  [
    "Stegstr real-device test kit",
    "============================",
    "",
    "Each .jpg here carries a hidden message. manifest.json says what.",
    "",
    "To check whether the payload survives a real platform:",
    "",
    "  1. Send these images to yourself through WhatsApp, Telegram or Instagram",
    "     (normal photo send, NOT 'send as file' - the point is to be recompressed).",
    "  2. Save what arrives into a folder, e.g. returned/",
    "  3. Run:  node testkit/verify.mjs returned/",
    "",
    "The verifier matches each file back to its expected text and prints a",
    "pass/fail table. It matches on payload content, so renamed files are fine.",
    "",
    "Note: 'locator' is the high-robustness mode and is the one to judge on.",
    "'standard' carries more data and gives up some margin for it.",
  ].join("\n"),
);

const bad = manifest.filter((m) => !m.verifiedAtBuild).length;
console.log(`\nWrote ${manifest.length} image(s) to testkit/out/`);
process.exit(bad === 0 ? 0 : 1);
