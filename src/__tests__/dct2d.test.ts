import { describe, expect, it } from "vitest";
import { dct1d, dct2d, idct1d, idct2d } from "../dct2d";

/**
 * Direct O(N^2) orthonormal DCT-II, straight from the definition.
 * Slow, obviously correct, and the thing the FFT version has to match.
 */
function referenceDct1d(x: Float64Array): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += x[i] * Math.cos((Math.PI * k * (2 * i + 1)) / (2 * n));
    }
    const f = k === 0 ? Math.sqrt(1 / (4 * n)) : Math.sqrt(1 / (2 * n));
    out[k] = 2 * f * sum;
  }
  return out;
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
}

function randomPlane(n: number, seed: number): Float64Array {
  // Deterministic LCG so failures are reproducible.
  let s = seed >>> 0;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s / 0xffffffff) * 255 - 128;
  }
  return out;
}

describe("dct2d", () => {
  it("dct1d matches the direct definition", () => {
    for (const n of [8, 16, 64, 256]) {
      const x = randomPlane(n, n * 7 + 1);
      const got = new Float64Array(n);
      dct1d(x, got);
      expect(maxAbsDiff(got, referenceDct1d(x))).toBeLessThan(1e-9);
    }
  });

  it("idct1d inverts dct1d", () => {
    for (const n of [8, 64, 512]) {
      const x = randomPlane(n, n + 3);
      const fwd = new Float64Array(n);
      dct1d(x, fwd);
      const back = new Float64Array(n);
      idct1d(fwd, back);
      expect(maxAbsDiff(back, x)).toBeLessThan(1e-9);
    }
  });

  it("dct1d preserves energy (orthonormality)", () => {
    const n = 256;
    const x = randomPlane(n, 99);
    const fwd = new Float64Array(n);
    dct1d(x, fwd);
    const energyIn = x.reduce((a, v) => a + v * v, 0);
    const energyOut = fwd.reduce((a, v) => a + v * v, 0);
    expect(Math.abs(energyIn - energyOut) / energyIn).toBeLessThan(1e-12);
  });

  it("idct2d inverts dct2d on a full canonical plane", () => {
    const n = 128;
    const plane = randomPlane(n * n, 4242);
    const original = Float64Array.from(plane);
    dct2d(plane, n);
    idct2d(plane, n);
    expect(maxAbsDiff(plane, original)).toBeLessThan(1e-9);
  });

  it("dct2d puts a flat plane entirely in DC", () => {
    const n = 64;
    const plane = new Float64Array(n * n).fill(50);
    dct2d(plane, n);
    expect(plane[0]).toBeCloseTo(50 * n, 6);
    let offDc = 0;
    for (let i = 1; i < plane.length; i++) offDc = Math.max(offDc, Math.abs(plane[i]));
    expect(offDc).toBeLessThan(1e-9);
  });

  it("handles a 512 plane fast enough for interactive detection", () => {
    const n = 512;
    const plane = randomPlane(n * n, 7);
    const t0 = performance.now();
    dct2d(plane, n);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);
  });
});
