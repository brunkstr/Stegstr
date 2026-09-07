/**
 * Resize-invariant steganography: spread-transform dither modulation in a
 * canonically-normalised DCT domain.
 *
 * Replaces the 8x8-block QIM encoder in `stego-qim.ts`, which embeds in the
 * image's delivered resolution and therefore loses the payload the instant a
 * platform rescales — measured, a 1608 -> 1600 px resize (0.5%) destroys 100%
 * of payloads. See `robust_lab/RESULTS.md` for the full measurement.
 *
 * Two ideas do the work:
 *
 *   1. **Canonical normalisation.** Sender and receiver both resample the luma
 *      plane onto a fixed square before doing anything else, so a rescale by
 *      the platform is undone by the receiver's own normalisation and the
 *      embedding grid is reproducible at any delivered size.
 *
 *   2. **Spread-transform dither modulation.** Each payload bit owns a
 *      pseudorandom set of L mid-frequency coefficients and a +/-1 chip
 *      pattern, and rides on the *projection* of those coefficients onto the
 *      chip vector. Host interference cancels exactly, the change to any one
 *      coefficient is 1/sqrt(L) of the step, and the projection is L times
 *      more noise-resistant than any single coefficient.
 *
 * The resampler here is deliberately our own rather than the canvas one:
 * canvas scaling quality differs between browsers and platforms, and the
 * format has to mean the same thing everywhere.
 */

import pako from "pako";
import { RSCodec } from "./reed-solomon";
import { dct2d, idct2d } from "./dct2d";

/** Format marker, so a foreign image is rejected rather than misread. */
const MAGIC = [0x53, 0x47, 0x58, 0x31]; // "SGX1"
const HEADER_BYTES = MAGIC.length + 1 + 2; // magic + compression flag + length

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export interface StdmParams {
  /** Canonical square edge the luma plane is normalised to, at both ends. */
  canonical: number;
  /** Coefficients per payload bit. More = more robust, fewer bits. */
  chips: number;
  /**
   * Dither-modulation step, in canonical DCT units.
   *
   * Sized against the *worst* resampler a stego image is likely to meet, not
   * the best. Server-side resizing (Instagram, Telegram) uses a good filter and
   * decodes cleanly at half this step, but WhatsApp Web and Telegram Desktop
   * downscale in the client with a bilinear filter that aliases, and that costs
   * far more margin. Measured in Chromium: a 1600 -> 1080 canvas downscale
   * fails at 28, is marginal at 44, and is reliable at 52 for locator and 60 for
   * standard, which has half the spreading - while PSNR moves by
   * under half a decibel across that whole range.
   */
  delta: number;
  /** Usable band, as a fraction of the canonical Nyquist radius. */
  rLo: number;
  rHi: number;
  /** Reed-Solomon parity symbols. */
  rsNsym: number;
  /**
   * JPEG quality used when writing the stego image.
   *
   * High on purpose. The output's own compression noise, not the watermark,
   * dominates the distortion measured against the cover: at the shipping dither
   * step, dropping from q92 to q98 gains 1.8 dB of PSNR and writing PNG gains
   * 4.1 dB, with survival unchanged either way. There is no reason to spend
   * fidelity here when the receiving platform is going to recompress anyway.
   */
  quality: number;
  /**
   * Shortest edge, in pixels, this mode needs to work.
   *
   * A Nyquist argument gives a floor - the image must resolve the top of the
   * carrier band at `rHi` - but the true limit also depends on how much
   * spreading the mode has left to trade against resampling loss, so these are
   * measured rather than derived, with headroom over the measured floor (locator
   * fails at 240 and passes at 280; bulk fails at 800 and passes at 900).
   */
  minEdge: number;
}

/**
 * Band limits come from measurement, not intuition (`robust_lab/probe_band.py`):
 * below r ~ 0.08 the image's own energy dominates and edits become visible;
 * above r ~ 0.45 platform downscaling and JPEG quantisation eat the carrier,
 * Instagram first at ~0.39.
 */

/** Maximum robustness. Carries a locator, not a message. Survives WhatsApp. */
export const LOCATOR: StdmParams = {
  canonical: 512, chips: 50, delta: 56, rLo: 0.08, rHi: 0.40, rsNsym: 24, quality: 98, minEdge: 320,
};

