import { describe, expect, it } from "vitest";
import { bech32 } from "bech32";
import { decodeInvoice, formatSats, invoiceExpired, looksLikeInvoice } from "../wallet/bolt11";
import { decodeCbor, encodeCbor } from "../wallet/cbor";
import { decodeToken, hashToCurve, looksLikeCashuToken, p2pkLockPubkey } from "../wallet/cashu";
import { attachmentTags, contentWithoutPayments, paymentAttachmentsFromEvent } from "../wallet/attachments";
import { parseNwcUrl } from "../wallet/nwc";

// --- helpers: a tiny BOLT11 encoder so the decoder is tested against structurally valid invoices
function bytesToWords(bytes: Uint8Array): number[] { return bech32.toWords(bytes); }
function numToWords(n: number, len: number): number[] { const w: number[] = []; for (let i = 0; i < len; i++) { w.unshift(n % 32); n = Math.floor(n / 32); } return w; }
function tagged(type: number, words: number[]): number[] { return [type, Math.floor(words.length / 32), words.length % 32, ...words]; }
function fakeInvoice(opts: { hrpAmount?: string; description?: string; expiry?: number; timestamp?: number; net?: string }): string {
  const ts = opts.timestamp ?? 1_700_000_000;
  const words = [...numToWords(ts, 7)];
  words.push(...tagged(1, bytesToWords(new Uint8Array(32).fill(0xab)).slice(0, 52)));
  if (opts.description !== undefined) words.push(...tagged(13, bytesToWords(new TextEncoder().encode(opts.description))));
  if (opts.expiry !== undefined) words.push(...tagged(6, numToWords(opts.expiry, 2)));
  words.push(...new Array(104).fill(1)); // signature placeholder (65 bytes -> 104 words)
  return bech32.encode("ln" + (opts.net ?? "bc") + (opts.hrpAmount ?? ""), words, 7000);
}

describe("bolt11", () => {
  it("decodes amount, description, expiry and timestamp", () => {
    const inv = fakeInvoice({ hrpAmount: "210n", description: "coffee", expiry: 600 });
    expect(looksLikeInvoice(inv)).toBe(true);
    const d = decodeInvoice("lightning:" + inv.toUpperCase());
    expect(d.amountSat).toBe(21); expect(d.amountMsat).toBe(21_000);
    expect(d.description).toBe("coffee"); expect(d.expiry).toBe(600); expect(d.timestamp).toBe(1_700_000_000);
    expect(d.network).toBe("bitcoin"); expect(d.paymentHash).toBe("ab".repeat(32));
    expect(invoiceExpired(d, 1_700_000_000 + 599)).toBe(false);
    expect(invoiceExpired(d, 1_700_000_000 + 601)).toBe(true);
  });
  it("handles any-amount, milli and whole-bitcoin prefixes and testnet", () => {
    expect(decodeInvoice(fakeInvoice({})).amountSat).toBeNull();
    expect(decodeInvoice(fakeInvoice({ hrpAmount: "20m" })).amountSat).toBe(2_000_000);
    expect(decodeInvoice(fakeInvoice({ hrpAmount: "1" })).amountSat).toBe(100_000_000);
    expect(decodeInvoice(fakeInvoice({ hrpAmount: "2500u" })).amountSat).toBe(250_000);
    expect(decodeInvoice(fakeInvoice({ net: "tb" })).network).toBe("testnet");
    expect(decodeInvoice(fakeInvoice({})).expiry).toBe(3600);
  });
  it("rejects garbage", () => {
    expect(() => decodeInvoice("lnbc1notaninvoice")).toThrow();
    expect(looksLikeInvoice("hello")).toBe(false);
    expect(formatSats(1)).toBe("1 sat"); expect(formatSats(null)).toBe("any amount");
  });
});

describe("cbor", () => {
  it("round-trips the shapes a Cashu V4 token uses", () => {
    const v = { m: "https://mint.example", u: "sat", t: [{ i: new Uint8Array([0, 254, 22, 55]), p: [{ a: 8, s: "secret", c: new Uint8Array(33).fill(2), w: "x" }] }], n: -5, f: 1.5, b: true, z: null };
    const back = decodeCbor(encodeCbor(v)) as typeof v;
    expect(back.m).toBe(v.m); expect(back.t[0].p[0].a).toBe(8); expect(Array.from(back.t[0].i)).toEqual([0, 254, 22, 55]);
    expect(back.n).toBe(-5); expect(back.f).toBe(1.5); expect(back.b).toBe(true); expect(back.z).toBeNull();
  });
  it("rejects truncated input", () => {
    expect(() => decodeCbor(new Uint8Array([0x82, 0x01]))).toThrow();
  });
});

