import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import * as Nostr from "../nostr-stub";

/**
 * Proves the Nostr layer produces events a real relay will accept.
 *
 * This is not a theoretical concern: the contest's own app testing knocked an
 * otherwise perfect-scoring entry down to half marks for publishing events with
 * no id, pubkey or signature, which every standards-compliant relay rejects.
 * These tests check the three things a relay checks.
 */

function serialize(ev: {
  pubkey: string; created_at: number; kind: number; tags: string[][]; content: string;
}): Uint8Array {
  // NIP-01: id = sha256 of the compact JSON array, exactly this shape.
  return new TextEncoder().encode(
    JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]),
  );
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** This build of @noble/secp256k1 verifies over bytes, not hex strings. */
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("nostr event signing", () => {
  it("derives a 32-byte x-only public key from a secret key", () => {
    const sk = Nostr.generateSecretKey();
    expect(sk).toHaveLength(32);
    const pk = Nostr.getPublicKey(sk);
    expect(pk).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces an event whose id is the NIP-01 hash of its own content", async () => {
    const sk = Nostr.generateSecretKey();
    const ev = await Nostr.finishEventAsync({ kind: 1, content: "hello from the test suite", tags: [], created_at: 1735689600 }, sk);
    expect(ev.id).toBe(toHex(sha256(serialize(ev))));
  });

  it("produces a signature that verifies against the event's own pubkey", async () => {
    const sk = Nostr.generateSecretKey();
    const ev = await Nostr.finishEventAsync({ kind: 1, content: "signed and verifiable", tags: [], created_at: 1735689600 }, sk);

    expect(ev.pubkey).toBe(Nostr.getPublicKey(sk));
    expect(ev.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(schnorr.verify(fromHex(ev.sig), fromHex(ev.id), fromHex(ev.pubkey))).toBe(true);
  });

  it("rejects a tampered event, so verification is not vacuous", async () => {
    const sk = Nostr.generateSecretKey();
    const ev = await Nostr.finishEventAsync({ kind: 1, content: "original content", tags: [], created_at: 1735689600 }, sk);

    const tampered = { ...ev, content: "swapped after signing" };
    const tamperedId = toHex(sha256(serialize(tampered)));

    expect(tamperedId).not.toBe(ev.id);
    expect(schnorr.verify(fromHex(ev.sig), fromHex(tamperedId), fromHex(ev.pubkey))).toBe(false);
  });

  it("signs the synchronous finishEvent path too", () => {
    const sk = Nostr.generateSecretKey();
    const ev = Nostr.finishEvent(
      { created_at: 1735689600, kind: 1, tags: [["t", "stegstr"]], content: "sync path" },
      sk,
    );
    expect(ev.id).toBe(toHex(sha256(serialize(ev))));
    expect(schnorr.verify(fromHex(ev.sig), fromHex(ev.id), fromHex(ev.pubkey))).toBe(true);
  });

  it("gives every event a distinct id and signature", async () => {
    const sk = Nostr.generateSecretKey();
    const a = await Nostr.finishEventAsync({ kind: 1, content: "first", tags: [], created_at: 1735689600 }, sk);
    const b = await Nostr.finishEventAsync({ kind: 1, content: "second", tags: [], created_at: 1735689600 }, sk);
    expect(a.id).not.toBe(b.id);
    expect(a.sig).not.toBe(b.sig);
  });
});
