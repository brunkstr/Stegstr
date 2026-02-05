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
  const capacityBits = positions.length * 2;
  if (bits.length > capacityBits) {
    throw new Error(`Payload too large: need ${bits.length} bits, have ${capacityBits}`);
  }
  const offsets: Array<[number, number]> = [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ];
  let bitIdx = 0;
  for (const [x, y] of positions) {
    const b0 = bits[bitIdx] ?? 0;
    const b1 = bits[bitIdx + 1] ?? 0;
    const idx = ((b0 & 1) << 1) | (b1 & 1);
    const [bx, by] = offsets[idx];
    const [wx, wy] = offsets[(idx + 2) % 4];
    const bi = (y + by) * width * 4 + (x + bx) * 4;
    raw[bi] = 0; raw[bi + 1] = 0; raw[bi + 2] = 0;
    const wi = (y + wy) * width * 4 + (x + wx) * 4;
    raw[wi] = 255; raw[wi + 1] = 255; raw[wi + 2] = 255;
    bitIdx += 2;
    if (bitIdx >= bits.length) break;
  }
  return { data: raw, width, height };
}

export function decodeDotFromRGBA(
  data: Uint8ClampedArray,
  width: number,
  height: number
): Uint8Array | null {
  const positions = cellPositions(width, height);
  if (positions.length === 0) return null;
  const offsets: Array<[number, number]> = [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ];
  const bits: number[] = [];
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
    bits.push((minIdx >> 1) & 1, minIdx & 1);
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