describe("cashu tokens", () => {
  const proof = { id: "00fe16371ff3f827", amount: 8, secret: "407915bc212be61a77e3e6d2aeb4c727980bda51cd06a6afc29e2861768a7837", C: "02bc9097997d81afb2cc7346b5e4345a9346bd2a506eb7958598a72f0cf85163ea" };
  it("decodes a V3 (JSON) token", () => {
    const raw = "cashuA" + btoa(JSON.stringify({ token: [{ mint: "https://mint.example/", proofs: [proof, { ...proof, amount: 2 }] }], unit: "sat", memo: "hi" }));
    expect(looksLikeCashuToken("cashu:" + raw)).toBe(true);
    const t = decodeToken("cashu:" + raw);
    expect(t.version).toBe("V3"); expect(t.mint).toBe("https://mint.example"); expect(t.amount).toBe(10); expect(t.memo).toBe("hi"); expect(t.proofs).toHaveLength(2);
  });
  it("decodes a V4 (CBOR) token", () => {
    const cbor = encodeCbor({ m: "https://mint.example", u: "sat", d: "treasure", t: [{ i: new Uint8Array([0x00, 0xfe, 0x16, 0x37, 0x1f, 0xf3, 0xf8, 0x27]), p: [{ a: 16, s: proof.secret, c: Uint8Array.from(Buffer.from(proof.C, "hex")) }] }] });
    const raw = "cashuB" + Buffer.from(cbor).toString("base64url");
    const t = decodeToken(raw);
    expect(t.version).toBe("V4"); expect(t.amount).toBe(16); expect(t.memo).toBe("treasure"); expect(t.proofs[0].id).toBe("00fe16371ff3f827"); expect(t.proofs[0].C).toBe(proof.C);
  });
  it("rejects malformed tokens", () => {
    expect(() => decodeToken("cashuA" + btoa(JSON.stringify({ token: [] })))).toThrow();
    expect(() => decodeToken("cashuA" + btoa(JSON.stringify({ token: [{ mint: "https://m", proofs: [{ ...proof, C: "zz" }] }] })))).toThrow();
    expect(() => decodeToken("cashuC123")).toThrow();
  });
  it("hash_to_curve matches the NUT-00 test vectors", () => {
    const h = (hex: string) => hashToCurve(Uint8Array.from(Buffer.from(hex, "hex")));
    expect(h("00".repeat(32))).toBe("024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725");
    expect(h("00".repeat(31) + "01")).toBe("022e7158e11c9506f1aa4248bf531298daa7febd6194f003edcd9b93ade6253acf");
    expect(h("00".repeat(31) + "02")).toBe("026cdbe15362df59cd1dd3c9c11de8aedac2106eca69236ecd9fbe117af897be4f");
  });
  it("recognises P2PK locks", () => {
    expect(p2pkLockPubkey(proof)).toBeNull();
    const locked = { ...proof, secret: JSON.stringify(["P2PK", { nonce: "abc", data: "02" + "11".repeat(32) }]) };
    expect(p2pkLockPubkey(locked)).toBe("02" + "11".repeat(32));
  });
});

describe("payment attachments", () => {
  const inv = fakeInvoice({ hrpAmount: "1u", description: "x" });
  const tok = "cashuA" + btoa(JSON.stringify({ token: [{ mint: "https://m.example", proofs: [] }] }));
  it("reads tags and inline strings without duplicates", () => {
    const list = paymentAttachmentsFromEvent({ tags: [["bolt11", inv], ["cashu", tok], ["e", "x"]], content: `pay me ${inv} and take ${tok}.` });
    expect(list).toEqual([{ type: "bolt11", value: inv }, { type: "cashu", value: tok }]);
    expect(attachmentTags(list)).toEqual([["bolt11", inv], ["cashu", tok]]);
    expect(contentWithoutPayments(`pay me ${inv} and take ${tok}.`)).toBe("pay me  and take");
  });
  it("ignores things that only look close", () => {
    expect(paymentAttachmentsFromEvent({ tags: [["bolt11", "lnbc1short"]], content: "cashuAnope" })).toEqual([]);
  });
});

describe("nwc url", () => {
  it("parses a connection string", () => {
    const c = parseNwcUrl("nostr+walletconnect://" + "ab".repeat(32) + "?relay=wss%3A%2F%2Frelay.example.com&secret=" + "CD".repeat(32) + "&lud16=me%40example.com");
    expect(c.walletPubkey).toBe("ab".repeat(32)); expect(c.relay).toBe("wss://relay.example.com"); expect(c.secret).toBe("cd".repeat(32)); expect(c.lud16).toBe("me@example.com");
  });
  it("rejects bad strings", () => {
    expect(() => parseNwcUrl("nostr+walletconnect://xyz?relay=wss://r&secret=1")).toThrow();
    expect(() => parseNwcUrl("nostr+walletconnect://" + "ab".repeat(32) + "?secret=" + "cd".repeat(32))).toThrow();
  });
});
