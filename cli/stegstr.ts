/**
 * Headless Stegstr CLI.
 *
 * Runs the same steganography code as the app, with no Rust toolchain and no
 * build step. Every command speaks JSON on `--json`, and exit codes are
 * meaningful, so an agent can drive it without scraping prose.
 *
 * Exit codes: 0 success, 1 no payload found, 2 usage or input error.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  MODES,
  type ModeName,
  type StdmParams,
  detectFromRgba,
  embedCalibrated,
  embedIntoRgba,
  minimumEdge,
  resamplePlane,
  payloadBytes,
} from "../src/stego-stdm";
import { decodeImage, encodeJpeg, readImage, writeImage, type Raster } from "./image-io";

const USAGE = `stegstr - resize-robust steganography

Usage:
  stegstr embed <cover> -o <out> (--payload <text> | --payload-file <path> | --payload-base64 <b64>)
                                 [--mode locator|standard|bulk] [--quality N] [--json]
  stegstr detect <image> [--mode locator|standard|bulk|auto] [--out <path>] [--json]
  stegstr capacity <cover> [--mode ...] [--json]
  stegstr modes [--json]
  stegstr selftest [--json]

Modes:
  locator   48 B  - survives WhatsApp/Instagram; carries a reference, not a message
  standard  163 B - a short note travelling entirely inside the image
  bulk      1.3 kB - lossless channels only (Telegram "send as file", email, disk)

Output images should be .jpg unless you control the whole path end to end;
PNG is written losslessly but platforms will convert it to JPEG anyway.`;

interface Args {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else if (token === "-o") {
      args.out = argv[++i];
    } else {
      (args._ as string[]).push(token);
    }
  }
  return args;
}

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

class UsageError extends Error {}

function resolveMode(name: string | undefined): { mode: ModeName; params: StdmParams } {
  const key = (name ?? "locator") as ModeName;
  const params = MODES[key];
  if (!params) throw new UsageError(`unknown mode "${name}" (expected locator, standard or bulk)`);
  return { mode: key, params };
}

function readPayload(args: Args): Uint8Array {
  const text = str(args, "payload");
  if (text !== undefined) {
    // "@path" is accepted for parity with the original Rust CLI.
    if (text.startsWith("@")) return new Uint8Array(readFileSync(text.slice(1)));
    return new TextEncoder().encode(text);
  }
  const file = str(args, "payload-file");
  if (file !== undefined) return new Uint8Array(readFileSync(file));
  const b64 = str(args, "payload-base64");
  if (b64 !== undefined) return new Uint8Array(Buffer.from(b64, "base64"));
  throw new UsageError("no payload given: use --payload, --payload-file or --payload-base64");
}

/** Payloads are arbitrary bytes; report text when it is text, base64 otherwise. */
function describePayload(payload: Uint8Array): { encoding: "utf8" | "base64"; payload: string } {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    // Valid UTF-8 is not enough: binary data often decodes cleanly but is full
    // of control characters, which would corrupt a terminal or confuse a JSON
    // consumer. Tab, newline and carriage return are legitimate.
    const hasControls = Array.from(decoded).some((ch) => {
      const code = ch.codePointAt(0)!;
      return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    });
    if (!hasControls) return { encoding: "utf8", payload: decoded };
  } catch {
    // not valid UTF-8
  }
  return { encoding: "base64", payload: Buffer.from(payload).toString("base64") };
}

