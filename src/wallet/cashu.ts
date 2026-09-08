/**
 * Cashu ecash tokens (https://cashubtc.github.io/nuts/): decode V3/V4 tokens,
 * check whether they are spent, and redeem them to the user's Lightning wallet
 * by asking the mint to pay an invoice ("melt").
 *
 * Deliberately NOT a full wallet: creating tokens needs a wallet (cashu.me,
 * Minibits, eNuts). Redeeming needs only the connected Lightning wallet: the
 * mint pays an invoice we mint through NWC. The mint keeps whatever is left of
 * its fee reserve (usually a sat or two) because we do not ask for change,
 * which would require storing new proofs, i.e. a wallet.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import * as secp from "@noble/secp256k1";
import { decodeCbor } from "./cbor";
import { bytesToHex, hexToBytes } from "../nostr-stub";

export interface CashuProof { id: string; amount: number; secret: string; C: string; witness?: string }
export interface CashuToken {
  mint: string;
  unit: string;
  memo: string | null;
  proofs: CashuProof[];
  /** Sum of proof amounts in the token's unit. */
  amount: number;
  raw: string;
  version: "V3" | "V4";
}

const HASH_DOMAIN = new TextEncoder().encode("Secp256k1_HashToCurve_Cashu_");

export function looksLikeCashuToken(s: string): boolean {
  return /^(cashu:)?cashu[AB][A-Za-z0-9_+/=-]{20,}$/.test(s.trim());
}

function b64decode(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}

export function decodeToken(input: string): CashuToken {
  const raw = input.trim().replace(/^cashu:/i, "");
  if (!raw.startsWith("cashu")) throw new Error("not a Cashu token");
  const version = raw[5];
  const body = raw.slice(6);
  if (version === "A") {
    const j = JSON.parse(new TextDecoder().decode(b64decode(body))) as { token: Array<{ mint: string; proofs: CashuProof[] }>; unit?: string; memo?: string };
    if (!Array.isArray(j.token) || !j.token.length) throw new Error("empty token");
    const mint = j.token[0].mint;
    const proofs = j.token.flatMap((t) => t.proofs.map((p) => ({ id: p.id, amount: p.amount, secret: p.secret, C: p.C })));
    return finish({ mint, unit: j.unit ?? "sat", memo: j.memo ?? null, proofs, raw, version: "V3" });
  }
  if (version === "B") {
    const d = decodeCbor(b64decode(body)) as { m: string; u?: string; d?: string; t: Array<{ i: Uint8Array; p: Array<{ a: number; s: string; c: Uint8Array; w?: string }> }> };
    const proofs = d.t.flatMap((k) => k.p.map((p) => ({ id: bytesToHex(k.i), amount: p.a, secret: p.s, C: bytesToHex(p.c), witness: p.w })));
    return finish({ mint: d.m, unit: d.u ?? "sat", memo: d.d ?? null, proofs, raw, version: "V4" });
  }
  throw new Error("unsupported Cashu token version");
}

