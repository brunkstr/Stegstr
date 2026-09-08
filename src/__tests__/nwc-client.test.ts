/** NIP-47 round trip against a fake wallet service: relay + wallet in one WebSocket server. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WS, { WebSocketServer, type WebSocket as WSClient } from "ws";
import type { AddressInfo } from "node:net";
import * as Nostr from "../nostr-stub";
import { NwcClient, NwcError, NWC_INFO, NWC_REQUEST, NWC_RESPONSE, parseNwcUrl } from "../wallet/nwc";
import type { NostrEvent } from "../types";

let wss: WebSocketServer; let port = 0;
const walletSk = Nostr.bytesToHex(Nostr.generateSecretKey());
const walletPk = Nostr.getPublicKey(Nostr.hexToBytes(walletSk));
const clientSecret = Nostr.bytesToHex(Nostr.generateSecretKey());
const seen: string[] = [];

async function walletReply(req: NostrEvent): Promise<NostrEvent> {
  const plain = JSON.parse(await Nostr.nip04Decrypt(req.content, walletSk, req.pubkey)) as { method: string; params: Record<string, unknown> };
  seen.push(plain.method);
  let body: unknown;
  if (plain.method === "get_info") body = { result_type: "get_info", result: { alias: "fakewallet", methods: ["pay_invoice", "make_invoice", "get_balance"] } };
  else if (plain.method === "get_balance") body = { result_type: "get_balance", result: { balance: 21_000 } };
  else if (plain.method === "pay_invoice") body = plain.params.invoice === "lnbc1bad" ? { result_type: "pay_invoice", error: { code: "PAYMENT_FAILED", message: "no route" } } : { result_type: "pay_invoice", result: { preimage: "ff".repeat(32) } };
  else if (plain.method === "make_invoice") body = { result_type: "make_invoice", result: { invoice: "lnbc" + plain.params.amount, payment_hash: "aa".repeat(32) } };
  else body = { result_type: plain.method, error: { code: "NOT_IMPLEMENTED", message: "nope" } };
  const content = await Nostr.nip04Encrypt(JSON.stringify(body), walletSk, req.pubkey);
  return (await Nostr.finishEventAsync({ kind: NWC_RESPONSE, content, tags: [["p", req.pubkey], ["e", req.id]], created_at: Math.floor(Date.now() / 1000) }, Nostr.hexToBytes(walletSk))) as NostrEvent;
}

beforeAll(async () => {
  // The suite runs under jsdom with a fake WebSocket; this test needs a real client.
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = WS;
  await new Promise<void>((resolve) => {
    wss = new WebSocketServer({ port: 0 });
    wss.on("listening", () => { port = (wss.address() as AddressInfo).port; resolve(); });
    wss.on("connection", (ws: WSClient) => {
      const subs = new Map<string, Record<string, unknown>>();
      ws.on("message", async (data) => {
        const msg = JSON.parse(data.toString()) as unknown[];
        if (msg[0] === "REQ") {
          const filter = msg[2] as { kinds?: number[] };
          subs.set(msg[1] as string, filter);
          if (filter.kinds?.includes(NWC_INFO)) {
            const info = await Nostr.finishEventAsync({ kind: NWC_INFO, content: "pay_invoice make_invoice get_balance get_info", tags: [["encryption", "nip04 nip44_v2"]], created_at: 1 }, Nostr.hexToBytes(walletSk));
            ws.send(JSON.stringify(["EVENT", msg[1], info]));
          }
          ws.send(JSON.stringify(["EOSE", msg[1]]));
        } else if (msg[0] === "EVENT") {
          const ev = msg[1] as NostrEvent;
          ws.send(JSON.stringify(["OK", ev.id, true, ""]));
          if (ev.kind !== NWC_REQUEST) return;
          const reply = await walletReply(ev);
          for (const [id, f] of subs) if ((f as { kinds?: number[] }).kinds?.includes(NWC_RESPONSE)) ws.send(JSON.stringify(["EVENT", id, reply]));
        }
      });
    });
  });
});
afterAll(() => wss.close());

describe("NwcClient", () => {
  const client = () => new NwcClient(parseNwcUrl(`nostr+walletconnect://${walletPk}?relay=ws://127.0.0.1:${port}&secret=${clientSecret}`), 5000);

  it("reads the info event", async () => {
    const info = await client().fetchInfoEvent();
    expect(info?.methods).toContain("pay_invoice");
    expect(info?.encryption).toEqual(["nip04", "nip44_v2"]);
  });
  it("performs encrypted request/response round trips", async () => {
    const c = client();
    expect((await c.getInfo()).alias).toBe("fakewallet");
    expect(await c.getBalance()).toBe(21_000);
    expect((await c.payInvoice("lnbc1good")).preimage).toBe("ff".repeat(32));
    expect((await c.makeInvoice(5000, "test")).invoice).toBe("lnbc5000");
    expect(seen).toEqual(["get_info", "get_balance", "pay_invoice", "make_invoice"]);
  });
  it("surfaces wallet errors with their code", async () => {
    await expect(client().payInvoice("lnbc1bad")).rejects.toMatchObject({ code: "PAYMENT_FAILED" });
    await expect(client().request("nonsense")).rejects.toBeInstanceOf(NwcError);
  });
  it("times out when the relay is unreachable", async () => {
    const c = new NwcClient({ walletPubkey: walletPk, relay: "ws://127.0.0.1:1", secret: clientSecret }, 1500);
    await expect(c.getBalance()).rejects.toBeInstanceOf(NwcError);
  });
});
