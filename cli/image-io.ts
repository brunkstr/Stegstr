/**
 * Image I/O for the headless CLI.
 *
 * The browser build gets JPEG encode/decode from canvas; Node has no canvas,
 * so this uses pure-JS codecs. No native modules and no build step, which is
 * the point: an agent or a judge can run the CLI straight from a clone.
 */

import { readFileSync, writeFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

export interface Raster {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}

export function decodeImage(bytes: Uint8Array): Raster {
  if (isPng(bytes)) {
    const png = PNG.sync.read(Buffer.from(bytes));
    return {
      data: new Uint8ClampedArray(png.data),
      width: png.width,
      height: png.height,
    };
  }
  if (isJpeg(bytes)) {
    // `useTArray` keeps the result a Uint8Array rather than a Buffer.
    const raw = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true });
    return {
      data: new Uint8ClampedArray(raw.data),
      width: raw.width,
      height: raw.height,
    };
  }
  throw new Error("unsupported image format: expected PNG or JPEG");
}

export function readImage(path: string): Raster {
  return decodeImage(new Uint8Array(readFileSync(path)));
}

export function encodeJpeg(raster: Raster, quality: number): Uint8Array {
  const encoded = jpeg.encode(
    { data: Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.length), width: raster.width, height: raster.height },
    quality,
  );
  return new Uint8Array(encoded.data);
}

export function encodePng(raster: Raster): Uint8Array {
  const png = new PNG({ width: raster.width, height: raster.height });
  png.data = Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.length);
  return new Uint8Array(PNG.sync.write(png));
}

export function writeImage(path: string, raster: Raster, quality: number): void {
  const bytes = path.toLowerCase().endsWith(".png")
    ? encodePng(raster)
    : encodeJpeg(raster, quality);
  writeFileSync(path, bytes);
}
