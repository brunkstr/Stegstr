/**
 * Dot-offset steganography for browser (robust to platform transforms).
 * Payload format: MAGIC + 4-byte big-endian length + payload.
 * Encoded with 2-bit offset in 2x2 micro-cell, on a grid.
 */

const MAGIC = new TextEncoder().encode("STEGSTR");
const MAGIC_LEN = 7;
const LENGTH_BYTES = 4;

const STEP = 6;
const OFFSET = 2;
const REPEAT = 3;

function bytesToBits(data: Uint8Array): number[] {
  const out: number[] = [];
  for (const b of data) {
    for (let i = 7; i >= 0; i--) out.push((b >> i) & 1);
  }
  return out;
}

function bitsToBytes(bits: number[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < out.length; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      const idx = i * 8 + j;
      if (idx < bits.length) byte |= (bits[idx] & 1) << (7 - j);
    }
    out[i] = byte;
  }
  return out;
}

function wrapPayload(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(MAGIC_LEN + LENGTH_BYTES + payload.length);
  out.set(MAGIC, 0);
  const len = payload.length;
  out[MAGIC_LEN] = (len >>> 24) & 0xff;
  out[MAGIC_LEN + 1] = (len >>> 16) & 0xff;
  out[MAGIC_LEN + 2] = (len >>> 8) & 0xff;
  out[MAGIC_LEN + 3] = len & 0xff;
  out.set(payload, MAGIC_LEN + LENGTH_BYTES);
  return out;
}

function unwrapPayload(raw: Uint8Array): Uint8Array | null {
  if (raw.length < MAGIC_LEN + LENGTH_BYTES) return null;
  for (let i = 0; i < MAGIC_LEN; i++) if (raw[i] !== MAGIC[i]) return null;
  const len =
    (raw[MAGIC_LEN] << 24) |
    (raw[MAGIC_LEN + 1] << 16) |
    (raw[MAGIC_LEN + 2] << 8) |
    raw[MAGIC_LEN + 3];
  if (raw.length < MAGIC_LEN + LENGTH_BYTES + len) return null;
  return raw.slice(MAGIC_LEN + LENGTH_BYTES, MAGIC_LEN + LENGTH_BYTES + len);
}

function buildToEmbed(payload: Uint8Array): Uint8Array {
  const wrapped = wrapPayload(payload);
  if (wrapped.length > 65535) throw new Error("Payload too large for dot method");
  const out = new Uint8Array(2 + wrapped.length);
  out[0] = (wrapped.length >>> 8) & 0xff;
  out[1] = wrapped.length & 0xff;
  out.set(wrapped, 2);
  return out;
}

