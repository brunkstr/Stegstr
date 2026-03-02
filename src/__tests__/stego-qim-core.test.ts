import { describe, it, expect } from "vitest";
import {
  forwardDCT8x8,
  inverseDCT8x8,
  quantizationTable,
  quantize,
  dequantize,
  AC_INDICES,
} from "../dct";
import { RSCodec } from "../reed-solomon";
import { getQimCapacityBytes, PLATFORM_WIDTHS, DEFAULT_PLATFORM } from "../stego-qim";

// ---------------------------------------------------------------------------
// DCT round-trip tests
// ---------------------------------------------------------------------------

describe("DCT forward/inverse round-trip", () => {
  it("recovers a flat block", () => {
    const block = new Float64Array(64).fill(0);
    const dct = forwardDCT8x8(block);
    const recovered = inverseDCT8x8(dct);
    for (let i = 0; i < 64; i++) {
      expect(recovered[i]).toBeCloseTo(0, 8);
    }
  });

  it("recovers a constant block (DC only)", () => {
    const block = new Float64Array(64).fill(100);
    const dct = forwardDCT8x8(block);
    const recovered = inverseDCT8x8(dct);
    for (let i = 0; i < 64; i++) {
      expect(recovered[i]).toBeCloseTo(100, 6);
    }
  });

  it("recovers a gradient block", () => {
    const block = new Float64Array(64);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        block[r * 8 + c] = r * 8 + c; // 0 to 63
      }
    }
    const dct = forwardDCT8x8(block);
    const recovered = inverseDCT8x8(dct);
    for (let i = 0; i < 64; i++) {
      expect(recovered[i]).toBeCloseTo(block[i], 6);
    }
  });

  it("recovers a random block", () => {
    const block = new Float64Array(64);
    // Deterministic pseudo-random values in pixel range [-128, 127]
    for (let i = 0; i < 64; i++) {
      block[i] = ((i * 37 + 13) % 256) - 128;
    }
    const dct = forwardDCT8x8(block);
    const recovered = inverseDCT8x8(dct);
    for (let i = 0; i < 64; i++) {
      expect(recovered[i]).toBeCloseTo(block[i], 6);
    }
  });
});

// ---------------------------------------------------------------------------
// Quantization table tests
// ---------------------------------------------------------------------------