function finish(t: Omit<CashuToken, "amount">): CashuToken {
  if (!/^https?:\/\//.test(t.mint)) throw new Error("token has no mint URL");
  for (const p of t.proofs) {
    if (!Number.isInteger(p.amount) || p.amount <= 0 || typeof p.secret !== "string" || !/^[0-9a-f]{66}$/i.test(p.C)) throw new Error("malformed proof");
  }
  return { ...t, mint: t.mint.replace(/\/+$/, ""), amount: t.proofs.reduce((s, p) => s + p.amount, 0) };
}

/** NUT-00 hash_to_curve: deterministic secp256k1 point for a secret; its x-coordinate is the "Y" mints index spent proofs by. */
export function hashToCurve(message: Uint8Array): string {
  const msgHash = sha256(concat(HASH_DOMAIN, message));
  const counter = new Uint8Array(4);
  for (let i = 0; i < 2 ** 16; i++) {
    counter[0] = i & 0xff; counter[1] = (i >> 8) & 0xff; counter[2] = (i >> 16) & 0xff; counter[3] = (i >> 24) & 0xff;
    const x = sha256(concat(msgHash, counter));
    try {
      const p = secp.Point.fromHex("02" + bytesToHex(x));
      p.assertValidity();
      return "02" + bytesToHex(x);
    } catch { /* not on the curve, try the next counter */ }
  }
  throw new Error("hash_to_curve: no point found");
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }

export function proofY(p: CashuProof): string { return hashToCurve(new TextEncoder().encode(p.secret)); }

export type ProofState = "UNSPENT" | "SPENT" | "PENDING";

/** NUT-07: ask the mint which proofs are still spendable. */
export async function checkTokenState(token: CashuToken, fetchFn: typeof fetch = fetch): Promise<{ states: ProofState[]; spendable: number; spent: number }> {
  const Ys = token.proofs.map(proofY);
  const r = await fetchFn(token.mint + "/v1/checkstate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ Ys }) });
  if (!r.ok) throw new Error(`mint refused checkstate (${r.status})`);
  const j = (await r.json()) as { states: Array<{ Y: string; state: ProofState }> };
  const byY = new Map(j.states.map((s) => [s.Y, s.state]));
  const states = Ys.map((y) => byY.get(y) ?? "UNSPENT");
  let spendable = 0, spent = 0;
  token.proofs.forEach((p, i) => { if (states[i] === "UNSPENT") spendable += p.amount; else spent += p.amount; });
  return { states, spendable, spent };
}

/** If a proof's secret is a NUT-11 P2PK lock, returns the 33-byte hex pubkey it is locked to. */
export function p2pkLockPubkey(p: CashuProof): string | null {
  try {
    const s = JSON.parse(p.secret) as [string, { data?: string }];
    if (Array.isArray(s) && s[0] === "P2PK" && typeof s[1]?.data === "string") return s[1].data.toLowerCase();
  } catch { /* plain secret */ }
  return null;
}

/** Sign locked proofs with our Nostr key (NUT-11 witness: Schnorr over SHA256(secret)). */
export async function witnessProofs(proofs: CashuProof[], privKeyHex: string): Promise<CashuProof[]> {
  const sk = hexToBytes(privKeyHex);
  const ourPub = "02" + bytesToHex(secp.getPublicKey(sk, true).slice(1));
  return Promise.all(proofs.map(async (p) => {
    const lock = p2pkLockPubkey(p);
    if (!lock) return p;
    if (lock !== ourPub) throw new Error("token is locked to a different key");
    const sig = await secp.schnorr.signAsync(sha256(new TextEncoder().encode(p.secret)), sk);
    return { ...p, witness: JSON.stringify({ signatures: [bytesToHex(sig)] }) };
  }));
}

export interface MeltQuote { quote: string; amount: number; fee_reserve: number; state?: string; paid?: boolean; expiry?: number }

export async function meltQuote(mint: string, invoice: string, unit: string, fetchFn: typeof fetch = fetch): Promise<MeltQuote> {
  const r = await fetchFn(mint + "/v1/melt/quote/bolt11", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: invoice, unit }) });
  if (!r.ok) throw new Error(`mint refused melt quote (${r.status}): ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as MeltQuote;
}

export async function melt(mint: string, quote: string, inputs: CashuProof[], fetchFn: typeof fetch = fetch): Promise<{ state?: string; paid?: boolean; payment_preimage?: string | null }> {
  const r = await fetchFn(mint + "/v1/melt/bolt11", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quote, inputs }) });
  if (!r.ok) throw new Error(`mint refused melt (${r.status}): ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as { state?: string; paid?: boolean; payment_preimage?: string | null };
}

/**
 * Redeem a token to Lightning: mint an invoice for (amount - fee reserve) through
 * `makeInvoice`, then have the token's mint pay it with the proofs. Returns sats received.
 */
export async function redeemToLightning(
  token: CashuToken,
  makeInvoice: (sats: number, memo: string) => Promise<string>,
  opts: { privKeyHex?: string; fetchFn?: typeof fetch; onProgress?: (msg: string) => void } = {}
): Promise<{ sats: number; preimage: string | null }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const say = opts.onProgress ?? (() => {});
  if (token.unit !== "sat") throw new Error(`token is denominated in ${token.unit}, only sat tokens can be redeemed here`);
  let proofs = token.proofs;
  if (proofs.some(p2pkLockPubkey)) {
    if (!opts.privKeyHex) throw new Error("token is locked to a key");
    proofs = await witnessProofs(proofs, opts.privKeyHex);
  }
  say("Checking the token with its mint…");
  const state = await checkTokenState(token, fetchFn);
  if (state.spendable === 0) throw new Error("token already spent");
  const usable = token.proofs.filter((_, i) => state.states[i] === "UNSPENT");
  proofs = proofs.filter((_, i) => state.states[i] === "UNSPENT");
  const total = usable.reduce((s, p) => s + p.amount, 0);
  // First quote at the full amount tells us the fee reserve; then re-quote for what fits.
  say("Asking the mint for its fee…");
  const probe = await makeInvoice(total, "Stegstr ecash redemption (probe)");
  const q1 = await meltQuote(token.mint, probe, "sat", fetchFn);
  const target = total - Math.max(q1.fee_reserve, 0);
  if (target <= 0) throw new Error("token is too small to cover the mint's Lightning fee");
  const invoice = await makeInvoice(target, "Stegstr ecash redemption");
  const q2 = await meltQuote(token.mint, invoice, "sat", fetchFn);
  if (q2.amount + q2.fee_reserve > total) throw new Error("mint fee reserve exceeds the token");
  say(`Redeeming ${target} sats…`);
  const res = await melt(token.mint, q2.quote, proofs, fetchFn);
  const ok = res.paid === true || res.state === "PAID";
  if (!ok) throw new Error("mint did not pay the invoice (" + (res.state ?? "unknown") + ")");
  return { sats: target, preimage: res.payment_preimage ?? null };
}

export function mintHost(mint: string): string {
  try { return new URL(mint).host; } catch { return mint; }
}
