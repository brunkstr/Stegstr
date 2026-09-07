import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  REF_STORAGE_KEY,
  REF_TTL_DAYS,
  captureReferralFromUrl,
  getActiveReferralCode,
  normalizeReferralCode,
  referralCodeFromTags,
  setReferralCode,
  withReferralTag,
} from "../app/referral";

const DAY = 24 * 60 * 60 * 1000;

// The vitest environment is plain Node, which has no usable localStorage
// (Node 22+ defines the global but leaves it undefined without a backing file).
// Same tiny in-memory shim the browser semantics need: string keys and values.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  } as Storage;
}

describe("referral codes", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "localStorage", { value: memoryStorage(), configurable: true, writable: true });
  });
  beforeEach(() => localStorage.clear());

  it("normalizes bare codes, URLs and noise", () => {
    expect(normalizeReferralCode("k7m2qx")).toBe("K7M2QX");
    expect(normalizeReferralCode("  https://stegstr.com/r/K7M2QX?x=1 ")).toBe("K7M2QX");
    expect(normalizeReferralCode("stegstr.com/r/k7m2qx/")).toBe("K7M2QX");
    expect(normalizeReferralCode("K7M-2QX")).toBe("K7M2QX");
  });

  it("rejects ambiguous or malformed codes", () => {
    expect(normalizeReferralCode("")).toBeNull();
    expect(normalizeReferralCode("ABC")).toBeNull();
    expect(normalizeReferralCode("ABCDEFGHI")).toBeNull();
    expect(normalizeReferralCode("K0M2QX")).toBeNull(); // zero
    expect(normalizeReferralCode("K1M2QX")).toBeNull(); // one
    expect(normalizeReferralCode("KOM2QX")).toBeNull(); // letter O
    expect(normalizeReferralCode("<script>")).toBeNull();
  });

  it("stores, reads back and clears", () => {
    expect(setReferralCode("k7m2qx")).toBe("K7M2QX");
    expect(getActiveReferralCode()).toBe("K7M2QX");
    expect(setReferralCode(null)).toBeNull();
    expect(getActiveReferralCode()).toBeNull();
    expect(localStorage.getItem(REF_STORAGE_KEY)).toBeNull();
  });

  it("expires after the TTL", () => {
    const t0 = 1_800_000_000_000;
    setReferralCode("K7M2QX", t0);
    expect(getActiveReferralCode(t0 + (REF_TTL_DAYS - 1) * DAY)).toBe("K7M2QX");
    expect(getActiveReferralCode(t0 + (REF_TTL_DAYS + 1) * DAY)).toBeNull();
  });

  it("adds exactly one r tag while active and none when not", () => {
    expect(withReferralTag([["e", "abc"]])).toEqual([["e", "abc"]]);
    setReferralCode("K7M2QX");
    const tagged = withReferralTag([["e", "abc"]]);
    expect(tagged).toEqual([["e", "abc"], ["r", "https://stegstr.com/r/K7M2QX"]]);
    expect(withReferralTag(tagged)).toEqual(tagged);
    expect(referralCodeFromTags(tagged)).toBe("K7M2QX");
    expect(referralCodeFromTags([["r", "https://example.com/r/K7M2QX"]])).toBeNull();
  });

  it("captures ?ref= from the URL but never overrides an active code", () => {
    expect(captureReferralFromUrl("?ref=k7m2qx")).toBe("K7M2QX");
    expect(captureReferralFromUrl("?ref=ZZZZ99")).toBe("K7M2QX");
    expect(getActiveReferralCode()).toBe("K7M2QX");
    expect(captureReferralFromUrl("?foo=1")).toBe(null);
    localStorage.clear();
    expect(captureReferralFromUrl("?ref=0OIL")).toBeNull();
    expect(getActiveReferralCode()).toBeNull();
  });

  it("ignores corrupt storage", () => {
    localStorage.setItem(REF_STORAGE_KEY, "{not json");
    expect(getActiveReferralCode()).toBeNull();
    localStorage.setItem(REF_STORAGE_KEY, JSON.stringify({ code: "K7M2QX" }));
    expect(getActiveReferralCode()).toBeNull();
  });
});
