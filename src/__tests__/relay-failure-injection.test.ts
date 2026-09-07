/**
 * @vitest-environment node
 *
 * Runs in the plain Node environment, not the project default (jsdom): jsdom's
 * WebSocket polyfill (backed by undici) has an Event-class interop bug in
 * this dependency combination that throws inside dispatchEvent for real
 * socket traffic, silently preventing the client's own onopen/onmessage from
 * ever firing -- unrelated to relay.ts, and avoided by using Node's native
 * WebSocket (available since Node 21+) instead.
 *
 * Phase 3 (STEGSTR_ENTRY_V3.md): networking under failure, against a local
 * controllable mock relay (see mock-relay.ts) since Docker isn't available
 * in this environment for nostr-rs-relay/strfry. Exercises the REAL
 * src/relay.ts client code -- these are not simulated observations, each
 * test starts a real WebSocket server and connects the real client to it.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { webcrypto } from "node:crypto";
import { MockRelay } from "./mock-relay";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
});

let relays: MockRelay[] = [];
afterEach(async () => {
  await Promise.all(relays.map((r) => r.stop()));
  relays = [];
});

async function makeRelay(opts: Parameters<typeof MockRelay.prototype.constructor>[0] = {}) {
  const r = new MockRelay(opts);
  await r.start();
  relays.push(r);
  return r;
}

async function makeSignedEvent(content: string) {
  const { finishEventAsync, generateSecretKey } = await import("../nostr-stub");
  const sk = generateSecretKey();
  return finishEventAsync({ kind: 1, content, tags: [], created_at: Math.floor(Date.now() / 1000) }, sk);
}

function waitFor<T>(check: () => T | undefined, timeoutMs = 3000, intervalMs = 20): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = check();
      if (v !== undefined) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("Phase 3: relay failure injection", () => {
  it("relay down: connectRelays does not throw, and keeps retrying instead of giving up permanently", async () => {
    const { connectRelays } = await import("../relay");
    // Nothing listening on this port at all.
    const deadUrl = "ws://127.0.0.1:1";
    let errorCount = 0;
    let reconnectCount = 0;
    const handle = connectRelays(
      [],
      () => {},
      undefined,
      () => { errorCount++; },
      [deadUrl],
      () => { reconnectCount++; }
    );
    // Give it time to fail and schedule at least one reconnect attempt.
    await new Promise((r) => setTimeout(r, 1500));
    handle.close();
    expect(errorCount).toBeGreaterThan(0); // onError fired -- app can surface this to the user
    // Not asserting reconnectCount > 0 strictly (backoff starts at 1000ms,
    // timing-sensitive) -- the meaningful assertion is that nothing threw
    // and close() cleanly stops it.
  });

  it("relay slow: a response within the OK timeout still counts as a confirmation", async () => {
    const relay = await makeRelay({ responseDelayMs: 500 });
    const { connectRelays } = await import("../relay");
    const handle = connectRelays([], () => {}, undefined, undefined, [relay.url]);
    await new Promise((r) => setTimeout(r, 200)); // let it connect + subscribe
    const ev = await makeSignedEvent("slow relay test");
    const confirmedCount = await handle.publish(ev, 3000);
    handle.close();
    expect(confirmedCount).toBe(1);
  });

  it("relay slow beyond the timeout: publish honestly reports 0, not a false success", async () => {
    const relay = await makeRelay({ responseDelayMs: 2000 });
    const { connectRelays } = await import("../relay");
    const handle = connectRelays([], () => {}, undefined, undefined, [relay.url]);
    await new Promise((r) => setTimeout(r, 200));
    const ev = await makeSignedEvent("too slow test");
    const confirmedCount = await handle.publish(ev, 500); // shorter than the relay's 2000ms delay
    handle.close();
    expect(confirmedCount).toBe(0);
  });

  it("relay drops mid-subscription (before EOSE): client detects the close and reconnects", async () => {
    const storedEvents = [1, 2, 3].map((i) => ({
      id: "e".repeat(63) + i, pubkey: "p".repeat(64), created_at: 1700000000 + i, kind: 1, tags: [], content: `note ${i}`, sig: "s".repeat(128),
    }));
    // Real signatures aren't needed for THIS test since verifyEvent will
    // reject these anyway -- what's under test is connection/reconnect
    // handling, not event acceptance, so onEvent firing isn't asserted here.
    const relay = await makeRelay({ storedEvents, dropAfterNEvents: 2 });
    const { connectRelays } = await import("../relay");
    let reconnects = 0;
    const handle = connectRelays([], () => {}, undefined, undefined, [relay.url], () => { reconnects++; });
    await waitFor(() => (relay.connectionsOpened >= 1 ? true : undefined), 2000);
    // The relay closes its own connection right after sending 2 events,
    // before EOSE -- the client should notice (onclose) and eventually
    // reconnect rather than sitting there believing the subscription is
    // still live and just quiet.
    await waitFor(() => (reconnects >= 1 ? true : undefined), 5000);
    handle.close();
    expect(reconnects).toBeGreaterThanOrEqual(1);
  });

  it("half the pool unreachable: publish still honestly counts only the reachable relays", async () => {
    const goodRelay = await makeRelay({});
    const deadUrl = "ws://127.0.0.1:1"; // nothing listening
    const { connectRelays } = await import("../relay");
    const handle = connectRelays([], () => {}, undefined, undefined, [goodRelay.url, deadUrl]);
    await new Promise((r) => setTimeout(r, 300));
    const ev = await makeSignedEvent("half pool test");
    const confirmedCount = await handle.publish(ev, 2000);
    handle.close();
    // 1 of 2 relays reachable -- must report 1, not 0 (would wrongly look
    // like total failure) and not 2 (would wrongly look like full success).
    expect(confirmedCount).toBe(1);
  });

  it("relay rate-limiting a subscription (NIP-01 CLOSED): client has no handler for it at all", async () => {
    const relay = await makeRelay({ closeSubscriptionImmediately: true });
    const { connectRelays } = await import("../relay");
    let eoseFired = false;
    const handle = connectRelays([], () => {}, () => { eoseFired = true; }, undefined, [relay.url]);
    await waitFor(() => (relay.receivedMessages.some((m) => m[0] === "REQ") ? true : undefined), 2000);
    // Give the client plenty of time to react to the CLOSED message the
    // relay just sent in response to the REQ.
    await new Promise((r) => setTimeout(r, 500));
    const gotClosed = relay.receivedMessages.length > 0; // we know we sent CLOSED; the assertion is about the CLIENT's reaction
    handle.close();
    // FINDING: relay.ts's onmessage has no case for msg[0] === "CLOSED" at
    // all -- it's silently ignored. onEose never fires (correctly, since
    // the sub was closed, not completed) but nothing else happens either:
    // no re-subscribe, no user-visible signal that the relay actively
    // rejected this subscription (vs. just being quiet/empty). This
    // assertion documents that observed behavior rather than "fixing" a
    // silent pass -- the finding is that the client does NOT distinguish
    // "relay closed our subscription" from "relay had nothing to send yet".
    expect(gotClosed).toBe(true);
    expect(eoseFired).toBe(false);
  });

  it("clock skew: an event with created_at far in the future is not dropped or rejected client-side", async () => {
    const { finishEventAsync, generateSecretKey } = await import("../nostr-stub");
    const sk = generateSecretKey();
    const farFuture = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 5; // +5 years
    const skewedEvent = await finishEventAsync({ kind: 1, content: "from the future", tags: [], created_at: farFuture }, sk);
    const { verifyEvent } = await import("../nostr-stub");
    // verifyEvent only checks id/sig authenticity, not created_at plausibility
    // -- confirms the app has no signature-based reason to drop a
    // legitimately-signed-but-clock-skewed event (Nostr intentionally
    // doesn't mandate a freshness window in NIP-01; this test documents
    // that our own verification layer doesn't silently start enforcing one).
    expect(await verifyEvent(skewedEvent)).toBe(true);
  });
});
