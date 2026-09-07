/**
 * Browser bindings for the resize-invariant encoder in `stego-stdm.ts`.
 *
 * The core is deliberately free of canvas so it can be tested and reused in
 * Node; this module is the thin layer that gets pixels in and a JPEG out.
 *
 * Note what is *absent*: there is no per-platform pre-resize step. The old QIM
 * encoder had to guess the destination and shrink the cover to that platform's
 * exact cap so no resize would happen in transit, and it lost the payload
 * whenever the guess was wrong. Normalisation makes the destination irrelevant.
 */

import {
  LOCATOR,
  MODES,
  type ModeName,
  type StdmParams,
  detectFromRgba,
  embedIntoRgba,
  minimumEdge,
  payloadBytes,
} from "./stego-stdm";

export { MODES, LOCATOR, payloadBytes, minimumEdge };
export type { ModeName, StdmParams };

/** What each mode is for, in the words the embed dialog should use. */
export const MODE_LABELS: Record<ModeName, { title: string; detail: string }> = {
  locator: {
    title: "Maximum robustness",
    detail: "Survives WhatsApp, Instagram and Telegram. Carries a reference; the post itself syncs over relays.",
  },
  standard: {
    title: "Balanced",
    detail: "A short note travels inside the image. Survives most platforms.",
  },
  bulk: {
    title: "Large payload",
    detail: "For files sent losslessly - Telegram \"send as file\", email, or disk. Will not survive recompression.",
  },
};

interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function draw(source: ImageBitmap, width: number, height: number): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("could not get a 2d context");
    ctx.drawImage(source, 0, 0);
    return ctx;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not get a 2d context");
  ctx.drawImage(source, 0, 0);
  return ctx;
}

async function fileToPixels(file: Blob): Promise<Pixels> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = bitmap;
    const ctx = draw(bitmap, width, height);
    return { data: ctx.getImageData(0, 0, width, height).data, width, height };
  } finally {
    bitmap.close();
  }
}

async function pixelsToJpeg(pixels: Pixels, quality: number): Promise<Blob> {
  const imageData = new ImageData(pixels.data, pixels.width, pixels.height);
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(pixels.width, pixels.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("could not get a 2d context");
    ctx.putImageData(imageData, 0, 0);
    return canvas.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
  }
  const canvas = document.createElement("canvas");
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not get a 2d context");
  ctx.putImageData(imageData, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvas produced no image"))),
      "image/jpeg",
      quality / 100,
    );
  });
}

/** Capacity and dimensions for a cover, without modifying it. */
export async function getStdmCapacityForFile(
  coverFile: Blob,
  mode: ModeName = "locator",
): Promise<{ capacityBytes: number; width: number; height: number; usable: boolean; minEdge: number }> {
  const params = MODES[mode];
  const bitmap = await createImageBitmap(coverFile);
  const { width, height } = bitmap;
  bitmap.close();
  const minEdge = minimumEdge(params);
  return {
    capacityBytes: payloadBytes(params),
    width,
    height,
    usable: Math.min(width, height) >= minEdge,
    minEdge,
  };
}

/** Embed a payload into a cover image, returning a JPEG blob. */
export async function encodeStdmImageFile(
  coverFile: Blob,
  payload: Uint8Array,
  mode: ModeName = "locator",
  overrides?: Partial<StdmParams>,
): Promise<Blob> {
  const params = overrides ? { ...MODES[mode], ...overrides } : MODES[mode];
  const pixels = await fileToPixels(coverFile);
  const embedded = embedIntoRgba(pixels.data, pixels.width, pixels.height, payload, params);
  return pixelsToJpeg({ data: embedded, width: pixels.width, height: pixels.height }, params.quality);
}

/**
 * Detect a payload, trying each mode unless one is named.
 *
 * Returns the raw bytes as well as the string form: callers that need to
 * decrypt want the bytes, and re-encoding a base64 string to get them back is
 * both wasteful and lossy for non-UTF-8 payloads.
 */
export async function decodeStdmImageFile(
  file: Blob,
  mode?: ModeName,
  overrides?: Partial<StdmParams>,
): Promise<{ ok: boolean; payload?: string; bytes?: Uint8Array; mode?: ModeName; error?: string }> {
  try {
    const pixels = await fileToPixels(file);
    const candidates: ModeName[] = mode ? [mode] : (Object.keys(MODES) as ModeName[]);

    for (const candidate of candidates) {
      const params = overrides ? { ...MODES[candidate], ...overrides } : MODES[candidate];
      if (Math.min(pixels.width, pixels.height) < minimumEdge(params)) continue;

      const bytes = detectFromRgba(pixels.data, pixels.width, pixels.height, params);
      if (!bytes) continue;

      let payload: string;
      try {
        payload = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        payload = "base64:" + btoa(String.fromCharCode(...Array.from(bytes)));
      }
      return { ok: true, payload, bytes, mode: candidate };
    }
    return { ok: false, error: "No Stegstr payload found in this image" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Read back what was just written, before telling the user it worked.
 *
 * Worth the extra decode: the alternative is handing someone an image they
 * believe carries a message and finding out only when the recipient sees
 * nothing.
 */
export async function stdmSelfTest(
  blob: Blob,
  originalPayload: Uint8Array,
  mode: ModeName = "locator",
): Promise<{ ok: boolean; error?: string }> {
  const result = await decodeStdmImageFile(blob, mode);
  if (!result.ok || !result.bytes) {
    return { ok: false, error: result.error ?? "payload did not read back" };
  }
  if (result.bytes.length !== originalPayload.length) {
    return {
      ok: false,
      error: `length mismatch: wrote ${originalPayload.length} bytes, read ${result.bytes.length}`,
    };
  }
  for (let i = 0; i < originalPayload.length; i++) {
    if (result.bytes[i] !== originalPayload[i]) {
      return { ok: false, error: `payload differs at byte ${i}` };
    }
  }
  return { ok: true };
}