function emit(json: boolean, data: Record<string, unknown>, human: string): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else console.log(human);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdEmbed(args: Args): number {
  const cover = (args._ as string[])[1];
  const out = str(args, "out");
  if (!cover) throw new UsageError("missing cover image");
  if (!out) throw new UsageError("missing -o <output>");

  const { mode, params: baseParams } = resolveMode(str(args, "mode"));
  // --delta overrides the mode's dither step. Used for calibration sweeps; the
  // detector needs the same value, so pass it to `detect` as well.
  const deltaOverride = str(args, "delta");
  const params = deltaOverride ? { ...baseParams, delta: Number(deltaOverride) } : baseParams;
  if (deltaOverride && !Number.isFinite(params.delta)) throw new UsageError("--delta must be a number");
  const quality = Number(str(args, "quality") ?? params.quality);
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) {
    throw new UsageError("--quality must be between 1 and 100");
  }

  const payload = readPayload(args);
  const room = payloadBytes(params);
  if (payload.length > room) {
    throw new UsageError(
      `payload is ${payload.length} bytes but mode "${mode}" holds ${room}; ` +
        `use --mode standard or --mode bulk, or shorten the payload`,
    );
  }

  const raster = readImage(cover);

  // Calibrate against a stress re-encode: some covers, notably documents and
  // screenshots, need more strength than a photograph to survive at all.
  const calibrated = embedCalibrated(
    raster.data, raster.width, raster.height, payload, params,
    (pixels, w, h) => {
      // The harshest profile in the wild: downscale to a 1080px long edge and
      // recompress hard. Calibrating against quality alone left resize broken.
      const scale = Math.min(1, 1080 / Math.max(w, h));
      const rw = Math.max(1, Math.round(w * scale));
      const rh = Math.max(1, Math.round(h * scale));
      const small = new Uint8ClampedArray(rw * rh * 4);
      for (let ch = 0; ch < 3; ch++) {
        const plane = new Float64Array(w * h);
        for (let i = 0; i < w * h; i++) plane[i] = pixels[i * 4 + ch];
        const resized = resamplePlane(plane, w, h, rw, rh);
        for (let i = 0; i < rw * rh; i++) small[i * 4 + ch] = resized[i];
      }
      for (let i = 0; i < rw * rh; i++) small[i * 4 + 3] = 255;
      const round = decodeImage(encodeJpeg({ data: small, width: rw, height: rh }, 55));
      return { data: round.data, width: round.width, height: round.height };
    },
  );
  const embedded: Raster = {
    data: calibrated.pixels,
    width: raster.width,
    height: raster.height,
  };
  writeImage(out, embedded, quality);

  // Verify before claiming success: a silent failure here is the worst
  // outcome, because the user forwards an image that carries nothing.
  const written = decodeImage(new Uint8Array(readFileSync(out)));
  const check = detectFromRgba(written.data, written.width, written.height, params);
  const verified = check !== null && Buffer.compare(Buffer.from(check), Buffer.from(payload)) === 0;

  emit(
    Boolean(args.json),
    {
      ok: verified,
      output: out,
      mode,
      payloadBytes: payload.length,
      capacityBytes: room,
      width: raster.width,
      height: raster.height,
      verified,
      strength: Number(calibrated.delta.toFixed(1)),
      survivesStressReencode: calibrated.verified,
    },
    verified
      ? `Embedded ${payload.length} B in ${mode} mode -> ${out} (verified` +
        `${calibrated.verified ? "" : ", but it may not survive heavy recompression"}` +
        `${calibrated.delta > params.delta ? `, strength raised to ${calibrated.delta.toFixed(0)} for this cover` : ""})`
      : `Wrote ${out} but verification failed - do not rely on this image`,
  );
  return verified ? 0 : 1;
}

function cmdDetect(args: Args): number {
  const image = (args._ as string[])[1];
  if (!image) throw new UsageError("missing image");

  const requested = str(args, "mode") ?? "auto";
  const raster = readImage(image);

  const candidates: ModeName[] =
    requested === "auto" ? (Object.keys(MODES) as ModeName[]) : [resolveMode(requested).mode];
  const deltaOverride = str(args, "delta");

  for (const mode of candidates) {
    const params = deltaOverride
      ? { ...MODES[mode], delta: Number(deltaOverride) }
      : MODES[mode];
    const payload = detectFromRgba(raster.data, raster.width, raster.height, params);
    if (!payload) continue;

    const outPath = str(args, "out");
    if (outPath) writeFileSync(outPath, payload);

    const described = describePayload(payload);
    emit(
      Boolean(args.json),
      { ok: true, mode, bytes: payload.length, ...described },
      described.encoding === "utf8" ? described.payload : `base64:${described.payload}`,
    );
    return 0;
  }

  emit(
    Boolean(args.json),
    { ok: false, error: "no payload found", triedModes: candidates },
    "No Stegstr payload found.",
  );
  return 1;
}