/** Balanced: a short note travels entirely inside the image. */
export const STANDARD: StdmParams = {
  canonical: 512, chips: 25, delta: 64, rLo: 0.08, rHi: 0.45, rsNsym: 32, quality: 98, minEdge: 384,
};

/**
 * Large payload for gentle channels: Telegram "send as file", email, disk.
 * The wider band and larger canvas buy capacity at the cost of robustness,
 * which is the right trade only when nothing is going to recompress the image.
 */
export const BULK: StdmParams = {
  canonical: 1024, chips: 24, delta: 56, rLo: 0.08, rHi: 0.55, rsNsym: 48, quality: 98, minEdge: 960,
};

export const MODES: Record<string, StdmParams> = {
  locator: LOCATOR,
  standard: STANDARD,
  bulk: BULK,
};

export type ModeName = keyof typeof MODES;

/** Strength multipliers tried in order, weakest first. */
const CALIBRATION_STEPS = [1, 1.45, 2, 2.75, 3.75];

/** Key that derives the carrier layout. Same on both ends. */
const KEY_SEED = 0x57e65712;

// ---------------------------------------------------------------------------
// Deterministic PRNG (PCG-XSH-RR style, 32-bit)
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    // Decorrelate low bits, which the LCG leaves weak.
    let x = state;
    x ^= x >>> 15;
    x = Math.imul(x, 0x2c1b3c6d);
    x ^= x >>> 12;
    x = Math.imul(x, 0x297a2d39);
    x ^= x >>> 15;
    return (x >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Carrier layout
// ---------------------------------------------------------------------------

interface Carriers {
  /** Flat coefficient index per (bit, chip). */
  positions: Int32Array;
  /** +/-1 chip sign per (bit, chip). */
  signs: Float64Array;
  /** Per-bit dither offset, so lattices are not aligned across bits. */
  dither: Float64Array;
  bits: number;
  chips: number;
}

const carrierCache = new Map<string, Carriers>();

function bandIndices(p: StdmParams): Int32Array {
  const n = p.canonical;
  // The canonical transform is FFT-backed, so this is a hard requirement
  // rather than a preference. Catching it here names the offending parameter
  // instead of failing deep inside the transform.
  if (n < 8 || (n & (n - 1)) !== 0) {
    throw new Error(`canonical size must be a power of two, got ${n}`);
  }
  const out: number[] = [];
  for (let u = 0; u < n; u++) {
    for (let v = 0; v < n; v++) {
      const r = Math.sqrt((u / n) ** 2 + (v / n) ** 2);
      if (r >= p.rLo && r <= p.rHi) out.push(u * n + v);
    }
  }
  return Int32Array.from(out);
}

/** Total payload bits a mode can carry, before framing and parity. */
export function capacityBits(p: StdmParams): number {
  return Math.floor(bandIndices(p).length / p.chips);
}

/** Total codeword size for a mode. Fixed, so the detector knows the length. */
export function frameBytes(p: StdmParams): number {
  return Math.floor(capacityBits(p) / 8);
}

/** Usable payload bytes for a mode. */
export function payloadBytes(p: StdmParams): number {
  return Math.max(0, frameBytes(p) - p.rsNsym - HEADER_BYTES);
}

/**
 * Shortest edge an image needs for a mode to work.
 *
 * Below this, the carrier band is partly outside what the image can resolve,
 * so those bits are filtered away when the delta is resampled back down and
 * the payload is lost - silently, which is worse than refusing outright.
 */
export function minimumEdge(p: StdmParams): number {
  return p.minEdge;
}

function carriersFor(p: StdmParams): Carriers {
  const key = `${p.canonical}|${p.chips}|${p.rLo}|${p.rHi}|${p.rsNsym}`;
  const cached = carrierCache.get(key);
  if (cached) return cached;

  const band = bandIndices(p);
  const nbits = frameBytes(p) * 8;
  const need = nbits * p.chips;
  if (need > band.length) {
    throw new Error(`carrier layout does not fit: need ${need}, band has ${band.length}`);
  }

  // Fisher-Yates over the band, so each bit gets a disjoint, scattered chip set.
  const rng = makeRng(KEY_SEED);
  const order = Int32Array.from(band);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }

  const positions = order.slice(0, need);
  const signs = new Float64Array(need);
  for (let i = 0; i < need; i++) signs[i] = rng() < 0.5 ? -1 : 1;

  const dRng = makeRng(KEY_SEED ^ 0x9e3779b9);
  const dither = new Float64Array(nbits);
  for (let i = 0; i < nbits; i++) dither[i] = dRng() * p.delta;

  const c: Carriers = { positions, signs, dither, bits: nbits, chips: p.chips };
  carrierCache.set(key, c);
  return c;
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

/**
 * Build the weights that map one output sample to its input samples.
 *
 * Downscaling averages over the whole source footprint: the carrier lives in
 * mid frequencies, and point sampling would alias it into noise on the way to
 * the canonical grid. Upscaling interpolates instead — a box filter degenerates
 * to nearest-neighbour when magnifying, which would make the embedded delta
 * blocky, wasting signal energy and hurting invisibility.
 */
function resampleWeights(
  srcLen: number,
  dstLen: number,
): { starts: Int32Array; counts: Int32Array; weights: Float64Array } {
  const scale = srcLen / dstLen;
  const starts = new Int32Array(dstLen);
  const counts = new Int32Array(dstLen);
  const rows: number[][] = [];

  for (let d = 0; d < dstLen; d++) {
    if (scale > 1) {
      // Minifying: average the source interval this output pixel covers.
      const a = d * scale;
      const b = a + scale;
      const i0 = Math.max(0, Math.floor(a));
      const i1 = Math.min(srcLen, Math.ceil(b));
      const w: number[] = [];
      let total = 0;
      for (let i = i0; i < i1; i++) {
        const overlap = Math.min(b, i + 1) - Math.max(a, i);
        const v = overlap > 0 ? overlap : 0;
        w.push(v);
        total += v;
      }
      for (let i = 0; i < w.length; i++) w[i] = total > 0 ? w[i] / total : 1 / w.length;
      starts[d] = i0;
      counts[d] = w.length;
      rows.push(w);
    } else {
      // Magnifying: linear interpolation between the two nearest samples,
      // sampling at pixel centres so the grid stays aligned.
      const centre = (d + 0.5) * scale - 0.5;
      const i0 = Math.floor(centre);
      const frac = centre - i0;
      const a = Math.min(srcLen - 1, Math.max(0, i0));
      const b = Math.min(srcLen - 1, Math.max(0, i0 + 1));
      starts[d] = a;
      if (a === b) {
        counts[d] = 1;
        rows.push([1]);
      } else {
        counts[d] = 2;
        rows.push([1 - frac, frac]);
      }
    }
  }

  const flat = new Float64Array(rows.reduce((n, r) => n + r.length, 0));
  let at = 0;
  for (const row of rows) {
    for (const w of row) flat[at++] = w;
  }
  return { starts, counts, weights: flat };
}

/** Separable resample of a single plane, correct in both directions. */
export function resamplePlane(
  src: Float64Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float64Array {
  const xs = resampleWeights(srcW, dstW);
  const ys = resampleWeights(srcH, dstH);

  const tmp = new Float64Array(dstW * srcH);
  for (let y = 0; y < srcH; y++) {
    const rowOffset = y * srcW;
    let wAt = 0;
    for (let x = 0; x < dstW; x++) {
      let sum = 0;
      const start = xs.starts[x];
      const count = xs.counts[x];
      for (let k = 0; k < count; k++) {
        sum += src[rowOffset + Math.min(srcW - 1, start + k)] * xs.weights[wAt + k];
      }
      wAt += count;
      tmp[y * dstW + x] = sum;
    }
  }

  const out = new Float64Array(dstW * dstH);
  let wAt = 0;
  for (let y = 0; y < dstH; y++) {
    const start = ys.starts[y];
    const count = ys.counts[y];
    for (let x = 0; x < dstW; x++) {
      let sum = 0;
      for (let k = 0; k < count; k++) {
        sum += tmp[Math.min(srcH - 1, start + k) * dstW + x] * ys.weights[wAt + k];
      }
      out[y * dstW + x] = sum;
    }
    wAt += count;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

function frame(payload: Uint8Array, p: StdmParams): Uint8Array {
  // An empty payload is always a mistake, and the failure is invisible: the
  // embed succeeds, the image looks right, and the recipient gets nothing.
  // Refusing here covers the CLI, the app and the agent API at once.
  if (payload.length === 0) {
    throw new Error("payload is empty: there is nothing to hide");
  }

  let body = pako.deflate(payload);
  let flag = 1;
  if (body.length >= payload.length) {
    body = payload;
    flag = 0;
  }

  const room = payloadBytes(p);
  if (body.length > room) {
    throw new Error(
      `payload too large for this mode: ${body.length} bytes after compression, room for ${room}`,
    );
  }

  const message = new Uint8Array(HEADER_BYTES + room);
  message.set(MAGIC, 0);
  message[MAGIC.length] = flag;
  message[MAGIC.length + 1] = (body.length >>> 8) & 0xff;
  message[MAGIC.length + 2] = body.length & 0xff;
  message.set(body, HEADER_BYTES);

  return new RSCodec(p.rsNsym).encode(message);
}

function unframe(data: Uint8Array, p: StdmParams, erasePos?: number[]): Uint8Array | null {
  let decoded: Uint8Array;
  try {
    decoded = new RSCodec(p.rsNsym).decode(data, erasePos);
  } catch {
    return null;
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (decoded[i] !== MAGIC[i]) return null;
  }
  const flag = decoded[MAGIC.length];
  const length = (decoded[MAGIC.length + 1] << 8) | decoded[MAGIC.length + 2];
  if (HEADER_BYTES + length > decoded.length) return null;
  const body = decoded.slice(HEADER_BYTES, HEADER_BYTES + length);
  if (flag === 1) {
    try {
      return pako.inflate(body);
    } catch {
      return null;
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// Core: embed / detect on a luma plane
// ---------------------------------------------------------------------------

/**
 * Compute the luma delta that carries `payload`, at the plane's own size.
 * Add it to every colour channel to apply it.
 */
export function computeDelta(
  y: Float64Array,
  width: number,
  height: number,
  payload: Uint8Array,
  p: StdmParams,
): Float64Array {
  const shortest = Math.min(width, height);
  const needed = minimumEdge(p);
  if (shortest < needed) {
    throw new Error(
      `image is too small for this mode: shortest edge is ${shortest}px, ` +
        `needs at least ${needed}px - use a larger image or a mode with a smaller canvas`,
    );
  }

  const codeword = frame(payload, p);
  const carriers = carriersFor(p);
  const { positions, signs, dither, chips } = carriers;

  const n = p.canonical;
  const canon = resamplePlane(y, width, height, n, n);
  const original = Float64Array.from(canon);

  dct2d(canon, n);

  const invNorm = 1 / Math.sqrt(chips);
  for (let b = 0; b < carriers.bits; b++) {
    const bit = (codeword[b >> 3] >> (7 - (b & 7))) & 1;

    let host = 0;
    const base = b * chips;
    for (let c = 0; c < chips; c++) host += canon[positions[base + c]] * signs[base + c];
    host *= invNorm;

    // Quantise the projection onto the lattice whose parity carries the bit.
    let k = Math.round((host - dither[b]) / p.delta);
    if (((k % 2) + 2) % 2 !== bit) k += 1;
    const target = k * p.delta + dither[b];

    const correction = (target - host) * invNorm;
    for (let c = 0; c < chips; c++) {
      canon[positions[base + c]] += correction * signs[base + c];
    }
  }

  idct2d(canon, n);

  for (let i = 0; i < canon.length; i++) canon[i] -= original[i];
  return resamplePlane(canon, n, n, width, height);
}

/**
 * Symmetric insets tried when the first read fails. Platforms that trim a few
 * pixels to hit an allowed aspect ratio (Instagram) shift the content extent,
 * which moves the canonical grid; re-expanding by a candidate inset puts it
 * back. Only small insets are listed: the re-expansion replicates edge pixels,
 * which approximates a thin missing border well but injects low-frequency
 * error into the carrier band once it is not thin. Measured: 2% per edge
 * recovers, 5% does not.
 */
type CropHypothesis = { px: number } | { frac: number };

/**
 * Insets tried when the first read fails, in the order that pays off soonest.
 *
 * Two shapes, because platforms crop two different ways. Aspect-ratio trims
 * remove a *fixed pixel count* per edge - Instagram takes up to about four -
 * and a fixed count is a different fraction on each axis, so guessing in
 * fractions misses it; those are the `px` entries, scaled to whatever size the
 * image arrived at. Deliberate user crops are proportionally larger, and those
 * are the `frac` entries.
 *
 * Measured (`robust_lab/_isolate.py`): Instagram's trim, not its sharpening,
 * was the only thing still costing us decodes.
 */
const CROP_HYPOTHESES: CropHypothesis[] = [
  { px: 0 },
  { px: 2 },
  { px: 4 },
  { px: 7 },
  { px: 11 },
  { frac: 0.012 },
  { frac: 0.022 },
  { frac: 0.035 },
];

function padEdge(
  y: Float64Array,
  width: number,
  height: number,
  dx: number,
  dy: number,
): { plane: Float64Array; width: number; height: number } {
  const w = width + 2 * dx;
  const h = height + 2 * dy;
  const out = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    const sy = Math.min(height - 1, Math.max(0, j - dy));
    for (let i = 0; i < w; i++) {
      const sx = Math.min(width - 1, Math.max(0, i - dx));
      out[j * w + i] = y[sy * width + sx];
    }
  }
  return { plane: out, width: w, height: h };
}

interface FrameRead {
  /** The recovered codeword bytes. */
  data: Uint8Array;
  /** Per byte, how far its least trustworthy bit sat from a decision boundary. */
  confidence: Float64Array;
}

function readFrame(
  y: Float64Array,
  width: number,
  height: number,
  p: StdmParams,
  carriers: Carriers,
): FrameRead {
  const n = p.canonical;
  const canon = resamplePlane(y, width, height, n, n);
  dct2d(canon, n);

  const { positions, signs, dither, chips } = carriers;
  const invNorm = 1 / Math.sqrt(chips);
  const data = new Uint8Array(carriers.bits >> 3);
  const confidence = new Float64Array(data.length).fill(1);

  for (let b = 0; b < carriers.bits; b++) {
    let proj = 0;
    const base = b * chips;
    for (let c = 0; c < chips; c++) proj += canon[positions[base + c]] * signs[base + c];
    proj *= invNorm;

    const scaled = (proj - dither[b]) / p.delta;
    const k = Math.round(scaled);
    if (((k % 2) + 2) % 2 === 1) data[b >> 3] |= 1 << (7 - (b & 7));

    // How far this projection sat from the midpoint between lattice points.
    // 0.5 means it landed exactly on a lattice point and is trustworthy; 0
    // means it was a coin toss. A byte is only as good as its weakest bit.
    const margin = 0.5 - Math.abs(scaled - k);
    const i = b >> 3;
    if (margin < confidence[i]) confidence[i] = margin;
  }
  return { data, confidence };
}

/**
 * Decode a frame, spending Reed-Solomon's budget on erasures when plain
 * decoding fails.
 *
 * RS corrects twice as many erasures as errors for the same parity, and the
 * dither margins tell us which bytes to distrust. So: try it clean, then retry
 * declaring progressively more of the least confident bytes as erasures. Each
 * attempt is a cheap RS decode, and RS's own integrity check rejects a wrong
 * guess, so a bad hypothesis costs nothing but time.
 */
function decodeFrame(read: FrameRead, p: StdmParams): Uint8Array | null {
  const direct = unframe(read.data, p);
  if (direct) return direct;

  const order = Array.from(read.confidence.keys()).sort(
    (a, b) => read.confidence[a] - read.confidence[b],
  );

  for (let count = 4; count <= p.rsNsym; count += 4) {
    const result = unframe(read.data, p, order.slice(0, count));
    if (result) return result;
  }
  return null;
}

/** Recover a payload from a luma plane of any size, or null. */
/**
 * Recover a payload from a luma plane of any size, or null.
 *
 * The strength is not carried in the image - it cannot be, since reading it
 * would require having already decoded - so the detector walks the same ladder
 * the encoder calibrates along. The base step is tried first because it covers
 * almost every photograph; the stronger ones only cost time on images that do
 * not decode anyway. Reed-Solomon's integrity check plus the format marker
 * reject a wrong guess, so a miss costs one transform rather than a false read.
 */
export function detectFromPlane(
  y: Float64Array,
  width: number,
  height: number,
  p: StdmParams,
): Uint8Array | null {
  for (const step of CALIBRATION_STEPS) {
    const params = step === 1 ? p : { ...p, delta: p.delta * step };
    const found = detectAtStrength(y, width, height, params);
    if (found) return found;
  }
  return null;
}

function detectAtStrength(
  y: Float64Array,
  width: number,
  height: number,
  p: StdmParams,
): Uint8Array | null {
  const carriers = carriersFor(p);

  for (const hypothesis of CROP_HYPOTHESES) {
    let dx: number;
    let dy: number;
    if ("px" in hypothesis) {
      // Expressed against a 1600px reference, so the guess tracks the trim
      // regardless of the size the image was delivered at.
      const scale = Math.max(width, height) / 1600;
      dx = Math.round(hypothesis.px * scale);
      dy = dx;
    } else {
      dx = Math.round(width * hypothesis.frac);
      dy = Math.round(height * hypothesis.frac);
    }

    let plane = y;
    let w = width;
    let h = height;
    if (dx > 0 || dy > 0) {
      const padded = padEdge(y, width, height, dx, dy);
      plane = padded.plane;
      w = padded.width;
      h = padded.height;
    }

    const result = decodeFrame(readFrame(plane, w, h, p, carriers), p);
    if (result) return result;
  }
  return null;
}


// ---------------------------------------------------------------------------
// Calibrated embedding
// ---------------------------------------------------------------------------

/**
 * Put pixels through a platform-like round trip and hand back what survives.
 *
 * Supplied by the caller because the core carries no image codec: the browser
 * uses canvas, Node uses jpeg-js. It must model both halves of what a platform
 * does - the downscale and the recompression - because they fail differently
 * and calibrating against only one leaves the other broken.
 */
export type StressCodec = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: Uint8ClampedArray; width: number; height: number };


export interface CalibratedEmbed {
  pixels: Uint8ClampedArray;
  /** The step actually used, in canonical DCT units. */
  delta: number;
  /** True if the result survived the stress re-encode. */
  verified: boolean;
}

/**
 * Embed at the weakest strength that still survives a stress re-encode.
 *
 * A fixed strength cannot serve every cover. Photographs carry the default
 * comfortably. A document scan or screenshot does not: it is mostly flat paper,
 * and JPEG's quantiser zeroes small coefficients in smooth blocks, erasing the
 * payload exactly where there is no detail to shelter it. Measured on a page of
 * text, the default step lost the three harshest profiles; raising it to about
 * twice that recovered all five.
 *
 * Rather than picking one number and being wrong for half of all images, this
 * tries the default first and steps up only when the cover demands it, so
 * photographs keep their invisibility and hard covers still work. The cost is
 * paid in visibility only where it has to be, and the caller learns which
 * happened.
 */
export function embedCalibrated(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  payload: Uint8Array,
  p: StdmParams,
  stress: StressCodec,
): CalibratedEmbed {
  let last: CalibratedEmbed | null = null;

  for (const step of CALIBRATION_STEPS) {
    const params = step === 1 ? p : { ...p, delta: p.delta * step };
    const pixels = embedIntoRgba(data, width, height, payload, params);

    const attacked = stress(pixels, width, height);
    const recovered = detectAtStrength(
      lumaFromRgba(attacked.data, attacked.width, attacked.height),
      attacked.width,
      attacked.height,
      params,
    );
    const ok =
      recovered !== null &&
      recovered.length === payload.length &&
      recovered.every((v, i) => v === payload[i]);

    last = { pixels, delta: params.delta, verified: ok };
    if (ok) return last;
  }

  // Nothing survived. Return the strongest attempt and say so, rather than
  // handing back an image that looks fine and carries nothing usable.
  return last!;
}

// ---------------------------------------------------------------------------
// RGBA helpers
// ---------------------------------------------------------------------------

/** JPEG/JFIF luminance. */
export function lumaFromRgba(data: Uint8ClampedArray, width: number, height: number): Float64Array {
  const y = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    y[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return y;
}

/**
 * Apply a luma delta to RGBA pixels.
 *
 * The same delta goes to R, G and B: because the luma weights sum to 1, that
 * shifts Y by exactly the delta and leaves chroma untouched — which matters,
 * since every platform subsamples chroma 4:2:0 and would otherwise smear the
 * carrier.
 */
export function applyDeltaToRgba(
  data: Uint8ClampedArray,
  delta: Float64Array,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data);
  for (let i = 0; i < width * height; i++) {
    const d = delta[i];
    out[i * 4] = Math.round(data[i * 4] + d);
    out[i * 4 + 1] = Math.round(data[i * 4 + 1] + d);
    out[i * 4 + 2] = Math.round(data[i * 4 + 2] + d);
  }
  return out;
}

/** Embed into RGBA pixels, returning modified pixels. */
/**
 * Correction passes after the first write.
 *
 * The open-loop delta assumes every pixel can absorb its share of the change.
 * Near black or white they cannot: the value clips at the rail and that part of
 * the signal is lost. At the default strength this barely matters, which is why
 * a first attempt at fixing it showed nothing. It matters enormously once
 * calibration raises the strength for a hard cover: on a page of text - 84% of
 * it within a few levels of white - a stronger step made results *worse*,
 * because the target moved further out of reach than the extra margin was
 * worth.
 *
 * So after writing, re-read what the pixels actually carry and drive the
 * remaining error back in. Clipped regions stay clipped, but the projection is
 * spread over hundreds of coefficients and the rest take up the slack.
 */
const EMBED_PASSES = 4;

export function embedIntoRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  payload: Uint8Array,
  p: StdmParams = LOCATOR,
): Uint8ClampedArray {
  const shortest = Math.min(width, height);
  const needed = minimumEdge(p);
  if (shortest < needed) {
    throw new Error(
      `image is too small for this mode: shortest edge is ${shortest}px, ` +
        `needs at least ${needed}px - use a larger image or a mode with a smaller canvas`,
    );
  }

  const codeword = frame(payload, p);
  const carriers = carriersFor(p);
  const { positions, signs, dither, chips } = carriers;
  const n = p.canonical;
  const invNorm = 1 / Math.sqrt(chips);

  const canonOf = (pixels: Uint8ClampedArray): Float64Array => {
    const plane = resamplePlane(lumaFromRgba(pixels, width, height), width, height, n, n);
    dct2d(plane, n);
    return plane;
  };

  const project = (coeffs: Float64Array, b: number): number => {
    let acc = 0;
    const base = b * chips;
    for (let c = 0; c < chips; c++) acc += coeffs[positions[base + c]] * signs[base + c];
    return acc * invNorm;
  };

  // Lattice targets are chosen once, from the untouched host. Re-choosing them
  // each pass would let a bit drift into the neighbouring cell and flip.
  const first = canonOf(data);
  const targets = new Float64Array(carriers.bits);
  for (let b = 0; b < carriers.bits; b++) {
    const bit = (codeword[b >> 3] >> (7 - (b & 7))) & 1;
    let k = Math.round((project(first, b) - dither[b]) / p.delta);
    if (((k % 2) + 2) % 2 !== bit) k += 1;
    targets[b] = k * p.delta + dither[b];
  }

  let out = new Uint8ClampedArray(data);
  for (let pass = 0; pass < EMBED_PASSES; pass++) {
    const coeffs = canonOf(out);
    const corrections = new Float64Array(coeffs.length);

    let worst = 0;
    for (let b = 0; b < carriers.bits; b++) {
      const err = targets[b] - project(coeffs, b);
      worst = Math.max(worst, Math.abs(err));
      const scaled = err * invNorm;
      const base = b * chips;
      for (let c = 0; c < chips; c++) corrections[positions[base + c]] += scaled * signs[base + c];
    }
    if (pass > 0 && worst < p.delta * 0.02) break;

    idct2d(corrections, n);
    out = applyDeltaToRgba(out, resamplePlane(corrections, n, n, width, height), width, height);
  }
  return out;
}

/** Detect from RGBA pixels. */
export function detectFromRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  p: StdmParams = LOCATOR,
): Uint8Array | null {
  return detectFromPlane(lumaFromRgba(data, width, height), width, height, p);
}

/** Try every mode, cheapest first. Used when the receiver has no hint. */
export function detectAnyMode(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { payload: Uint8Array; mode: ModeName } | null {
  for (const mode of ["locator", "standard", "bulk"] as ModeName[]) {
    const payload = detectFromRgba(data, width, height, MODES[mode]);
    if (payload) return { payload, mode };
  }
  return null;
}
