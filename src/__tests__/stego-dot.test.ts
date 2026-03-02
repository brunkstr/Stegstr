import { describe, it, expect } from "vitest";
import { encodeDotIntoRGBA, decodeDotFromRGBA, getDotCapacityBytes } from "../stego-dot";

function makeWhiteImage(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;     // R
    data[i + 1] = 255; // G
    data[i + 2] = 255; // B
    data[i + 3] = 255; // A
  }
  return data;
}

describe("stego-dot encode/decode round-trip", () => {
  it("encodes and decodes a short payload on 256x256", () => {
    const w = 256;
    const h = 256;
    const img = makeWhiteImage(w, h);
    const payload = new TextEncoder().encode("Hello Stegstr!");

    const encoded = encodeDotIntoRGBA(img, w, h, payload);
    expect(encoded.width).toBe(w);
    expect(encoded.height).toBe(h);

    const decoded = decodeDotFromRGBA(encoded.data, w, h);
    expect(decoded).not.toBeNull();
    expect(new TextDecoder().decode(decoded!)).toBe("Hello Stegstr!");
  });

  it("encodes and decodes on 512x512", () => {
    const w = 512;
    const h = 512;
    const img = makeWhiteImage(w, h);
    const payload = new TextEncoder().encode("Test payload for 512x512 image");

    const encoded = encodeDotIntoRGBA(img, w, h, payload);
    const decoded = decodeDotFromRGBA(encoded.data, w, h);
    expect(decoded).not.toBeNull();
    expect(new TextDecoder().decode(decoded!)).toBe("Test payload for 512x512 image");
  });

  it("handles binary payload", () => {
    const w = 256;
    const h = 256;
    const img = makeWhiteImage(w, h);
    const payload = new Uint8Array([0, 1, 2, 255, 128, 64]);

    const encoded = encodeDotIntoRGBA(img, w, h, payload);
    const decoded = decodeDotFromRGBA(encoded.data, w, h);
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!)).toEqual([0, 1, 2, 255, 128, 64]);
  });

  it("throws on payload too large for image", () => {
    const w = 32;
    const h = 32;
    const img = makeWhiteImage(w, h);
    const largePayload = new Uint8Array(1000);
    expect(() => encodeDotIntoRGBA(img, w, h, largePayload)).toThrow("too large");
  });

  it("returns null for image with no embedded data", () => {
    const w = 256;
    const h = 256;
    const img = makeWhiteImage(w, h);
    const decoded = decodeDotFromRGBA(img, w, h);
    expect(decoded).toBeNull();
  });
});

describe("getDotCapacityBytes", () => {
  it("returns positive capacity for reasonable image sizes", () => {
    expect(getDotCapacityBytes(256, 256)).toBeGreaterThan(0);
    expect(getDotCapacityBytes(1024, 768)).toBeGreaterThan(0);
  });

  it("returns 0 for tiny images", () => {
    expect(getDotCapacityBytes(4, 4)).toBe(0);
  });

  it("larger images have more capacity", () => {
    const small = getDotCapacityBytes(256, 256);
    const large = getDotCapacityBytes(1024, 1024);
    expect(large).toBeGreaterThan(small);
  });
});
