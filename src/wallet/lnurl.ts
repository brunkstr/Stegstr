/** LNURL-pay (LUD-06/16) with optional Nostr zap (NIP-57): turn a Lightning address into an invoice. */
import type { NostrEvent } from "../types";

export interface LnurlPayParams { callback: string; minSendable: number; maxSendable: number; allowsNostr?: boolean; nostrPubkey?: string; metadata?: string }

export function lightningAddressUrl(address: string): string {
  const m = address.trim().match(/^([^@\s]+)@([^@\s]+)$/);
  if (!m) throw new Error("not a Lightning address");
  return `https://${m[2]}/.well-known/lnurlp/${m[1]}`;
}

export async function fetchPayParams(address: string, fetchFn: typeof fetch = fetch): Promise<LnurlPayParams> {
  const r = await fetchFn(lightningAddressUrl(address));
  if (!r.ok) throw new Error(`Lightning address lookup failed (${r.status})`);
  const j = (await r.json()) as LnurlPayParams & { status?: string; reason?: string; tag?: string };
  if (j.status === "ERROR") throw new Error(j.reason || "Lightning address error");
  if (j.tag !== "payRequest" || !j.callback) throw new Error("not a pay request");
  return j;
}

/** Fetch an invoice for `amountMsat`; when `zapRequest` is given and the service supports Nostr, the payment becomes a zap. */
export async function requestInvoice(params: LnurlPayParams, amountMsat: number, zapRequest: NostrEvent | null, fetchFn: typeof fetch = fetch): Promise<string> {
  if (amountMsat < params.minSendable || amountMsat > params.maxSendable) {
    throw new Error(`amount must be between ${Math.ceil(params.minSendable / 1000)} and ${Math.floor(params.maxSendable / 1000)} sats`);
  }
  const url = new URL(params.callback);
  url.searchParams.set("amount", String(amountMsat));
  if (zapRequest && params.allowsNostr && params.nostrPubkey) url.searchParams.set("nostr", JSON.stringify(zapRequest));
  const r = await fetchFn(url.toString());
  if (!r.ok) throw new Error(`invoice request failed (${r.status})`);
  const j = (await r.json()) as { pr?: string; status?: string; reason?: string };
  if (j.status === "ERROR" || !j.pr) throw new Error(j.reason || "no invoice returned");
  return j.pr;
}