function cmdCapacity(args: Args): number {
  const cover = (args._ as string[])[1];
  if (!cover) throw new UsageError("missing cover image");
  const { mode, params } = resolveMode(str(args, "mode"));
  const raster = readImage(cover);
  const room = payloadBytes(params);
  emit(
    Boolean(args.json),
    { ok: true, mode, capacityBytes: room, width: raster.width, height: raster.height },
    `${mode}: ${room} bytes (image ${raster.width}x${raster.height})`,
  );
  return 0;
}

function cmdModes(args: Args): number {
  const rows = (Object.keys(MODES) as ModeName[]).map((mode) => ({
    mode,
    capacityBytes: payloadBytes(MODES[mode]),
    canonical: MODES[mode].canonical,
    chips: MODES[mode].chips,
  }));
  emit(
    Boolean(args.json),
    { ok: true, modes: rows },
    rows.map((r) => `${r.mode.padEnd(9)} ${String(r.capacityBytes).padStart(5)} B`).join("\n"),
  );
  return 0;
}

/** Embed and recover through an in-memory JPEG round trip, per mode. */
function cmdSelftest(args: Args): number {
  function noiseImage(width: number, height: number): Uint8ClampedArray {
    const data = new Uint8ClampedArray(width * height * 4);
    let seed = 12345 >>> 0;
    for (let i = 0; i < width * height; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const v = 60 + ((seed >>> 24) % 140);
      data[i * 4] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    return data;
  }

  const results = (Object.keys(MODES) as ModeName[]).map((mode) => {
    const params = MODES[mode];
    // Each mode needs a different minimum resolution; test it at one that
    // actually suits it rather than declaring a mode broken for being asked
    // to work on an image too small for its carrier band.
    // Both edges have to clear the mode's minimum, so keep the test frame
    // square rather than letting the short edge fall under it.
    const edge = Math.max(640, minimumEdge(params));
    const width = Math.round(edge * 1.25);
    const height = edge;
    const data = noiseImage(width, height);

    const payload = new Uint8Array(Math.min(48, payloadBytes(params)));
    for (let i = 0; i < payload.length; i++) payload[i] = i;
    try {
      const embedded = embedIntoRgba(data, width, height, payload, params);
      const recovered = detectFromRgba(embedded, width, height, params);
      const ok =
        recovered !== null &&
        Buffer.compare(Buffer.from(recovered), Buffer.from(payload)) === 0;
      return { mode, ok, width, height };
    } catch (error) {
      return { mode, ok: false, error: (error as Error).message };
    }
  });

  const allOk = results.every((r) => r.ok);
  emit(
    Boolean(args.json),
    { ok: allOk, results },
    results.map((r) => `${r.mode.padEnd(9)} ${r.ok ? "PASS" : "FAIL"}`).join("\n"),
  );
  return allOk ? 0 : 1;
}

// ---------------------------------------------------------------------------

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const command = (args._ as string[])[0];

  if (!command || args.help) {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  switch (command) {
    case "embed":
      return cmdEmbed(args);
    case "detect":
      return cmdDetect(args);
    case "capacity":
      return cmdCapacity(args);
    case "modes":
      return cmdModes(args);
    case "selftest":
      return cmdSelftest(args);
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

try {
  process.exit(main());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const wantsJson = process.argv.includes("--json");
  if (wantsJson) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`error: ${message}`);
  process.exit(2);
}
