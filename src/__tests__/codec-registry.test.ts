/**
 * The codec registry is the slot for new hiding methods. These tests pin the
 * decode order, the accept filter, fall-through on failure, and registration.
 */
import { describe, it, expect, vi } from "vitest";
import { listCodecs, getCodec, registerCodec, decodeAny } from "../codecs/registry";
import type { Codec } from "../codecs/types";

const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff])], "a.jpg", { type: "image/jpeg" });
const png = new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" });

describe("codec registry", () => {
  it("ships qim before dot, and only qim is JPEG-only", () => {
    const ids = listCodecs().map((c) => c.id);
    expect(ids.indexOf("qim")).toBeLessThan(ids.indexOf("dot"));
    expect(getCodec("qim")!.accepts(png)).toBe(false);
    expect(getCodec("qim")!.accepts(jpeg)).toBe(true);
    expect(getCodec("dot")!.accepts(png)).toBe(true);
  });

  it("decodeAny falls through to the next codec and reports every attempt", async () => {
    const a: Codec = { id: "fake-a", label: "A", description: "", container: "jpeg", accepts: () => true,
      decode: vi.fn(async () => ({ ok: false, error: "no magic" })), encode: async () => new Blob() };
    const b: Codec = { id: "fake-b", label: "B", description: "", container: "png", accepts: () => true,
      decode: vi.fn(async () => ({ ok: true, payload: "base64:AAAA" })), encode: async () => new Blob() };
    registerCodec(b, "dot");
    registerCodec(a, "fake-b");
    const seen: string[] = [];
    const r = await decodeAny(png, (l) => seen.push(l));
    expect(r.ok).toBe(true);
    expect(r.codecId).toBe("fake-b");
    expect(a.decode).toHaveBeenCalled();
    expect(seen.some((l) => l.includes("A decode failed: no magic"))).toBe(true);
    expect(seen.some((l) => l.includes("B decode OK"))).toBe(true);
  });

  it("a codec that throws is skipped, not fatal", async () => {
    const boom: Codec = { id: "boom", label: "Boom", description: "", container: "png", accepts: () => true,
      decode: async () => { throw new Error("kaboom"); }, encode: async () => new Blob() };
    registerCodec(boom, "fake-b");
    const r = await decodeAny(png);
    expect(r.ok).toBe(true);
    expect(r.codecId).toBe("fake-b");
    expect(r.attempts.some((l) => l.includes("Boom decode error: kaboom"))).toBe(true);
  });

  it("registering an existing id replaces it in place", () => {
    const n = listCodecs().length;
    registerCodec({ ...getCodec("boom")!, label: "Boom2" });
    expect(listCodecs().length).toBe(n);
    expect(getCodec("boom")!.label).toBe("Boom2");
  });
});
