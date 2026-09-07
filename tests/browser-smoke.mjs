/**
 * Browser smoke test: load the built app, then drive a real embed/detect
 * round trip through the page's own code.
 *
 * The vitest suite covers the encoder in isolation and the CLI covers it under
 * Node. Neither exercises the path the app actually uses - canvas decode,
 * canvas JPEG encode, the browser's own image pipeline - which is where a
 * working algorithm can still fail to ship. This does.
 *
 *   npm run build && node tests/browser-smoke.mjs
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

function serve(dir) {
  const server = createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    let path = normalize(join(dir, url === "/" ? "index.html" : url));
    if (!path.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(path)) path = join(dir, "index.html"); // SPA fallback
    try {
      const body = await readFile(path);
      res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

if (!existsSync(DIST)) {
  console.error("dist/ not found - run `npm run build` first");
  process.exit(2);
}

const { server, port } = await serve(DIST);
const browser = await chromium.launch();
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on("console", (msg) => {
  if (msg.type() !== "error") return;
  const text = msg.text();
  // The upstream relay-config endpoint on stegstr.com serves no CORS header, so
  // the browser blocks the request and logs it no matter how we handle the
  // rejection. That is a finding about that host, not a fault in this app: the
  // fetch is bounded and falls back to the built-in relay list. Anything else
  // is ours and should fail the run.
  if (text.includes("stegstr.com/config/")) return;
  if (text.includes("net::ERR_FAILED") && msg.location()?.url?.includes("stegstr.com")) return;
  consoleErrors.push(text);
});
page.on("pageerror", (err) => pageErrors.push(err.message));

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle", timeout: 30_000 });

  check("app renders without an uncaught exception", pageErrors.length === 0, pageErrors[0] ?? "");
  check("app root has content", (await page.locator("#root").innerHTML()).length > 200);

  // Round trip through the browser's real canvas pipeline.
  await page.waitForFunction(() => typeof window.__stegstr !== "undefined", null, { timeout: 15_000 });
  check("scriptable agent API is exposed on window", true);

  const result = await page.evaluate(async () => {
    // Build a photographic-ish cover in the page itself.
    const width = 1600;
    const height = 1200;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(width, height);
    let seed = 12345 >>> 0;
    for (let i = 0; i < width * height; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const v = 40 + ((seed >>> 24) % 180);
      image.data[i * 4] = v;
      image.data[i * 4 + 1] = (v * 0.9) | 0;
      image.data[i * 4 + 2] = (v * 0.8) | 0;
      image.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    const cover = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.95));

    const stego = await window.__stegstr.encode(cover, "hello from the browser", "standard");
    const direct = await window.__stegstr.decode(stego);

    // Now rescale it the way a platform would, and read it again.
    const bitmap = await createImageBitmap(stego);
    const rw = 1080;
    const rh = Math.round((bitmap.height * rw) / bitmap.width);
    const rc = document.createElement("canvas");
    rc.width = rw;
    rc.height = rh;
    rc.getContext("2d").drawImage(bitmap, 0, 0, rw, rh);
    const resized = await new Promise((r) => rc.toBlob(r, "image/jpeg", 0.7));
    const afterResize = await window.__stegstr.decode(resized);

    return { direct, afterResize, stegoBytes: stego.size };
  });

  check("embed + detect round trip in the browser", result.direct === "hello from the browser", result.direct ?? "");
  check(
    "payload survives a 1600 -> 1080 rescale and requantisation",
    result.afterResize === "hello from the browser",
    result.afterResize ?? "no payload found",
  );
  check("no console errors during the round trip", consoleErrors.length === 0, consoleErrors[0] ?? "");
} catch (err) {
  check("smoke test ran to completion", false, err.message);
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length === 0 ? "\nAll browser checks passed." : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
