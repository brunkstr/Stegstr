/**
 * @vitest-environment node
 *
 * Not part of the regular `npm test` run in CI (network-dependent, talks to
 * a real public relay) -- run explicitly with:
 *   npx vitest run src/__tests__/verify-against-real-relay.test.ts
 *
 * Unit tests (nostr-event-verify.test.ts) already prove verifyEvent REJECTS
 * forged/tampered events. That alone doesn't prove it's not too strict --
 * a verifier with an overly narrow acceptance check (a serialization
 * mismatch, a case-sensitivity bug, an unexpected but valid tag shape) would
 * SILENTLY reject genuine events and break the real feed, which is a
 * different failure mode entirely and isn't caught by synthetic-only tests.
 * This connects to a real public relay, pulls real recent events other
 * clients have already published and presumably display fine, and confirms
 * verifyEvent accepts the overwhelming majority of them.
 */
import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
}

const RELAY_URL = process.env.TEST_RELAY_URL || "wss://relay.damus.io";

type RawEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

function fetchRealEvents(relayUrl: string, limit: number, timeoutMs: number): Promise<RawEvent[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const events: RawEvent[] = [];
    const timeout = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      resolve(events);
    }, timeoutMs);

    ws.onopen = () => {
      const subId = "verify-check-" + Math.random().toString(36).slice(2, 8);
      ws.send(JSON.stringify(["REQ", subId, { kinds: [1], limit }]));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as unknown[];
        if (msg[0] === "EVENT" && msg[2]) {
          events.push(msg[2] as RawEvent);
        }
        if (msg[0] === "EOSE") {
          clearTimeout(timeout);
          try { ws.close(); } catch (_) {}
          resolve(events);
        }
      } catch (_) {}
    };
    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

describe("verifyEvent against a real public relay", () => {
  it("accepts the overwhelming majority of real, already-published events", async () => {
    const { verifyEvent } = await import("../nostr-stub");
    const events = await fetchRealEvents(RELAY_URL, 50, 15000);
    expect(events.length).toBeGreaterThan(0); // sanity: we actually got real data, test isn't vacuous

    let passed = 0;
    const failures: Array<{ id: string; pubkey: string; kind: number }> = [];
    for (const ev of events) {
      const ok = await verifyEvent(ev);
      if (ok) passed++;
      else failures.push({ id: ev.id, pubkey: ev.pubkey, kind: ev.kind });
    }

    console.log(`${passed}/${events.length} real events verified; failures:`, failures);
    // A handful of legitimate edge cases exist in the wild (e.g. NIP-26
    // delegated events, which intentionally have a different signer than
    // the pubkey field) -- allow a small tolerance rather than demanding
    // literally 100%, but the overwhelming majority must pass or the
    // verifier itself is the bug.
    expect(passed / events.length).toBeGreaterThan(0.9);
  }, 30000);
});
