/**
 * Minimal BOLT11 decoder: enough to show an invoice to a person before they
 * pay it (amount, description, expiry, payment hash, payee). It checks the
 * bech32 checksum but does not verify the signature; the paying wallet does.
 */
import { bech32 } from "bech32";

export interface DecodedInvoice {
  /** Amount in millisatoshi, or null for "any amount" invoices. */
  amountMsat: number | null;
  /** Amount in whole satoshi (rounded down), or null. */
  amountSat: number | null;
  network: "bitcoin" | "testnet" | "signet" | "regtest" | "unknown";
  timestamp: number;
  /** Seconds after timestamp; BOLT11 default is 3600. */
  expiry: number;
  paymentHash: string | null;
  description: string | null;
  descriptionHash: string | null;
  payee: string | null;
  raw: string;
}

const MULTIPLIERS: Record<string, number> = { m: 1e8, u: 1e5, n: 1e2, p: 1e-1 }; // to msat from BTC*10^-x
const NETWORKS: Record<string, DecodedInvoice["network"]> = { bc: "bitcoin", tb: "testnet", tbs: "signet", bcrt: "regtest" };

function wordsToNumber(words: number[]): number {
  let n = 0;
  for (const w of words) n = n * 32 + w;
  return n;
}

function wordsToBytes(words: number[]): Uint8Array {
  // 5-bit groups to 8-bit, dropping the padding bits.
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w; bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** True if the string looks like a Lightning invoice (with or without a lightning: prefix). */
export function looksLikeInvoice(s: string): boolean {
  return /^(lightning:)?ln(bc|tb|tbs|bcrt)[0-9a-z]*1[02-9ac-hj-np-z]{100,}$/i.test(s.trim());
}

export function decodeInvoice(input: string): DecodedInvoice {
  const raw = input.trim().replace(/^lightning:/i, "").toLowerCase();
  const { prefix, words } = bech32.decode(raw, 7000);
  const m = prefix.match(/^ln(bcrt|tbs|tb|bc)(\d*)([munp]?)$/);
  if (!m) throw new Error("not a Lightning invoice");
  const network = NETWORKS[m[1]] ?? "unknown";
  let amountMsat: number | null = null;
  if (m[2]) {
    const n = Number(m[2]);
    const mult = m[3] ? MULTIPLIERS[m[3]] : 1e11; // no multiplier = whole BTC
    amountMsat = Math.round(n * mult);
    if (m[3] === "p" && n % 10 !== 0) throw new Error("invalid pico amount");
  }
  if (words.length < 7 + 104) throw new Error("invoice too short");
  const timestamp = wordsToNumber(words.slice(0, 7));
  const data = words.slice(7, words.length - 104);
  const out: DecodedInvoice = { amountMsat, amountSat: amountMsat === null ? null : Math.floor(amountMsat / 1000), network, timestamp, expiry: 3600, paymentHash: null, description: null, descriptionHash: null, payee: null, raw };
  let i = 0;
  while (i + 3 <= data.length) {
    const type = data[i]; const len = data[i + 1] * 32 + data[i + 2];
    const field = data.slice(i + 3, i + 3 + len);
    i += 3 + len;
    switch (type) {
      case 1: if (len === 52) out.paymentHash = hex(wordsToBytes(field)); break;
      case 13: out.description = new TextDecoder().decode(wordsToBytes(field)); break;
      case 23: if (len === 52) out.descriptionHash = hex(wordsToBytes(field)); break;
      case 6: out.expiry = wordsToNumber(field); break;
      case 19: if (len === 53) out.payee = hex(wordsToBytes(field)); break;
      default: break;
    }
  }
  return out;
}

export function invoiceExpired(inv: DecodedInvoice, now = Math.floor(Date.now() / 1000)): boolean {
  return now > inv.timestamp + inv.expiry;
}

export function formatSats(sat: number | null): string {
  if (sat === null) return "any amount";
  return sat.toLocaleString() + (sat === 1 ? " sat" : " sats");
}
