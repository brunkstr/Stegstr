import { describe, it, expect } from "vitest";
import { listCodecs, getCodec } from "../codecs/registry";
import { MODES, payloadBytes } from "../stego-stdm-web";

describe("robust (STDM) codec registration", () => {
  it("is first in decode order, JPEG-only, and exposes the three payload modes", () => {
    const ids = listCodecs().map((c) => c.id);
    expect(ids[0]).toBe("robust");
    expect(ids.indexOf("robust")).toBeLessThan(ids.indexOf("qim"));
    const c = getCodec("robust")!;
    expect(c.accepts(new File([""], "a.png", { type: "image/png" }))).toBe(false);
    expect(c.accepts(new File([""], "a.jpg", { type: "image/jpeg" }))).toBe(true);
    expect(Object.keys(MODES)).toEqual(expect.arrayContaining(["locator", "standard", "bulk"]));
    expect(payloadBytes(MODES.locator)).toBeLessThan(payloadBytes(MODES.standard));
    expect(payloadBytes(MODES.standard)).toBeLessThan(payloadBytes(MODES.bulk));
  });
});
