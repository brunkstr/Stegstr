import { describe, expect, it } from "vitest";
import {
  BULK,
  LOCATOR,
  STANDARD,
  computeDelta,
  detectFromPlane,
  frameBytes,
  payloadBytes,
  resamplePlane,
} from "../stego-stdm";

/** Deterministic 1/f plane - photograph-like statistics, reproducible failures. */
function photoPlane(width: number, height: number, seed: number): Float64Array {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out = new Float64Array(width * height);
  for (let octave = 0; octave < 6; octave++) {
    const cells = 2 << octave;
    const amp = 120 / (octave + 1);
    const grid = new Float64Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    for (let y = 0; y < height; y++) {
      const gy = (y / height) * (cells - 1);
      const y0 = Math.floor(gy);
      const fy = gy - y0;
      for (let x = 0; x < width; x++) {
        const gx = (x / width) * (cells - 1);
        const x0 = Math.floor(gx);
        const fx = gx - x0;
        const x1 = Math.min(cells - 1, x0 + 1);
        const y1 = Math.min(cells - 1, y0 + 1);
        const v =
          grid[y0 * cells + x0] * (1 - fx) * (1 - fy) +
          grid[y0 * cells + x1] * fx * (1 - fy) +
          grid[y1 * cells + x0] * (1 - fx) * fy +
          grid[y1 * cells + x1] * fx * fy;
        out[y * width + x] += v * amp;
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, out[i]));
  return out;
}

function applyDelta(plane: Float64Array, delta: Float64Array): Float64Array {
  const out = new Float64Array(plane.length);
  // Clamp exactly as the RGBA path does, so the test sees real quantisation.
  for (let i = 0; i < plane.length; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(plane[i] + delta[i])));
  }
  return out;
}

const PAYLOAD = new Uint8Array(48);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i;

/**
 * Compare payload bytes as plain arrays.
 *
 * `toEqual` on two Uint8Arrays can fail even when every byte matches: pako
 * allocates in the jsdom realm while TextEncoder allocates in the node one,
 * and the two prototypes are not the same object. Comparing contents is what
 * we actually mean anyway.
 */
function bytes(a: Uint8Array | null): number[] | null {
  return a === null ? null : Array.from(a);
}

/** Incompressible bytes, for tests that must not be rescued by deflate. */
function randomBytes(count: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

describe("stego-stdm", () => {
  it("reports the capacity each mode is sized for", () => {
    expect(payloadBytes(LOCATOR)).toBeGreaterThanOrEqual(48);
    expect(payloadBytes(STANDARD)).toBeGreaterThan(payloadBytes(LOCATOR));
    expect(payloadBytes(BULK)).toBeGreaterThan(payloadBytes(STANDARD));
    expect(frameBytes(LOCATOR)).toBeGreaterThan(LOCATOR.rsNsym);
  });

  it("round-trips a payload untouched", () => {
    const w = 800;
    const h = 600;
    const plane = photoPlane(w, h, 11);
    const stego = applyDelta(plane, computeDelta(plane, w, h, PAYLOAD, LOCATOR));
    expect(bytes(detectFromPlane(stego, w, h, LOCATOR))).toEqual(bytes(PAYLOAD));
  });

  it("rejects a cover with nothing embedded", () => {
    const w = 512;
    const h = 512;
    expect(detectFromPlane(photoPlane(w, h, 5), w, h, LOCATOR)).toBeNull();
  });

  it("survives arbitrary rescaling - the case that breaks block-DCT QIM", () => {
    const w = 1600;
    const h = 1200;
    const plane = photoPlane(w, h, 3);
    const stego = applyDelta(plane, computeDelta(plane, w, h, PAYLOAD, LOCATOR));

    for (const scale of [0.37, 0.63, 0.675, 0.8, 1.25]) {
      const sw = Math.round(w * scale);
      const sh = Math.round(h * scale);
      const scaled = resamplePlane(stego, w, h, sw, sh);
      expect(bytes(detectFromPlane(scaled, sw, sh, LOCATOR)), `scale ${scale}`).toEqual(bytes(PAYLOAD));
    }
  });

  it("survives a resize to a non-multiple-of-8 size", () => {
    const w = 1608;
    const h = 1208;
    const plane = photoPlane(w, h, 17);
    const stego = applyDelta(plane, computeDelta(plane, w, h, PAYLOAD, LOCATOR));
    const scaled = resamplePlane(stego, w, h, 1600, 1202);
    expect(bytes(detectFromPlane(scaled, 1600, 1202, LOCATOR))).toEqual(bytes(PAYLOAD));
  });

  it("carries a larger payload in standard mode", () => {
    const w = 1200;
    const h = 900;
    const plane = photoPlane(w, h, 23);
    const note = new TextEncoder().encode(
      JSON.stringify({ v: 1, t: "the quick brown fox jumps over the lazy dog", n: 42 }),
    );
    const stego = applyDelta(plane, computeDelta(plane, w, h, note, STANDARD));
    expect(bytes(detectFromPlane(stego, w, h, STANDARD))).toEqual(bytes(note));
  });

  it("keeps the change imperceptible", () => {
    const w = 1024;
    const h = 768;
    const plane = photoPlane(w, h, 31);
    const stego = applyDelta(plane, computeDelta(plane, w, h, PAYLOAD, LOCATOR));

    let mse = 0;
    for (let i = 0; i < plane.length; i++) mse += (plane[i] - stego[i]) ** 2;
    mse /= plane.length;
    const psnr = 10 * Math.log10((255 * 255) / mse);
    expect(psnr).toBeGreaterThan(38);
  });

  it("refuses a payload that does not fit rather than truncating it", () => {
    const w = 512;
    const h = 512;
    const plane = photoPlane(w, h, 41);
    const tooBig = randomBytes(payloadBytes(LOCATOR) + 64, 77);
    expect(() => computeDelta(plane, w, h, tooBig, LOCATOR)).toThrow(/too large/);
  });
});

