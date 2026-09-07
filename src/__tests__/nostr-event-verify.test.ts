import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";

// Polyfill crypto.subtle for Node.js test environment
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

describe("verifyEvent", () => {
  it("accepts a genuinely signed event", async () => {
    const { finishEventAsync, generateSecretKey, verifyEvent } = await import("../nostr-stub");
    const sk = generateSecretKey();
    const ev = await finishEventAsync({ kind: 1, content: "hello", tags: [], created_at: 1700000000 }, sk);
    expect(await verifyEvent(ev)).toBe(true);
  });

  it("rejects an event whose content was tampered with after signing", async () => {
    const { finishEventAsync, generateSecretKey, verifyEvent } = await import("../nostr-stub");
    const sk = generateSecretKey();
    const ev = await finishEventAsync({ kind: 1, content: "hello", tags: [], created_at: 1700000000 }, sk);
    const tampered = { ...ev, content: "attacker-controlled content" };
    expect(await verifyEvent(tampered)).toBe(false);
  });

  it("rejects an event with a forged id that doesn't match its content", async () => {
    const { finishEventAsync, generateSecretKey, verifyEvent } = await import("../nostr-stub");
    const sk = generateSecretKey();
    const ev = await finishEventAsync({ kind: 1, content: "hello", tags: [], created_at: 1700000000 }, sk);
    const tampered = { ...ev, id: "0".repeat(64) };
    expect(await verifyEvent(tampered)).toBe(false);
  });

  it("rejects an event with a garbage signature", async () => {
    const { finishEventAsync, generateSecretKey, verifyEvent } = await import("../nostr-stub");
    const sk = generateSecretKey();
    const ev = await finishEventAsync({ kind: 1, content: "hello", tags: [], created_at: 1700000000 }, sk);
    const tampered = { ...ev, sig: "ab".repeat(64) };
    expect(await verifyEvent(tampered)).toBe(false);
  });

  it("rejects an event claiming a pubkey it wasn't actually signed by (impersonation)", async () => {
    const { finishEventAsync, generateSecretKey, getPublicKey, verifyEvent } = await import("../nostr-stub");
    const attackerSk = generateSecretKey();
    const victimSk = generateSecretKey();
    const victimPubkey = getPublicKey(victimSk);
    // Attacker signs with their own key, then relabels the event as the victim's.
    const ev = await finishEventAsync({ kind: 1, content: "I never said this", tags: [], created_at: 1700000000 }, attackerSk);
    const impersonated = { ...ev, pubkey: victimPubkey };
    expect(await verifyEvent(impersonated)).toBe(false);
  });

  it("rejects malformed events without throwing", async () => {
    const { verifyEvent } = await import("../nostr-stub");
    expect(await verifyEvent({ id: "", pubkey: "", created_at: 0, kind: 1, tags: [], content: "", sig: "" })).toBe(false);
    expect(
      await verifyEvent({
        id: "not-hex",
        pubkey: "0".repeat(64),
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: "x",
        sig: "0".repeat(128),
      })
    ).toBe(false);
  });

  // Regression sweep for the focused attack requested against verifyEvent:
  // missing fields, wrong types, oversized values, null sig, non-hex
  // pubkey. Every one of these must resolve to `false`, never throw/reject
  // -- a relay is untrusted input, and a thrown exception here would
  // either crash the caller or (worse) get caught somewhere upstream in a
  // way that's never been audited for fail-safe behavior.
  describe("malformed-input attack sweep", () => {
    let verifyEvent: (ev: unknown) => Promise<boolean>;
    beforeAll(async () => {
      ({ verifyEvent } = await import("../nostr-stub"));
    });

    const valid = () => ({
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1700000000,
      kind: 1,
      tags: [] as string[][],
      content: "x",
      sig: "c".repeat(128),
    });

    const cases: Record<string, unknown> = {
      "null event": null,
      "undefined event": undefined,
      "string event": "not an object",
      "number event": 12345,
      "array event": [1, 2, 3],
      "empty object": {},
      "missing id": (() => { const e = valid() as Record<string, unknown>; delete e.id; return e; })(),
      "missing pubkey": (() => { const e = valid() as Record<string, unknown>; delete e.pubkey; return e; })(),
      "missing sig": (() => { const e = valid() as Record<string, unknown>; delete e.sig; return e; })(),
      "missing tags": (() => { const e = valid() as Record<string, unknown>; delete e.tags; return e; })(),
      "missing content": (() => { const e = valid() as Record<string, unknown>; delete e.content; return e; })(),
      "missing created_at": (() => { const e = valid() as Record<string, unknown>; delete e.created_at; return e; })(),
      "missing kind": (() => { const e = valid() as Record<string, unknown>; delete e.kind; return e; })(),
      "null sig": { ...valid(), sig: null },
      "null pubkey": { ...valid(), pubkey: null },
      "null id": { ...valid(), id: null },
      "sig as number": { ...valid(), sig: 12345 },
      "sig as array": { ...valid(), sig: ["c".repeat(128)] },
      "sig as object": { ...valid(), sig: { hex: "c".repeat(128) } },
      "pubkey as number": { ...valid(), pubkey: 999 },
      "pubkey non-hex (special chars)": { ...valid(), pubkey: "!".repeat(64) },
      "pubkey non-hex (unicode lookalikes)": { ...valid(), pubkey: "а".repeat(64) }, // Cyrillic а, not ASCII a
      "created_at as string": { ...valid(), created_at: "1700000000" },
      "kind as string": { ...valid(), kind: "1" },
      "tags as string": { ...valid(), tags: "not-an-array" },
      "tags as object": { ...valid(), tags: { 0: ["a"] } },
      "content as number": { ...valid(), content: 42 },
      "content as object": { ...valid(), content: { toString: () => "x" } },
      "oversized id (too long)": { ...valid(), id: "a".repeat(65) },
      "oversized id (way too long)": { ...valid(), id: "a".repeat(100000) },
      "oversized sig (too long)": { ...valid(), sig: "c".repeat(129) },
      "oversized sig (way too long)": { ...valid(), sig: "c".repeat(100000) },
      "undersized pubkey (too short)": { ...valid(), pubkey: "b".repeat(63) },
      "oversized content (huge string)": { ...valid(), content: "x".repeat(1_000_000) },
      "oversized tags (huge array)": { ...valid(), tags: Array.from({ length: 100000 }, () => ["e", "a".repeat(64)]) },
      "deeply nested tags": { ...valid(), tags: [["a", ["nested", ["deeper"]]] as unknown as string[]] },
      "kind as float": { ...valid(), kind: 1.5 },
      "kind as NaN": { ...valid(), kind: NaN },
      "created_at as NaN": { ...valid(), created_at: NaN },
      "created_at as Infinity": { ...valid(), created_at: Infinity },
      "id with uppercase hex (should still be well-formed, just wrong)": { ...valid(), id: "A".repeat(64) },
      "extra unexpected fields (prototype-pollution-shaped)": { ...valid(), __proto__: { polluted: true }, constructor: { polluted: true } },
    };

    for (const [name, input] of Object.entries(cases)) {
      it(`rejects cleanly: ${name}`, async () => {
        await expect(verifyEvent(input)).resolves.toBe(false);
      });
    }
  });
});
