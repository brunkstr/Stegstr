/**
 * Nostr Wallet Connect (NIP-47) client. The user pastes a
 * nostr+walletconnect:// URL from their wallet; from then on the app can ask
 * that wallet to pay invoices and create invoices by exchanging NIP-04
 * encrypted events over the wallet's relay. The wallet keeps the funds and
 * enforces its own budget; Stegstr only holds the connection secret.
 */
import * as Nostr from "../nostr-stub";
import type { NostrEvent } from "../types";

export interface NwcConnection { walletPubkey: string; relay: string; secret: string; lud16?: string }
export interface NwcInfo { alias?: string; methods: string[]; balanceMsat?: number; network?: string }

export const NWC_REQUEST = 23194;
export const NWC_RESPONSE = 23195;
export const NWC_INFO = 13194;

export function parseNwcUrl(input: string): NwcConnection {
  const s = input.trim();
  const m = s.match(/^nostr\+walletconnect:\/\/([0-9a-f]{64})\?(.*)$/i);
  if (!m) throw new Error("not a nostr+walletconnect:// URL");
  const params = new URLSearchParams(m[2]);
  const relay = params.get("relay");
  const secret = params.get("secret");
  if (!relay || !/^wss?:\/\//.test(relay)) throw new Error("connection URL has no relay");
  if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) throw new Error("connection URL has no secret");
  return { walletPubkey: m[1].toLowerCase(), relay, secret: secret.toLowerCase(), lud16: params.get("lud16") ?? undefined };
}

export class NwcError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

type Json = Record<string, unknown>;

export class NwcClient {
  readonly clientPubkey: string;
  constructor(readonly conn: NwcConnection, private readonly timeoutMs = 25_000) {
    this.clientPubkey = Nostr.getPublicKey(Nostr.hexToBytes(conn.secret));
  }

  /** One request per connection: open, subscribe for the reply, publish, wait, close. */
  async request<T = Json>(method: string, params: Json = {}): Promise<T> {
    const sk = Nostr.hexToBytes(this.conn.secret);
    const content = await Nostr.nip04Encrypt(JSON.stringify({ method, params }), this.conn.secret, this.conn.walletPubkey);
    const ev = (await Nostr.finishEventAsync(
      { kind: NWC_REQUEST, content, tags: [["p", this.conn.walletPubkey], ["encryption", "nip04"]], created_at: Math.floor(Date.now() / 1000) },
      sk
    )) as NostrEvent;
    const reply = await this.roundTrip(ev);
    const plain = await Nostr.nip04Decrypt(reply.content, this.conn.secret, this.conn.walletPubkey);
    const parsed = JSON.parse(plain) as { result_type?: string; error?: { code: string; message: string } | null; result?: T };
    if (parsed.error) throw new NwcError(parsed.error.code, parsed.error.message || parsed.error.code);
    return (parsed.result ?? {}) as T;
  }

  private roundTrip(ev: NostrEvent): Promise<NostrEvent> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(this.conn.relay); } catch (e) { reject(e); return; }
      const subId = "nwc-" + ev.id.slice(0, 8);
      const timer = setTimeout(() => { cleanup(); reject(new NwcError("TIMEOUT", "the wallet did not answer")); }, this.timeoutMs);
      const cleanup = () => { clearTimeout(timer); try { ws.close(); } catch { /* closed */ } };
      ws.onopen = () => {
        ws.send(JSON.stringify(["REQ", subId, { kinds: [NWC_RESPONSE], authors: [this.conn.walletPubkey], "#e": [ev.id], limit: 1 }]));
        ws.send(JSON.stringify(["EVENT", ev]));
      };
      ws.onmessage = (m) => {
        let msg: unknown[];
        try { msg = JSON.parse(String(m.data)); } catch { return; }
        if (msg[0] === "EVENT" && msg[1] === subId) {
          const r = msg[2] as NostrEvent;
          if (r.pubkey === this.conn.walletPubkey && r.tags.some((t) => t[0] === "e" && t[1] === ev.id)) { cleanup(); resolve(r); }
        } else if (msg[0] === "OK" && msg[1] === ev.id && msg[2] === false) {
          cleanup(); reject(new NwcError("RELAY_REJECTED", String(msg[3] ?? "relay rejected the request")));
        } else if (msg[0] === "CLOSED" && msg[1] === subId) {
          cleanup(); reject(new NwcError("RELAY_CLOSED", String(msg[2] ?? "subscription closed")));
        }
      };
      ws.onerror = () => { cleanup(); reject(new NwcError("RELAY_ERROR", "could not reach the wallet's relay")); };
    });
  }

  /** The wallet's NIP-47 info event: supported methods and encryption schemes. */
  async fetchInfoEvent(): Promise<{ methods: string[]; encryption: string[] } | null> {
    return new Promise((resolve) => {
      let ws: WebSocket;
      try { ws = new WebSocket(this.conn.relay); } catch { resolve(null); return; }
      const subId = "nwc-info";
      const timer = setTimeout(() => { try { ws.close(); } catch { /* closed */ } resolve(null); }, 10_000);
      let found: NostrEvent | null = null;
      ws.onopen = () => ws.send(JSON.stringify(["REQ", subId, { kinds: [NWC_INFO], authors: [this.conn.walletPubkey], limit: 1 }]));
      ws.onmessage = (m) => {
        let msg: unknown[]; try { msg = JSON.parse(String(m.data)); } catch { return; }
        if (msg[0] === "EVENT" && msg[1] === subId) found = msg[2] as NostrEvent;
        if (msg[0] === "EOSE" || msg[0] === "CLOSED") {
          clearTimeout(timer); try { ws.close(); } catch { /* closed */ }
          if (!found) { resolve(null); return; }
          const enc = found.tags.find((t) => t[0] === "encryption")?.[1];
          resolve({ methods: found.content.split(/\s+/).filter(Boolean), encryption: enc ? enc.split(/\s+/) : ["nip04"] });
        }
      };
      ws.onerror = () => { clearTimeout(timer); resolve(null); };
    });
  }

  async getInfo(): Promise<NwcInfo> {
    const r = await this.request<{ alias?: string; methods?: string[]; network?: string }>("get_info");
    return { alias: r.alias, methods: r.methods ?? [], network: r.network };
  }
  async getBalance(): Promise<number> {
    const r = await this.request<{ balance: number }>("get_balance");
    return Number(r.balance ?? 0);
  }
  async payInvoice(invoice: string): Promise<{ preimage: string }> {
    return this.request<{ preimage: string }>("pay_invoice", { invoice });
  }
  async makeInvoice(amountMsat: number, description: string, expirySec = 3600): Promise<{ invoice: string; payment_hash: string }> {
    return this.request<{ invoice: string; payment_hash: string }>("make_invoice", { amount: amountMsat, description, expiry: expirySec });
  }
  async lookupInvoice(paymentHash: string): Promise<{ settled_at?: number | null; preimage?: string | null; state?: string }> {
    return this.request("lookup_invoice", { payment_hash: paymentHash });
  }
}
