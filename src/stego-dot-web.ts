/**
 * Dot-offset stego encode/decode for browser file workflow.
 */

import { encodeRGBAtoPNG } from "./png-encode";
import { decodePngToRGBA } from "./png-decode";
import { fileToImageData } from "./stego-web";
import { decodeDotFromRGBA, encodeDotIntoRGBA, getDotCapacityBytes } from "./stego-dot";

export async function encodeDotImageFile(
  coverFile: File,
  payload: Uint8Array
): Promise<Blob> {
  const { data, width, height } = await fileToImageData(coverFile);
  const result = encodeDotIntoRGBA(data.data, width, height, payload);
  const pngBytes = encodeRGBAtoPNG(result.data, result.width, result.height);
  return new Blob([pngBytes], { type: "image/png" });
}

export async function getDotCapacityForFile(coverFile: File): Promise<number> {
  const { width, height } = await fileToImageData(coverFile);
  return getDotCapacityBytes(width, height);
}

export async function decodeDotImageFile(file: File): Promise<{ ok: boolean; payload?: string; error?: string }> {
  try {
    let data: Uint8ClampedArray;
    let width: number;
    let height: number;
    const isPng = file.type === "image/png" || file.name.toLowerCase().endsWith(".png");
    if (isPng) {
      const buf = await file.arrayBuffer();
      const decoded = decodePngToRGBA(buf);
      data = decoded.data;
      width = decoded.width;
      height = decoded.height;
    } else {
      const imageData = await fileToImageData(file);
      data = imageData.data.data;
      width = imageData.width;
      height = imageData.height;
    }
    const payload = decodeDotFromRGBA(data, width, height);
    if (!payload || payload.length === 0) {
      return { ok: false, error: "Not a Stegstr image (magic not found)" };
    }
    const trimStart = (s: string) => s.replace(/^\s+/, "");
    const asUtf8 = new TextDecoder("utf-8", { fatal: false }).decode(payload);
    if (trimStart(asUtf8).startsWith("{")) {
      return { ok: true, payload: asUtf8 };
    }
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < payload.length; i += chunkSize) {
      const chunk = payload.subarray(i, Math.min(i + chunkSize, payload.length));
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return { ok: true, payload: "base64:" + btoa(binary) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
