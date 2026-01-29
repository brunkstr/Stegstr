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

/** Content with image URLs stripped so we can show text + images separately */
export function contentWithoutImages(content: string): string {
  const t = content.replace(URL_REGEX, (url) => (IMAGE_EXT.test(url) ? " " : url)).replace(/\s{2,}/g, " ").trim();
  return t;
}
