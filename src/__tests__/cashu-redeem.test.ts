/** Redemption flow against a fake mint (fetch stub): checkstate, two melt quotes, melt. */
import { describe, expect, it } from "vitest";
import * as Nostr from "../nostr-stub";
import { checkTokenState, decodeToken, proofY, redeemToLightning, witnessProofs } from "../wallet/cashu";

const secret = (i: number) => i.toString(16).padStart(64, "0");
const proofs = [1, 2, 4, 8].map((a, i) => ({ id: "00ad268c4d1f5826", amount: a, secret: secret(i + 1), C: "02" + "ab".repeat(32) }));
const token = decodeToken("cashuA" + btoa(JSON.stringify({ token: [{ mint: "https://mint.test", proofs }], unit: "sat" })));

function fakeMint(opts: { spentIndexes?: number[]; feeReserve?: number; pays?: boolean } = {}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const spentYs = new Set((opts.spentIndexes ?? []).map((i) => proofY(proofs[i])));
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const json = (o: unknown, status = 200) => ({ ok: status < 300, status, json: async () => o, text: async () => JSON.stringify(o) });
    if (url.endsWith("/v1/checkstate")) return json({ states: (body.Ys as string[]).map((Y) => ({ Y, state: spentYs.has(Y) ? "SPENT" : "UNSPENT" })) });
    if (url.endsWith("/v1/melt/quote/bolt11")) { const amt = Number(String(body.request).replace("lnbc", "")); return json({ quote: "q" + amt, amount: amt, fee_reserve: opts.feeReserve ?? 1, state: "UNPAID" }); }
    if (url.endsWith("/v1/melt/bolt11")) return json({ state: opts.pays === false ? "UNPAID" : "PAID", paid: opts.pays !== false, payment_preimage: "ee".repeat(32) });
    return json({ detail: "not found" }, 404);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("cashu redemption", () => {
  it("reports spent and spendable amounts", async () => {
    const m = fakeMint({ spentIndexes: [3] });
    const s = await checkTokenState(token, m.fetchFn);
    expect(s.states).toEqual(["UNSPENT", "UNSPENT", "UNSPENT", "SPENT"]); expect(s.spendable).toBe(7); expect(s.spent).toBe(8);
  });
  it("melts the unspent proofs into an invoice for amount minus the fee reserve", async () => {
    const m = fakeMint({ spentIndexes: [0], feeReserve: 2 });
    const invoices: number[] = [];
    const r = await redeemToLightning(token, async (sats) => { invoices.push(sats); return "lnbc" + sats; }, { fetchFn: m.fetchFn });
    expect(invoices).toEqual([14, 12]);           // probe at 14 spendable, then 14 - fee 2
    expect(r.sats).toBe(12); expect(r.preimage).toBe("ee".repeat(32));
    const meltCall = m.calls.find((c) => c.url.endsWith("/v1/melt/bolt11"))!;
    expect((meltCall.body as { inputs: unknown[] }).inputs).toHaveLength(3);
    expect((meltCall.body as { quote: string }).quote).toBe("q12");
  });
  it("refuses spent tokens, non-sat units and failed payments", async () => {
    await expect(redeemToLightning(token, async (s) => "lnbc" + s, { fetchFn: fakeMint({ spentIndexes: [0, 1, 2, 3] }).fetchFn })).rejects.toThrow(/already spent/);
    const usd = decodeToken("cashuA" + btoa(JSON.stringify({ token: [{ mint: "https://mint.test", proofs }], unit: "usd" })));
    await expect(redeemToLightning(usd, async (s) => "lnbc" + s, { fetchFn: fakeMint().fetchFn })).rejects.toThrow(/usd/);
    await expect(redeemToLightning(token, async (s) => "lnbc" + s, { fetchFn: fakeMint({ pays: false }).fetchFn })).rejects.toThrow(/did not pay/);
  });
  it("adds a witness to proofs locked to our key and refuses others", async () => {
    const sk = Nostr.bytesToHex(Nostr.generateSecretKey());
    const pk = Nostr.getPublicKey(Nostr.hexToBytes(sk));
    const locked = { ...proofs[0], secret: JSON.stringify(["P2PK", { nonce: "n", data: "02" + pk }]) };
    const [w] = await witnessProofs([locked], sk);
    expect(JSON.parse(w.witness!).signatures[0]).toMatch(/^[0-9a-f]{128}$/);
    const other = { ...locked, secret: JSON.stringify(["P2PK", { nonce: "n", data: "02" + "77".repeat(32) }]) };
    await expect(witnessProofs([other], sk)).rejects.toThrow(/different key/);
  });
});
