/**
 * Minimal raw PNG decoder for exact pixel values (no canvas/ImageBitmap).
 * Used for stego decode in the browser so LSB values are preserved.
 */

import pako from "pako";

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readU32(b: Uint8Array, off: number): number {
  return (b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!;
}

/** Apply PNG row filter to reconstruct raw bytes. */
function unfilter(
  out: Uint8Array,
  raw: Uint8Array,
  width: number,
  height: number,
  bpp: number
): void {
  const rowBytes = width * bpp;
  const stride = 1 + rowBytes;
  for (let y = 0; y < height; y++) {
    const rawOff = y * stride;
    const filter = raw[rawOff]!;
    const prevRow = y > 0 ? out.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? out[y * rowBytes + x - bpp]! : 0;
      const b = prevRow ? prevRow[x]! : 0;
      const c = x >= bpp && prevRow ? prevRow[x - bpp]! : 0;
      const v = (raw[rawOff + 1 + x]! + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? ((a + b) >>> 1) : filter === 4 ? paeth(a, b, c) : 0)) & 0xff;
      out[y * rowBytes + x] = v;
    }
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode PNG from ArrayBuffer to raw RGBA (8-bit per channel).
 * Preserves exact pixel values for LSB steganography.
 */
export function decodePngToRGBA(buffer: ArrayBuffer): { data: Uint8ClampedArray; width: number; height: number } {
  const u8 = new Uint8Array(buffer);
  if (u8.length < 8 || u8[0] !== PNG_SIG[0] || u8[1] !== PNG_SIG[1]) {
    throw new Error("Invalid PNG signature");
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Uint8Array[] = [];

  while (off + 12 <= u8.length) {
    const len = readU32(u8, off);
    const type = String.fromCharCode(u8[off + 4]!, u8[off + 5]!, u8[off + 6]!, u8[off + 7]!);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > u8.length) throw new Error("PNG chunk overflow");
    if (type === "IHDR") {
      if (len < 13) throw new Error("IHDR too short");
      width = readU32(u8, dataStart);
      height = readU32(u8, dataStart + 4);
      bitDepth = u8[dataStart + 8]!;
      colorType = u8[dataStart + 9]!;
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error("PNG must be 8-bit RGB or RGBA");
      }
    } else if (type === "IDAT") {
      idatChunks.push(u8.subarray(dataStart, dataEnd));
    }
    off = dataEnd + 4;
  }

  if (width <= 0 || height <= 0) throw new Error("PNG IHDR not found");
  const combined = new Uint8Array(idatChunks.reduce((s, c) => s + c.length, 0));
  let pos = 0;
  for (const c of idatChunks) {
    combined.set(c, pos);
    pos += c.length;
  }
  const raw = pako.inflate(combined);
  const bpp = colorType === 6 ? 4 : 3;
  const rowBytes = width * bpp;
  const filteredSize = height * (1 + rowBytes);
  if (raw.length < filteredSize) throw new Error("PNG IDAT too short");
  const out = new Uint8Array(height * rowBytes);
  unfilter(out, raw, width, height, bpp);
  if (colorType === 2) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = out[i * 3]!;
      rgba[i * 4 + 1] = out[i * 3 + 1]!;
      rgba[i * 4 + 2] = out[i * 3 + 2]!;
      rgba[i * 4 + 3] = 255;
    }
    return { data: rgba, width, height };
  }
  return { data: new Uint8ClampedArray(out), width, height };
}
