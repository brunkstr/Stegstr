/**
 * Browser-only platform: file picker, stego in JS, download. No Tauri, no network for stego.
 */

import { decodeImageFile, encodeImageFile } from "./stego-web";

export function isWeb(): boolean {
  return typeof window !== "undefined" && !(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

function createFileInput(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      document.body.removeChild(input);
      resolve(file);
    };
    input.oncancel = () => {
      document.body.removeChild(input);
      resolve(null);
    };
    document.body.appendChild(input);
    input.click();
  });
}

/** Pick one image file (for detect or cover). */
export function pickImageFile(): Promise<File | null> {
  return createFileInput("image/png,image/jpeg,image/gif,image/webp,image/bmp");
}

/** Decode stego payload from file. Same result shape as Tauri decode_stego_image. */
export async function decodeStegoFile(file: File): Promise<{ ok: boolean; payload?: string; error?: string }> {
  return decodeImageFile(file);
}

/** Payload is either raw JSON string or "base64:..." (UTF-8 bytes for base64). */
function payloadStringToBytes(payload: string): Uint8Array {
  if (payload.startsWith("base64:")) {
    const b64 = payload.slice(7).trim();
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(payload);
}

/** Encode cover image with payload; returns PNG blob. */
export async function encodeStegoToBlob(coverFile: File, payload: string): Promise<Blob> {
  const payloadBytes = payloadStringToBytes(payload);
  return encodeImageFile(coverFile, payloadBytes);
}

/** Trigger download of a blob with the given filename. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "stegstr-embed.png";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
