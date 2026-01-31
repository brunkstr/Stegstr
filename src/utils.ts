/** Extract image URLs from note content (plain URLs) and NIP-08 style url tags if we had them */
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp)(\?|$)/i;
const URL_REGEX = /https?:\/\/[^\s<>"']+/g;

export function extractImageUrls(content: string): string[] {
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;
  while ((m = URL_REGEX.exec(content)) !== null) {
    const url = m[0];
    if (IMAGE_EXT.test(url)) urls.push(url);
  }
  return urls;
}

/** Get first image URL from note tags (NIP-08: url tag for images) */
export function imageUrlFromTags(tags: string[][]): string | null {
  for (const t of tags) {
    if (t[0] === "url" && t[1]) return t[1];
    if (t[0] === "im" && t[1]) return t[1]; // NIP-94 image
  }
  return null;
}

const VIDEO_EXT = /\.(mp4|webm|mov|ogv)(\?|$)/i;

/** Get all media URLs from note tags (im, url) for display */
export function mediaUrlsFromTags(tags: string[][]): string[] {
  const urls: string[] = [];
  for (const t of tags) {
    if ((t[0] === "url" || t[0] === "im") && t[1]) urls.push(t[1]);
  }
  return urls;
}

/** Check if URL is video (by extension or path) */
export function isVideoUrl(url: string): boolean {
  return VIDEO_EXT.test(url) || /\/v\//.test(url) || /video\//.test(url);
}

/** Base64-encode Uint8Array without hitting call stack limit (String.fromCharCode spread) */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

/** Content with image URLs stripped so we can show text + images separately */
export function contentWithoutImages(content: string): string {
  const t = content.replace(URL_REGEX, (url) => (IMAGE_EXT.test(url) ? " " : url)).replace(/\s{2,}/g, " ").trim();
  return t;
}
