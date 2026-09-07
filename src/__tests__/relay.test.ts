import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectRelays, getRelayUrls, publishEvent, DEFAULT_RELAYS } from "../relay";
import type { NostrEvent } from "../types";

/**
 * Minimal driveable WebSocket stand-in.
 *
 * Every instance registers itself so a test can decide, per relay, whether it
 * opens, sends EOSE, errors or drops - which is exactly the mix that used to
 * leave the real client stuck on "Connecting...".
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  // -- test drivers ---------------------------------------------------------

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(message: unknown[]) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** The subscription id the client used for the main feed request. */
  feedSubId(): string {
    for (const raw of this.sent) {
      const msg = JSON.parse(raw) as unknown[];
      if (msg[0] === "REQ" && typeof msg[1] === "string" && msg[1].startsWith("stegstr-feed-")) {
        return msg[1];
      }
    }
    throw new Error("no feed subscription was sent");
  }

  eose() {
    this.emit(["EOSE", this.feedSubId()]);
  }

  fail() {
    this.onerror?.(new Error("boom"));
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const RELAYS = ["wss://a.example", "wss://b.example", "wss://c.example"];
const PUBKEY = "a".repeat(64);

function noteEvent(id: string): NostrEvent {
  return { id, pubkey: PUBKEY, created_at: 1, kind: 1, tags: [], content: "hi", sig: "" };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connectRelays", () => {
  it("reports sync once every relay has settled, even if one never responds", () => {
    const onEose = vi.fn();
    const onError = vi.fn();
    const pool = connectRelays([PUBKEY], vi.fn(), onEose, onError, RELAYS);

    const [a, b, c] = FakeWebSocket.instances;
    a.open();
    b.open();
    c.open();

    a.eose();
    b.eose();
    expect(onEose).not.toHaveBeenCalled(); // c is still outstanding

    c.fail();
    expect(onEose).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    pool.close();
  });

  it("does not hang forever when a relay never opens at all", () => {
    const onEose = vi.fn();
    const pool = connectRelays([PUBKEY], vi.fn(), onEose, vi.fn(), RELAYS);

    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].eose();
    // The other two stay silent, as an unreachable host does.
    expect(onEose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(8000);
    expect(onEose).toHaveBeenCalledTimes(1);

    pool.close();
  });

  it("raises an error only when every relay has failed", () => {
    const onEose = vi.fn();
    const onError = vi.fn();
    const pool = connectRelays([PUBKEY], vi.fn(), onEose, onError, RELAYS);

    FakeWebSocket.instances.forEach((ws) => ws.fail());

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onEose).not.toHaveBeenCalled();

    pool.close();
  });

  it("reconnects after a dropped socket, and resubscribes", () => {
    const pool = connectRelays([PUBKEY], vi.fn(), vi.fn(), vi.fn(), [RELAYS[0]]);

    const first = FakeWebSocket.instances[0];
    first.open();
    expect(first.sent.length).toBeGreaterThan(0);
    expect(FakeWebSocket.instances).toHaveLength(1);

    first.drop();
    // Backoff is randomised within a bound; advancing past it is enough.
    vi.advanceTimersByTime(2000);

    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1];
    second.open();
    expect(() => second.feedSubId()).not.toThrow();

    pool.close();
  });

  it("stops reconnecting once the pool is closed", () => {
    const pool = connectRelays([PUBKEY], vi.fn(), vi.fn(), vi.fn(), [RELAYS[0]]);
    FakeWebSocket.instances[0].open();

    pool.close();
    FakeWebSocket.instances[0].drop();
    vi.advanceTimersByTime(60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("delivers an event once even when several relays carry it", () => {
    const onEvent = vi.fn();
    const pool = connectRelays([PUBKEY], onEvent, vi.fn(), vi.fn(), RELAYS);

    FakeWebSocket.instances.forEach((ws) => {
      ws.open();
      ws.emit(["EVENT", ws.feedSubId(), noteEvent("dup-1")]);
    });

    expect(onEvent).toHaveBeenCalledTimes(1);

    FakeWebSocket.instances[0].emit(["EVENT", "sub", noteEvent("dup-2")]);
    expect(onEvent).toHaveBeenCalledTimes(2);

    pool.close();
  });
});

describe("publishEvent", () => {
  it("reports which relays accepted and which rejected", async () => {
    const event = noteEvent("evt-1");
    const promise = publishEvent(event, RELAYS);

    const [a, b, c] = FakeWebSocket.instances;
    a.open();
    a.emit(["OK", "evt-1", true, ""]);
    b.open();
    b.emit(["OK", "evt-1", false, "blocked: pow required"]);
    c.open();
    // c never answers; the timeout has to cover it.
    vi.advanceTimersByTime(5000);

    const results = await promise;
    expect(results.find((r) => r.url === RELAYS[0])?.ok).toBe(true);
    expect(results.find((r) => r.url === RELAYS[1])).toMatchObject({
      ok: false,
      message: "blocked: pow required",
    });
    expect(results.find((r) => r.url === RELAYS[2])?.ok).toBe(false);
  });
});

describe("getRelayUrls", () => {
  it("falls back to the defaults when the config host is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(getRelayUrls()).resolves.toEqual(DEFAULT_RELAYS);
  });

  it("gives up on a hanging config host instead of blocking start-up", async () => {
    // A host that accepts the connection and then never answers - the failure
    // mode that used to stall every launch.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );

    const promise = getRelayUrls();
    await vi.advanceTimersByTimeAsync(6000);
    await expect(promise).resolves.toEqual(DEFAULT_RELAYS);
  });
});
