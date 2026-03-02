import { describe, it, expect } from "vitest";
import { extractImageUrls, imageUrlFromTags, mediaUrlsFromTags, isVideoUrl, uint8ArrayToBase64, contentWithoutImages } from "../utils";

describe("extractImageUrls", () => {
  it("extracts jpg/png/gif URLs from content", () => {
    const content = "Check this out https://example.com/photo.jpg and https://example.com/pic.png end";
    const urls = extractImageUrls(content);
    expect(urls).toEqual(["https://example.com/photo.jpg", "https://example.com/pic.png"]);
  });

  it("extracts URLs with query params", () => {
    const content = "Photo https://cdn.example.com/img.webp?w=800&h=600";
    const urls = extractImageUrls(content);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("img.webp");
  });

  it("returns empty for non-image URLs", () => {
    const content = "Visit https://example.com and https://example.com/page.html";
    expect(extractImageUrls(content)).toEqual([]);
  });

  it("returns empty for empty content", () => {
    expect(extractImageUrls("")).toEqual([]);
  });
});

describe("imageUrlFromTags", () => {
  it("finds url tag", () => {
    const tags = [["e", "abc"], ["url", "https://img.com/a.png"]];
    expect(imageUrlFromTags(tags)).toBe("https://img.com/a.png");
  });

  it("finds im tag (NIP-94)", () => {
    const tags = [["im", "https://img.com/b.jpg"]];
    expect(imageUrlFromTags(tags)).toBe("https://img.com/b.jpg");
  });

  it("returns null when no image tags", () => {
    const tags = [["e", "abc"], ["p", "def"]];
    expect(imageUrlFromTags(tags)).toBeNull();
  });
});

describe("mediaUrlsFromTags", () => {
  it("collects all url and im tags", () => {
    const tags = [["url", "https://a.jpg"], ["im", "https://b.png"], ["p", "xyz"]];
    expect(mediaUrlsFromTags(tags)).toEqual(["https://a.jpg", "https://b.png"]);
  });
});

describe("isVideoUrl", () => {
  it("detects video extensions", () => {
    expect(isVideoUrl("https://example.com/video.mp4")).toBe(true);
    expect(isVideoUrl("https://example.com/clip.webm")).toBe(true);
    expect(isVideoUrl("https://example.com/file.mov")).toBe(true);
  });

  it("detects video paths", () => {
    expect(isVideoUrl("https://example.com/v/abc123")).toBe(true);
    expect(isVideoUrl("https://example.com/video/stream")).toBe(true);
  });

  it("returns false for non-video", () => {
    expect(isVideoUrl("https://example.com/photo.jpg")).toBe(false);
    expect(isVideoUrl("https://example.com/page")).toBe(false);
  });
});

describe("uint8ArrayToBase64", () => {
  it("round-trips through atob", () => {
    const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const b64 = uint8ArrayToBase64(data);
    expect(b64).toBe(btoa("Hello"));
    expect(atob(b64)).toBe("Hello");
  });

  it("handles empty array", () => {
    expect(uint8ArrayToBase64(new Uint8Array([]))).toBe("");
  });

  it("handles large arrays without stack overflow", () => {
    const large = new Uint8Array(100000).fill(65);
    const b64 = uint8ArrayToBase64(large);
    expect(b64.length).toBeGreaterThan(0);
  });
});

describe("contentWithoutImages", () => {
  it("strips image URLs and preserves text", () => {
    const content = "Hello https://img.com/photo.jpg world";
    expect(contentWithoutImages(content)).toBe("Hello world");
  });

  it("preserves non-image URLs", () => {
    const content = "Visit https://example.com for more";
    expect(contentWithoutImages(content)).toBe("Visit https://example.com for more");
  });

  it("handles multiple image URLs", () => {
    const content = "A https://a.com/1.png B https://b.com/2.gif C";
    const result = contentWithoutImages(content);
    expect(result).toBe("A B C");
  });
});