describe("quantizationTable", () => {
  it("produces valid tables for standard quality levels", () => {
    for (const q of [1, 25, 50, 75, 100]) {
      const qt = quantizationTable(q);
      expect(qt.length).toBe(64);
      for (let i = 0; i < 64; i++) {
        expect(qt[i]).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("quality 50 matches standard JPEG luminance table", () => {
    const qt = quantizationTable(50);
    // First row of standard table
    expect(qt[0]).toBe(16);
    expect(qt[1]).toBe(11);
    expect(qt[2]).toBe(10);
    expect(qt[3]).toBe(16);
  });

  it("lower quality produces larger quantization values", () => {
    const qt25 = quantizationTable(25);
    const qt75 = quantizationTable(75);
    // Lower quality = coarser quantization = larger table values
    let q25Sum = 0, q75Sum = 0;
    for (let i = 0; i < 64; i++) {
      q25Sum += qt25[i];
      q75Sum += qt75[i];
    }
    expect(q25Sum).toBeGreaterThan(q75Sum);
  });
});

// ---------------------------------------------------------------------------
// Quantize / dequantize round-trip
// ---------------------------------------------------------------------------

describe("quantize/dequantize", () => {
  it("quantize then dequantize approximates original", () => {
    const coeffs = new Float64Array(64);
    for (let i = 0; i < 64; i++) {
      coeffs[i] = ((i * 23 + 7) % 200) - 100;
    }
    const qt = quantizationTable(75);
    const qCoeffs = quantize(coeffs, qt);
    const restored = dequantize(qCoeffs, qt);
    // Each value should be within qt[i]/2 of the original (quantization error)
    for (let i = 0; i < 64; i++) {
      expect(Math.abs(restored[i] - coeffs[i])).toBeLessThanOrEqual(qt[i] / 2 + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Reed-Solomon round-trip tests
// ---------------------------------------------------------------------------

describe("Reed-Solomon codec", () => {
  it("encodes and decodes a short message", () => {
    const rs = new RSCodec(128);
    const message = new Uint8Array([0x53, 0x54, 0x45, 0x47, 0x53, 0x54, 0x52]); // "STEGSTR"
    const encoded = rs.encode(message);
    expect(encoded.length).toBe(message.length + 128);
    const decoded = rs.decode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(message));
  });

  it("encodes and decodes various message lengths", () => {
    for (const nsym of [10, 64, 128]) {
      const rs = new RSCodec(nsym);
      for (const len of [1, 5, 20, 50]) {
        const message = new Uint8Array(len);
        for (let i = 0; i < len; i++) message[i] = (i * 37 + 13) & 0xff;
        const encoded = rs.encode(message);
        expect(encoded.length).toBe(len + nsym);
        const decoded = rs.decode(encoded);
        expect(Array.from(decoded)).toEqual(Array.from(message));
      }
    }
  });

  it("clean codeword decodes correctly with high parity", () => {
    const rs = new RSCodec(128);
    const message = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const encoded = rs.encode(message);
    // No corruption - just verify round-trip with nsym=128 (what QIM uses)
    const decoded = rs.decode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(message));
  });

  it("fails gracefully on too many errors", () => {
    const rs = new RSCodec(10); // only 10 parity symbols
    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = rs.encode(message);
    const corrupted = new Uint8Array(encoded);
    // Corrupt more than nsym/2 = 5 positions
    for (let i = 0; i < 8; i++) {
      corrupted[i] ^= 0xff;
    }
    expect(() => rs.decode(corrupted)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// QIM capacity tests
// ---------------------------------------------------------------------------

describe("getQimCapacityBytes", () => {
  it("returns positive capacity for 1080x720", () => {
    const cap = getQimCapacityBytes(1080, 720);
    expect(cap).toBeGreaterThan(0);
  });

  it("returns 0 for tiny images", () => {
    const cap = getQimCapacityBytes(8, 8);
    // 1 block × 24 AC / 5 repeat / 8 bits = 0 bytes after overhead
    expect(cap).toBe(0);
  });

  it("larger images have more capacity", () => {
    const small = getQimCapacityBytes(256, 256);
    const large = getQimCapacityBytes(1080, 720);
    expect(large).toBeGreaterThan(small);
  });

  it("capacity scales with image area", () => {
    const c1 = getQimCapacityBytes(1080, 720);
    const c2 = getQimCapacityBytes(2160, 1440); // 4x area
    // Should be roughly 4x capacity (minus fixed overhead)
    expect(c2).toBeGreaterThan(c1 * 3);
  });

  it("typical 1080px image has enough capacity for small payloads", () => {
    const cap = getQimCapacityBytes(1080, 720);
    // Should hold at least 5KB for typical Nostr bundles
    expect(cap).toBeGreaterThan(5000);
  });
});

// ---------------------------------------------------------------------------
// Platform widths constants
// ---------------------------------------------------------------------------

describe("PLATFORM_WIDTHS", () => {
  it("has all expected platforms", () => {
    expect(PLATFORM_WIDTHS).toHaveProperty("instagram");
    expect(PLATFORM_WIDTHS).toHaveProperty("facebook");
    expect(PLATFORM_WIDTHS).toHaveProperty("twitter");
    expect(PLATFORM_WIDTHS).toHaveProperty("whatsapp_standard");
    expect(PLATFORM_WIDTHS).toHaveProperty("whatsapp_hd");
    expect(PLATFORM_WIDTHS).toHaveProperty("telegram_photo");
    expect(PLATFORM_WIDTHS).toHaveProperty("imessage");
    expect(PLATFORM_WIDTHS).toHaveProperty("none");
  });

  it("instagram is smallest at 1080", () => {
    const widths = Object.entries(PLATFORM_WIDTHS)
      .filter(([k]) => k !== "none")
      .map(([, v]) => v);
    expect(Math.min(...widths)).toBe(1080);
    expect(PLATFORM_WIDTHS.instagram).toBe(1080);
  });

  it("default platform is instagram", () => {
    expect(DEFAULT_PLATFORM).toBe("instagram");
  });

  it("none has width 0 (no resize)", () => {
    expect(PLATFORM_WIDTHS.none).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC_INDICES constant
// ---------------------------------------------------------------------------

describe("AC_INDICES", () => {
  it("has 24 positions (zigzag positions 1-24)", () => {
    expect(AC_INDICES.length).toBe(24);
    expect(AC_INDICES[0]).toBe(1); // skip DC at position 0
    expect(AC_INDICES[23]).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// QIM embed/detect primitive math tests
// ---------------------------------------------------------------------------

describe("QIM primitives (math verification)", () => {
  // We can't import private functions, but we can verify the math independently
  const DELTA = 14;

  function qimEmbed(x: number, bit: number, delta: number): number {
    const cell = Math.round(x / delta) * delta;
    const offset = Math.pow(-1, bit + 1) * (delta / 4.0);
    return Math.round(cell + offset);
  }

  function qimDetect(z: number, delta: number): number {
    const cell = Math.round(z / delta) * delta;
    const r0 = cell - delta / 4.0;
    const r1 = cell + delta / 4.0;
    const d0 = Math.abs(z - r0);
    const d1 = Math.abs(z - r1);
    return d0 <= d1 ? 0 : 1;
  }

  it("embed then detect recovers bit 0", () => {
    for (const x of [-50, -14, -7, 0, 7, 14, 28, 50, 100]) {
      const embedded = qimEmbed(x, 0, DELTA);
      const detected = qimDetect(embedded, DELTA);
      expect(detected).toBe(0);
    }
  });

  it("embed then detect recovers bit 1", () => {
    for (const x of [-50, -14, -7, 0, 7, 14, 28, 50, 100]) {
      const embedded = qimEmbed(x, 1, DELTA);
      const detected = qimDetect(embedded, DELTA);
      expect(detected).toBe(1);
    }
  });

  it("survives small perturbation (simulating JPEG noise)", () => {
    let correct = 0;
    let total = 0;
    for (const x of [-50, -28, -14, 0, 14, 28, 50]) {
      for (const bit of [0, 1]) {
        const embedded = qimEmbed(x, bit, DELTA);
        // Add noise up to delta/4 - 1 (should survive)
        for (const noise of [-2, -1, 0, 1, 2]) {
          const noisy = embedded + noise;
          const detected = qimDetect(noisy, DELTA);
          if (detected === bit) correct++;
          total++;
        }
      }
    }
    // Should be 100% correct with noise < delta/4 = 3.5
    expect(correct).toBe(total);
  });

  it("reconstruction levels are separated by delta/2", () => {
    // For any coefficient, the two QIM levels (for bit 0 and bit 1) should be delta/2 apart
    for (const x of [0, 14, 28, -14]) {
      const level0 = qimEmbed(x, 0, DELTA);
      const level1 = qimEmbed(x, 1, DELTA);
      expect(Math.abs(level1 - level0)).toBe(Math.round(DELTA / 2));
    }
  });
});
