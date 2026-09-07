/**
 * Upload media to nostr.build and return its public URL.
 *
 * Ported from contest entry #79 (Shweta Dinkar, github.com/shwetadinkar/Stegstr, MIT)
 * as step 6 of the merge plan: nostr.build requires NIP-98 signed uploads; the
 * upstream anonymous POST has returned 401 for every file since mid-2026.
 *
 * WHY THIS NEEDED FIXING. The previous version sent a bare POST with no
 * authentication, and nostr.build now requires NIP-98. Every upload was
 * rejected with "Unauthorized, please provide a valid nip-98 token" -- for
 * every file type -- so Attach had been broken outright, and the UI reported
 * it as "Select image or video files", which pointed at the wrong thing
 * entirely.
 *
 * WHAT THIS COSTS THE USER, which the UI must state rather than bury: the file
 * is uploaded **unencrypted** to a third-party host and is publicly readable by
 * anyone with the URL. That is a weaker guarantee than the rest of this app --
 * pointer-mode content is encrypted before it reaches a relay, so an operator
 * sees ciphertext. An attachment is the plain file.
 *
 * The upside is real though: only the URL travels in the image, so a 4 KB
 * cover can reference a video of any size.
 */

import * as Nostr from "./nostr-stub";

const NOSTR_BUILD_UPLOAD_URL = "https://nostr.build/api/v2/upload/files";

/** What the host actually accepts. Documents are rejected server-side. */
export const UPLOAD_ACCEPT = "image/*,video/*";

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

/**
 * NIP-98 HTTP Auth: a signed kind-27235 event, base64'd into the
 * Authorization header, naming the exact URL and method it authorises.
 */
export async function nip98Token(privKeyHex: string, url: string, method: string): Promise<string> {
  const ev = await Nostr.finishEventAsync(
    {
      kind: 27235,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags: [["u", url], ["method", method]],
    },
    Nostr.hexToBytes(privKeyHex),
  );
  const json = JSON.stringify(ev);
  // btoa is byte-oriented; encode first so non-ASCII content cannot break it.
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** True if this file is a type the host will accept. */
export function isUploadableMedia(file: File): boolean {
  if (file.type) return file.type.startsWith("image/") || file.type.startsWith("video/");
  // Some systems hand back an empty MIME type; fall back to the extension
  // rather than silently dropping a perfectly good file, which is what the
  // previous version did.
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif",
          "mp4", "mov", "webm", "m4v", "avi", "mkv"].includes(ext);
}

export async function uploadMedia(file: File, privKeyHex: string): Promise<string> {
  if (!privKeyHex) {
    throw new UploadError("Uploading needs an identity to sign the request. Log in first.");
  }
  if (!isUploadableMedia(file)) {
    throw new UploadError(
      `${file.name} is not an image or video. nostr.build hosts media only — ` +
      `documents and archives are rejected by the server.`,
    );
  }

  const formData = new FormData();
  formData.append("file", file);

  let res: Response;
  try {
    res = await fetch(NOSTR_BUILD_UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Nostr ${await nip98Token(privKeyHex, NOSTR_BUILD_UPLOAD_URL, "POST")}` },
      body: formData,
    });
  } catch (e) {
    throw new UploadError(
      `Could not reach nostr.build: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UploadError(`Upload failed: ${res.status} ${res.statusText} ${text.slice(0, 120)}`);
  }

  const url = extractUrl(data);
  if (url) return url;

  const message = (data as { message?: string })?.message;
  throw new UploadError(
    message
      ? `nostr.build refused the upload: ${message}`
      : `Upload failed: ${res.status} ${res.statusText}`,
  );
}

/** The host has returned several response shapes over time; accept them all. */
function extractUrl(data: unknown): string | null {
  if (Array.isArray(data)) {
    const first = data[0] as { url?: string } | string | undefined;
    if (typeof first === "string") return first;
    if (first?.url) return first.url;
  }
  const d = data as { url?: string; data?: { url?: string } | Array<{ url?: string }> };
  if (Array.isArray(d?.data) && d.data[0]?.url) return d.data[0].url!;
  if (d?.data && !Array.isArray(d.data) && d.data.url) return d.data.url;
  if (d?.url) return d.url;
  return null;
}
