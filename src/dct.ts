/**
 * 8x8 DCT/IDCT operations for browser-side JPEG-domain steganography.
 * Standard Type-II / Type-III DCT using the cosine basis, matching
 * the JPEG specification (ITU-T T.81).
 */

// ---------------------------------------------------------------------------
// JPEG zigzag order: position k -> (row, col) in 8x8 block
// ---------------------------------------------------------------------------
export const ZIGZAG_2D: ReadonlyArray<[number, number]> = [
  [0, 0], [0, 1], [1, 0], [2, 0], [1, 1], [0, 2], [0, 3], [1, 2],
  [2, 1], [3, 0], [4, 0], [3, 1], [2, 2], [1, 3], [0, 4], [0, 5],
  [1, 4], [2, 3], [3, 2], [4, 1], [5, 0], [6, 0], [5, 1], [4, 2],
  [3, 3], [2, 4], [1, 5], [0, 6], [0, 7], [1, 6], [2, 5], [3, 4],
  [4, 3], [5, 2], [6, 1], [7, 0], [7, 1], [6, 2], [5, 3], [4, 4],
  [3, 5], [2, 6], [1, 7], [2, 7], [3, 6], [4, 5], [5, 4], [6, 3],
  [7, 2], [7, 3], [6, 4], [5, 5], [4, 6], [3, 7], [4, 7], [5, 6],
  [6, 5], [7, 4], [7, 5], [6, 6], [5, 7], [6, 7], [7, 6], [7, 7],
];

/** AC coefficient zigzag positions 1-24 (matching Python AC_INDICES). */
export const AC_INDICES: ReadonlyArray<number> = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 22, 23, 24,
];

// ---------------------------------------------------------------------------
// Standard JPEG luminance quantization table (quality 50 baseline)
// ---------------------------------------------------------------------------
const Q50_LUMINANCE: ReadonlyArray<number> = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 14, 13, 17, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

/**
 * Compute a JPEG quantization table scaled by the given quality factor.
 * quality in [1..100]. 50 yields the standard table. Lower = more compression.
 */
export function quantizationTable(quality: number): Float64Array {
  const q = Math.max(1, Math.min(100, quality));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  const table = new Float64Array(64);
  for (let i = 0; i < 64; i++) {
    table[i] = Math.max(1, Math.floor((Q50_LUMINANCE[i] * scale + 50) / 100));
  }
  return table;
}

// ---------------------------------------------------------------------------
// Pre-computed cosine table for 8x8 DCT
// ---------------------------------------------------------------------------
const COS_TABLE = new Float64Array(8 * 8);
for (let k = 0; k < 8; k++) {
  for (let n = 0; n < 8; n++) {
    COS_TABLE[k * 8 + n] = Math.cos(((2 * n + 1) * k * Math.PI) / 16);
  }
}

function alpha(u: number): number {
  return u === 0 ? 1 / Math.SQRT2 : 1;
}

// ---------------------------------------------------------------------------
// Forward 8x8 DCT (Type-II)
// ---------------------------------------------------------------------------

/**
 * Compute the 8x8 forward DCT of a pixel block.
 * Input: 64 values in row-major order (can be float or integer).
 * Output: 64 DCT coefficients in row-major order.
 */
export function forwardDCT8x8(block: Float64Array): Float64Array {
  const out = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) {
        for (let y = 0; y < 8; y++) {
          sum += block[x * 8 + y] * COS_TABLE[u * 8 + x] * COS_TABLE[v * 8 + y];
        }
      }
      out[u * 8 + v] = 0.25 * alpha(u) * alpha(v) * sum;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inverse 8x8 DCT (Type-III)
// ---------------------------------------------------------------------------

/**
 * Compute the 8x8 inverse DCT of a coefficient block.
 * Input: 64 DCT coefficients in row-major order.
 * Output: 64 spatial-domain values in row-major order.
 */
export function inverseDCT8x8(coeffs: Float64Array): Float64Array {
  const out = new Float64Array(64);
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) {
        for (let v = 0; v < 8; v++) {
          sum +=
            alpha(u) *
            alpha(v) *
            coeffs[u * 8 + v] *
            COS_TABLE[u * 8 + x] *
            COS_TABLE[v * 8 + y];
        }
      }
      out[x * 8 + y] = 0.25 * sum;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quantize / dequantize helpers
// ---------------------------------------------------------------------------

/**
 * Quantize DCT coefficients: divide each coefficient by the corresponding
 * quantization table entry and round to nearest integer.
 */
export function quantize(coeffs: Float64Array, qt: Float64Array): Float64Array {
  const out = new Float64Array(64);
  for (let i = 0; i < 64; i++) {
    out[i] = Math.round(coeffs[i] / qt[i]);
  }
  return out;
}

/**
 * Dequantize: multiply quantized coefficients by the quantization table.
 */
export function dequantize(qcoeffs: Float64Array, qt: Float64Array): Float64Array {
  const out = new Float64Array(64);
  for (let i = 0; i < 64; i++) {
    out[i] = qcoeffs[i] * qt[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block extraction / reconstruction from pixel arrays
// ---------------------------------------------------------------------------

/**
 * Extract an 8x8 block of a single channel from a row-major pixel array.
 * channelOffset: 0=R, 1=G, 2=B for RGBA data.
 * Returns 64 float values in row-major order, level-shifted by -128.
 */
export function extractBlock(
  pixels: Uint8ClampedArray,
  _imgWidth: number,
  blockRow: number,
  blockCol: number,
  channelOffset: number,
  stride: number,
): Float64Array {
  const block = new Float64Array(64);
  const startY = blockRow * 8;
  const startX = blockCol * 8;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const px = (startY + r) * stride + (startX + c) * 4 + channelOffset;
      block[r * 8 + c] = (pixels[px] ?? 0) - 128;
    }
  }
  return block;
}

/**
 * Write an 8x8 block back into the pixel array for a single channel.
 * Values are level-shifted by +128 and clamped to [0, 255].
 */
export function writeBlock(
  pixels: Uint8ClampedArray,
  _imgWidth: number,
  blockRow: number,
  blockCol: number,
  channelOffset: number,
  stride: number,
  block: Float64Array,
): void {
  const startY = blockRow * 8;
  const startX = blockCol * 8;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const px = (startY + r) * stride + (startX + c) * 4 + channelOffset;
      pixels[px] = Math.max(0, Math.min(255, Math.round(block[r * 8 + c] + 128)));
    }
  }
}