function cellPositions(width: number, height: number): Array<[number, number]> {
  const positions: Array<[number, number]> = [];
  const maxX = width - 2;
  const maxY = height - 2;
  for (let y = OFFSET; y <= maxY; y += STEP) {
    for (let x = OFFSET; x <= maxX; x += STEP) {
      positions.push([x, y]);
    }
  }
  return positions;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function spreadPositions(positions: Array<[number, number]>): Array<[number, number]> {
  const len = positions.length;
  if (len <= 1) return positions.slice();
  let step = 131;
  while (gcd(step, len) !== 1) step += 2;
  const ordered = new Array<[number, number]>(len);
  let idx = 0;
  for (let i = 0; i < len; i++) {
    ordered[i] = positions[idx];
    idx = (idx + step) % len;
  }
  return ordered;
}

export function encodeDotIntoRGBA(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  payload: Uint8Array
): { data: Uint8ClampedArray; width: number; height: number } {
  const raw = data.slice(0);
  const toEmbed = buildToEmbed(payload);
  const bits = bytesToBits(toEmbed);
  const positions = cellPositions(width, height);
  const orderedPositions = spreadPositions(positions);
  const capacityBits = Math.floor((orderedPositions.length * 2) / REPEAT);
  if (bits.length > capacityBits) {
    throw new Error(`Payload too large: need ${bits.length} bits, have ${capacityBits}`);
  }
  const offsets: Array<[number, number]> = [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ];
  const symbols: Array<[number, number]> = [];
  for (let i = 0; i < bits.length; i += 2) {
    symbols.push([bits[i] ?? 0, bits[i + 1] ?? 0]);
  }
  const neededCells = symbols.length * REPEAT;
  if (neededCells > orderedPositions.length) {
    throw new Error(`Payload too large: need ${neededCells} cells, have ${orderedPositions.length}`);
  }
  const stride = symbols.length;
  for (let si = 0; si < symbols.length; si++) {
    const [b0, b1] = symbols[si];
    const idx = ((b0 & 1) << 1) | (b1 & 1);
    const [bx, by] = offsets[idx];
    for (let r = 0; r < REPEAT; r++) {
      const posIdx = si + r * stride;
      if (posIdx >= orderedPositions.length) break;
      const [x, y] = orderedPositions[posIdx];
      for (const [ox, oy] of offsets) {
        const wi = (y + oy) * width * 4 + (x + ox) * 4;
        raw[wi] = 255;
        raw[wi + 1] = 255;
        raw[wi + 2] = 255;
      }
      const bi = (y + by) * width * 4 + (x + bx) * 4;
      raw[bi] = 0;
      raw[bi + 1] = 0;
      raw[bi + 2] = 0;
    }
  }
  return { data: raw, width, height };
}

function decodeFromPositions(
  data: Uint8ClampedArray,
  width: number,
  positions: Array<[number, number]>,
  repeat: number
): Uint8Array | null {
  if (positions.length === 0) return null;
  const offsets: Array<[number, number]> = [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ];
  const symbols: number[] = [];
  for (const [x, y] of positions) {
    let minIdx = 0;
    let minVal = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < offsets.length; i++) {
      const [ox, oy] = offsets[i];
      const idx = (y + oy) * width * 4 + (x + ox) * 4;
      const v = data[idx] + data[idx + 1] + data[idx + 2];
      if (v < minVal) {
        minVal = v;
        minIdx = i;
      }
    }
    symbols.push(minIdx);
  }
  const stride = Math.floor(symbols.length / repeat);
  if (stride === 0) return null;
  const bits: number[] = [];
  for (let si = 0; si < stride; si++) {
    const counts = [0, 0, 0, 0];
    for (let r = 0; r < repeat; r++) {
      const sym = symbols[si + r * stride];
      if (sym >= 0 && sym < 4) counts[sym] += 1;
    }
    let maxIdx = 0;
    let maxCount = -1;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] > maxCount) {
        maxCount = counts[i];
        maxIdx = i;
      }
    }
    bits.push((maxIdx >> 1) & 1, maxIdx & 1);
  }
  if (bits.length < 16) return null;
  const header = bitsToBytes(bits.slice(0, 16));
  const codewordLen = (header[0] << 8) | header[1];
  const totalBits = (2 + codewordLen) * 8;
  if (bits.length < totalBits) return null;
  const raw = bitsToBytes(bits.slice(0, totalBits));
  const payloadRaw = raw.slice(2, 2 + codewordLen);
  return unwrapPayload(payloadRaw);
}

export function decodeDotFromRGBA(
  data: Uint8ClampedArray,
  width: number,
  height: number
): Uint8Array | null {
  const positions = cellPositions(width, height);
  if (positions.length === 0) return null;
  const spread = spreadPositions(positions);
  const repeated = decodeFromPositions(data, width, spread, REPEAT);
  if (repeated) return repeated;
  const legacySpread = decodeFromPositions(data, width, spread, 1);
  if (legacySpread) return legacySpread;
  return decodeFromPositions(data, width, positions, 1);
}

export function getDotCapacityBytes(width: number, height: number): number {
  const positions = cellPositions(width, height);
  const capacityBits = Math.floor((positions.length * 2) / REPEAT);
  const overheadBytes = 2 + MAGIC_LEN + LENGTH_BYTES;
  const capacityBytes = Math.floor(capacityBits / 8);
  return Math.max(0, capacityBytes - overheadBytes);
}
