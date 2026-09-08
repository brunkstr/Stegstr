/**
 * Lightning wallet (Nostr Wallet Connect) and Cashu ecash for the app.
 *
 * State: one NWC connection per storage profile, a default zap amount, and a
 * per-attachment status map so note cards can show "Paid", "Redeemed",
 * "Already spent" without re-querying. Everything network-side lives in
 * src/wallet/*; this hook only binds it to React state and the status line.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Nostr from "../nostr-stub";
import * as logger from "../logger";
import type { NostrEvent, ProfileData } from "../types";
import { getStorageKey } from "./storage";
import { NwcClient, parseNwcUrl, type NwcConnection } from "../wallet/nwc";
import { decodeInvoice } from "../wallet/bolt11";
import { checkTokenState, decodeToken, mintHost, redeemToLightning } from "../wallet/cashu";
import { fetchPayParams, requestInvoice } from "../wallet/lnurl";

export const BASE_NWC = "stegstr_nwc";
export const BASE_ZAP_SATS = "stegstr_zap_sats";
export const DEFAULT_ZAP_SATS = 21;

export type WalletStatus = "disconnected" | "connecting" | "ready" | "error";
export interface PaymentState { status: "working" | "done" | "error" | "info"; detail: string }

export interface WalletDeps {
  profile: string | null;
  effectivePrivKey: string;
  pubkey: string;
  relayUrls: string[];
  profiles: Record<string, ProfileData>;
  publishViaRelay: (ev: NostrEvent) => void;
  networkEnabled: boolean;
  setStatus: (msg: string) => void;
}

function loadConnection(profile: string | null): NwcConnection | null {
  try {
    const raw = localStorage.getItem(getStorageKey(BASE_NWC, profile));
    if (!raw) return null;
    const j = JSON.parse(raw) as { url?: string };
    return j.url ? parseNwcUrl(j.url) : null;
  } catch { return null; }
}

function loadZapSats(profile: string | null): number {
  try {
    const n = Number(localStorage.getItem(getStorageKey(BASE_ZAP_SATS, profile)));
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_ZAP_SATS;
  } catch { return DEFAULT_ZAP_SATS; }
}

export function useWallet(deps: WalletDeps) {
  const { profile, effectivePrivKey, pubkey, relayUrls, profiles, publishViaRelay, networkEnabled, setStatus } = deps;
  const [connection, setConnection] = useState<NwcConnection | null>(() => loadConnection(profile));
  const [status, setWalletStatus] = useState<WalletStatus>(() => (loadConnection(profile) ? "ready" : "disconnected"));
  const [alias, setAlias] = useState<string | undefined>(undefined);
  const [balanceSat, setBalanceSat] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zapSats, setZapSatsState] = useState<number>(() => loadZapSats(profile));
  const [paymentStates, setPaymentStates] = useState<Record<string, PaymentState>>({});
  const busy = useRef(new Set<string>());

  const client = useMemo(() => (connection ? new NwcClient(connection) : null), [connection]);

  const setPayment = useCallback((key: string, state: PaymentState | null) => {
    setPaymentStates((prev) => {
      const next = { ...prev };
      if (state) next[key] = state; else delete next[key];
      return next;
    });
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!client) return;
    try {
      const msat = await client.getBalance();
      setBalanceSat(Math.floor(msat / 1000));
      setWalletStatus("ready"); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => { if (client) void refreshBalance(); }, [client, refreshBalance]);

  const connect = useCallback(async (url: string): Promise<boolean> => {
    let conn: NwcConnection;
    try { conn = parseNwcUrl(url); }
    catch (e) { setStatus("Wallet: " + (e instanceof Error ? e.message : String(e))); return false; }
    setWalletStatus("connecting"); setError(null);
    const probe = new NwcClient(conn);
    try {
      const info = await probe.fetchInfoEvent();
      if (info && !info.encryption.includes("nip04")) throw new Error("this wallet only speaks NIP-44 encryption, which Stegstr does not support yet");
      let name: string | undefined;
      try { name = (await probe.getInfo()).alias; } catch { /* get_info is optional in NIP-47 */ }
      const msat = await probe.getBalance();
      try { localStorage.setItem(getStorageKey(BASE_NWC, profile), JSON.stringify({ url: url.trim(), connectedAt: Date.now() })); } catch { /* storage unavailable */ }
      setConnection(conn); setAlias(name); setBalanceSat(Math.floor(msat / 1000)); setWalletStatus("ready");
      setStatus(`Wallet connected${name ? ": " + name : ""} (${Math.floor(msat / 1000).toLocaleString()} sats)`);
      logger.logAction("wallet_connect", "NWC wallet connected", { relay: conn.relay, hasLud16: Boolean(conn.lud16) });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setWalletStatus("error"); setError(msg); setStatus("Wallet connection failed: " + msg);
      logger.logError("NWC connect failed", e);
      return false;
    }
  }, [profile, setStatus]);

  const disconnect = useCallback(() => {
    try { localStorage.removeItem(getStorageKey(BASE_NWC, profile)); } catch { /* ignore */ }
    setConnection(null); setAlias(undefined); setBalanceSat(null); setWalletStatus("disconnected"); setError(null);
    setStatus("Wallet disconnected");
  }, [profile, setStatus]);

  const setZapSats = useCallback((n: number) => {
    const v = Number.isInteger(n) && n > 0 ? n : DEFAULT_ZAP_SATS;
    setZapSatsState(v);
    try { localStorage.setItem(getStorageKey(BASE_ZAP_SATS, profile), String(v)); } catch { /* ignore */ }
  }, [profile]);

  /** Pay a BOLT11 invoice through the connected wallet. */
  const payInvoice = useCallback(async (invoice: string): Promise<boolean> => {
    if (!client) { setStatus("Connect a Lightning wallet in Settings first"); return false; }
    if (busy.current.has(invoice)) return false;
    busy.current.add(invoice);
    let label = "invoice";
    try {
      const d = decodeInvoice(invoice);
      label = d.amountSat === null ? "invoice" : `${d.amountSat.toLocaleString()} sats`;
      setPayment(invoice, { status: "working", detail: `Paying ${label}…` });
      const r = await client.payInvoice(invoice);
      setPayment(invoice, { status: "done", detail: `Paid ${label}` });
      setStatus(`Paid ${label}`);
      logger.logAction("pay_invoice", "Invoice paid via NWC", { sats: d.amountSat, preimage: r.preimage?.slice(0, 8) });
      void refreshBalance();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPayment(invoice, { status: "error", detail: msg });
      setStatus("Payment failed: " + msg);
      logger.logError("pay_invoice failed", e);
      return false;
    } finally { busy.current.delete(invoice); }
  }, [client, refreshBalance, setPayment, setStatus]);

  /** Create an invoice through the connected wallet (for "Request sats" on a note). */
  const makeInvoice = useCallback(async (sats: number, memo: string): Promise<string | null> => {
    if (!client) { setStatus("Connect a Lightning wallet in Settings first"); return null; }
    try {
      const r = await client.makeInvoice(Math.round(sats) * 1000, memo || "Stegstr", 7 * 24 * 3600);
      return r.invoice;
    } catch (e) {
      setStatus("Could not create invoice: " + (e instanceof Error ? e.message : String(e)));
      return null;
    }
  }, [client, setStatus]);

  /** NIP-57 zap: resolve the author's Lightning address, fetch a zap invoice, pay it. */
  const zapNote = useCallback(async (note: NostrEvent, sats = zapSats): Promise<boolean> => {
    if (!client) { setStatus("Connect a Lightning wallet in Settings to zap"); return false; }
    const lud16 = profiles[note.pubkey]?.lud16;
    if (!lud16) { setStatus("This author has no Lightning address in their profile"); return false; }
    const key = "zap:" + note.id;
    if (busy.current.has(key)) return false;
    busy.current.add(key);
    try {
      setPayment(key, { status: "working", detail: `Zapping ${sats} sats…` });
      const params = await fetchPayParams(lud16);
      let zapRequest: NostrEvent | null = null;
      if (params.allowsNostr && params.nostrPubkey && effectivePrivKey) {
        zapRequest = (await Nostr.finishEventAsync(
          { kind: 9734, content: "", tags: [["relays", ...relayUrls], ["amount", String(sats * 1000)], ["p", note.pubkey], ["e", note.id]], created_at: Math.floor(Date.now() / 1000) },
          Nostr.hexToBytes(effectivePrivKey)
        )) as NostrEvent;
      }
      const invoice = await requestInvoice(params, sats * 1000, zapRequest);
      const d = decodeInvoice(invoice);
      if (d.amountMsat !== null && d.amountMsat !== sats * 1000) throw new Error("the service returned an invoice for a different amount");
      await client.payInvoice(invoice);
      setPayment(key, { status: "done", detail: `Zapped ${sats} sats` });
      setStatus(`Zapped ${sats} sats to ${profiles[note.pubkey]?.name || lud16}`);
      logger.logAction("zap", "Zap paid via NWC", { sats, noteId: note.id.slice(0, 8), nostr: Boolean(zapRequest) });
      void refreshBalance();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPayment(key, { status: "error", detail: msg });
      setStatus("Zap failed: " + msg);
      logger.logError("zap failed", e);
      return false;
    } finally { busy.current.delete(key); }
  }, [client, zapSats, profiles, effectivePrivKey, relayUrls, refreshBalance, setPayment, setStatus]);

  /** Ask the token's mint whether it is still spendable. */
  const checkCashu = useCallback(async (tokenStr: string): Promise<void> => {
    try {
      const token = decodeToken(tokenStr);
      setPayment(tokenStr, { status: "working", detail: "Checking with " + mintHost(token.mint) + "…" });
      const s = await checkTokenState(token);
      if (s.spendable === 0) setPayment(tokenStr, { status: "error", detail: "Already spent" });
      else if (s.spent > 0) setPayment(tokenStr, { status: "info", detail: `${s.spendable} of ${token.amount} ${token.unit} still spendable` });
      else setPayment(tokenStr, { status: "info", detail: `Unspent: ${token.amount} ${token.unit} at ${mintHost(token.mint)}` });
    } catch (e) {
      setPayment(tokenStr, { status: "error", detail: e instanceof Error ? e.message : String(e) });
    }
  }, [setPayment]);

  /** Redeem ecash into the connected Lightning wallet. */
  const redeemCashu = useCallback(async (tokenStr: string): Promise<boolean> => {
    if (!client) { setStatus("Connect a Lightning wallet in Settings to redeem ecash"); return false; }
    if (busy.current.has(tokenStr)) return false;
    busy.current.add(tokenStr);
    try {
      const token = decodeToken(tokenStr);
      const r = await redeemToLightning(
        token,
        async (sats, memo) => { const inv = await client.makeInvoice(sats * 1000, memo, 600); return inv.invoice; },
        { privKeyHex: effectivePrivKey || undefined, onProgress: (m) => setPayment(tokenStr, { status: "working", detail: m }) }
      );
      setPayment(tokenStr, { status: "done", detail: `Redeemed ${r.sats.toLocaleString()} sats to your wallet` });
      setStatus(`Redeemed ${r.sats.toLocaleString()} sats of ecash`);
      logger.logAction("cashu_redeem", "Ecash redeemed via mint melt", { sats: r.sats, mint: mintHost(token.mint) });
      void refreshBalance();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPayment(tokenStr, { status: "error", detail: msg });
      setStatus("Redeem failed: " + msg);
      logger.logError("cashu redeem failed", e);
      return false;
    } finally { busy.current.delete(tokenStr); }
  }, [client, effectivePrivKey, refreshBalance, setPayment, setStatus]);

  // Unused deps are kept in the signature for future receipt publishing (kind 9735 mirrors).
  void pubkey; void publishViaRelay; void networkEnabled;

  return {
    connection, status, alias, balanceSat, error, zapSats, paymentStates,
    connected: status === "ready" && client !== null,
    lud16: connection?.lud16,
    connect, disconnect, refreshBalance, setZapSats,
    payInvoice, makeInvoice, zapNote, checkCashu, redeemCashu,
  };
}

export type WalletApi = ReturnType<typeof useWallet>;
