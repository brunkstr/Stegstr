/**
 * Image-dimension edge cases, also from section 5A: huge image, tiny image.
 *
 * Below a mode's minimum edge the encoder must refuse and say what size it
 * needs, rather than writing a file that quietly carries nothing.
 *
 *   npm run build:cli && node tests/image-sizes.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";

const dir = mkdtempSync(join(tmpdir(), "sizes-"));
function makePng(w, h) {
  const png = new PNG({ width: w, height: h });
  let s = 7 >>> 0;
  for (let i = 0; i < w * h; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const v = 40 + ((s >>> 24) % 180);
    png.data[i * 4] = v; png.data[i * 4 + 1] = (v * 0.9) | 0;
    png.data[i * 4 + 2] = (v * 0.8) | 0; png.data[i * 4 + 3] = 255;
  }
  const p = join(dir, `${w}x${h}.png`);
  writeFileSync(p, PNG.sync.write(png));
  return p;
}
function run(args) {
  try { return { code: 0, out: execFileSync("node", ["dist-cli/stegstr.mjs", ...args], { encoding: "utf8", stdio: ["ignore","pipe","pipe"] }) }; }
  catch (e) { return { code: e.status ?? -1, out: (e.stdout||"") + (e.stderr||"") }; }
}

const cases = [[1,1],[16,16],[319,319],[320,320],[640,480],[4000,3000],[6000,400],[400,6000]];
console.log("size          embed  detect  note");
console.log("-".repeat(92));
let bad = 0;
for (const [w,h] of cases) {
  const t0 = Date.now();
  const cover = makePng(w,h);
  const out = join(dir, `s_${w}x${h}.png`);
  const e = run(["embed", cover, "-o", out, "--payload", "edge case check", "--mode", "locator"]);
  let d = { code: -9, out: "" }, note = "";
  if (e.code === 0) {
    d = run(["detect", out, "--mode", "locator"]);
    note = d.out.trim() === "edge case check" ? `recovered in ${((Date.now()-t0)/1000).toFixed(1)}s` : "WRONG PAYLOAD";
    if (note === "WRONG PAYLOAD") bad++;
  } else {
    const crash = /at Object\.|at Module\.|RangeError|TypeError|Cannot read/.test(e.out);
    note = crash ? "CRASH: " + e.out.replace(/\s+/g," ").slice(0,60) : "clean refusal: " + e.out.replace(/^error:\s*/,"").replace(/\s+/g," ").slice(0,52);
    if (crash) bad++;
  }
  console.log(`${(w+"x"+h).padEnd(13)} ${String(e.code).padEnd(6)} ${String(d.code === -9 ? "-" : d.code).padEnd(7)} ${note}`);
}
console.log("-".repeat(92));
console.log(bad === 0 ? "\nNo crashes and no silent corruption." : `\n${bad} problem(s).`);
