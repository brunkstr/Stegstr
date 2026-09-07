/**
 * Nostr relay client: subscribe (feed, profiles, DMs, contacts, reactions, replies) and publish.
 *
 * Reliability notes, since this layer used to fail quietly in three ways:
 *
 *   1. The relay list was fetched from stegstr.com with no timeout. When that
 *      host is unreachable - as it is at the time of writing - every start-up
 *      blocked on two TCP timeouts before falling back to the defaults. The
 *      fetch is now bounded and the defaults are always available immediately.
 *   2. A dropped socket was never re-established: `onclose` cleared the handle
 *      and nothing reconnected, so a feed that worked at start-up silently
 *      stopped updating. Connections now retry with exponential backoff and
 *      re-send their subscriptions on reopen.
 *   3. "Synced" was reported only once *every* relay sent EOSE, so a single
 *      unreachable relay left the UI on "Connecting..." forever, while a single
 *      failing relay was enough to paint the whole status as an error. Both are
 *      now decided across the pool rather than by whichever relay spoke last.
 */

import type { NostrEvent } from "./types";
import { verifyEvent } from "./nostr-stub";

/** URL where the app fetches relay list (JSON with "relays" array). */
export const STEGSTR_CONFIG_URL = "https://www.stegstr.com/config/relay.json";

/** Fallback when relay.json is not served (e.g. cPanel blocking .json). */
export const STEGSTR_CONFIG_URL_PHP = "https://www.stegstr.com/config/relay.php";

/** Default relay list when config fetch fails (direct Nostr relays). */
/** Built-in fallback when stegstr.com/config/relay.json is unreachable. The Stegstr relay comes first by design: it is the default home for app traffic; the public relays are secondaries. */
export const DEFAULT_RELAYS = [
  "wss://relay.stegstr.com",
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

/** How long to wait for the hosted relay list before giving up on it. */
const CONFIG_FETCH_TIMEOUT_MS = 2500;

/** Reconnect backoff bounds. */
const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 30_000;

/** Stop waiting for the slowest relay and call the initial load done. */
const SYNC_TIMEOUT_MS = 8000;

function parseConfigResponse(data: unknown): string[] {
  const obj = data as { relays?: unknown; proxyUrl?: string };
  if (Array.isArray(obj.relays)) {
    const urls = obj.relays
      .filter((u): u is string => typeof u === "string" && (u.startsWith("wss://") || u.startsWith("ws://")))
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length > 0) return urls;
  }
  if (typeof obj.proxyUrl === "string") {
    const u = obj.proxyUrl.trim();
    if (u && (u.startsWith("wss://") || u.startsWith("ws://"))) return [u];
  }
  return [];
}

/**
 * Fetches the relay list from the website config, falling back to the built-in
 * defaults. Each attempt is bounded: an unreachable host must not be able to
 * stall start-up.
 */
export async function getRelayUrls(): Promise<string[]> {
  for (const configUrl of [STEGSTR_CONFIG_URL, STEGSTR_CONFIG_URL_PHP]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(configUrl, { signal: controller.signal });
      if (!res.ok) continue;
      const urls = parseConfigResponse(await res.json());
      if (urls.length > 0) return urls;
    } catch (_) {
      // unreachable, timed out, or not JSON - try the next source
    } finally {
      clearTimeout(timer);
    }
  }
  return [...DEFAULT_RELAYS];
}

export type RelayEventCallback = (event: NostrEvent) => void;

/** Per-relay connection state, for status reporting. */
export type RelayState = "connecting" | "open" | "synced" | "closed" | "error";

export type RelayStatusCallback = (url: string, state: RelayState) => void;

type RelayHandle = {
  url: string;
  close: () => void;
  send: (payload: unknown[]) => void;
  /** Resolves true if this relay sent OK/true for eventId before timeoutMs elapses. */
  waitForOk: (eventId: string, timeoutMs?: number) => Promise<boolean>;
};

function connectRelay(
  relayUrl: string,
  ourPubkeys: string[],
  onEvent: RelayEventCallback,
  onEose?: () => void,
  onError?: (err: unknown) => void,
  onStatus?: RelayStatusCallback,
): RelayHandle {
  let closed = false;
  let ws: WebSocket | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const subId = "stegstr-feed-" + Math.random().toString(36).slice(2, 10);
  const subDm = "stegstr-dm-" + Math.random().toString(36).slice(2, 10);
  const dynamicSubIds = new Set<string>();
  const dynamicSubTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  const MAX_DYNAMIC_SUBS = 20;
  const authors = ourPubkeys.length > 0 ? ourPubkeys : ["0000000000000000000000000000000000000000000000000000000000000000"];
  // Publish confirmations (from #108): NIP-01 OK frames resolve waiters per event id.
  const okWaiters = new Map<string, Array<(ok: boolean) => void>>();

  function send(payload: unknown[]) {
    if (closed || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (_) {}
  }

  function closeDynamicSub(id: string) {
    send(["CLOSE", id]);
    dynamicSubIds.delete(id);
    const t = dynamicSubTimeouts.get(id);
    if (t) { clearTimeout(t); dynamicSubTimeouts.delete(id); }
  }

  function subscribe() {
    send([
      "REQ",
      subId,
      { kinds: [0, 1, 3, 5, 6, 10003], authors, limit: 200 },
      { kinds: [0], limit: 500 },
      { kinds: [1], limit: 300 },
      { kinds: [6], limit: 300 },
      { kinds: [7], "#p": authors, limit: 300 },
      { kinds: [9735], "#p": authors, limit: 300 },
    ]);
    send(["REQ", subDm, { kinds: [4], "#p": authors, limit: 100 }]);
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    // Exponential backoff with jitter, so a relay coming back up does not get
    // hit by every client at the same instant.
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    attempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function open() {
    if (closed) return;
    onStatus?.(relayUrl, "connecting");
    try {
      ws = new WebSocket(relayUrl);
    } catch (err) {
      onStatus?.(relayUrl, "error");
      onError?.(err);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      if (closed) {
        try { ws?.close(); } catch (_) {}
        return;
      }
      attempt = 0; // a successful connection resets the backoff
      onStatus?.(relayUrl, "open");
      subscribe();
    };

    ws.onmessage = (ev) => {
      if (closed) return;
      try {
        const msg = JSON.parse(ev.data as string) as unknown[];
        if (msg[0] === "EVENT" && msg[2]) {
          const e = msg[2] as NostrEvent;
          if (e.id && e.pubkey && typeof e.created_at === "number" && typeof e.kind === "number" && e.content !== undefined) {
            // From #108: verify the id matches the content and the signature
            // matches pubkey+id before treating the event as genuine; a relay
            // is a message transport, not a trusted source of who said what.
            verifyEvent(e)
              .then((valid) => {
                if (closed) return;
                if (!valid) {
                  console.warn("[relay] dropped event with invalid id/signature", e.id, e.pubkey);
                  return;
                }
                try {
                  onEvent(e);
                } catch (err) {
                  console.error("[relay] onEvent error", err);
                }
              })
              .catch((err) => console.error("[relay] verifyEvent error", err));
          }
        }
        if (msg[0] === "EOSE") {
          const eoseSubId = msg[1] as string;
          if (eoseSubId === subId) {
            onStatus?.(relayUrl, "synced");
            try {
              onEose?.();
            } catch (err) {
              console.error("[relay] onEose error", err);
            }
          } else if (dynamicSubIds.has(eoseSubId)) {
            closeDynamicSub(eoseSubId);
          }
        }
        if (msg[0] === "OK" && typeof msg[1] === "string") {
          const waiters = okWaiters.get(msg[1]);
          if (waiters) {
            okWaiters.delete(msg[1]);
            waiters.forEach((resolve) => resolve(msg[2] !== false));
          }
        }
      } catch (_) {}
    };

    ws.onerror = (err) => {
      onStatus?.(relayUrl, "error");
      onError?.(err);
    };

    ws.onclose = () => {
      ws = null;
      if (closed) return;
      onStatus?.(relayUrl, "closed");
      scheduleReconnect();
    };
  }

  function close() {
    closed = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    dynamicSubTimeouts.forEach((t) => clearTimeout(t));
    dynamicSubTimeouts.clear();
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        send(["CLOSE", subId]);
        send(["CLOSE", subDm]);
        dynamicSubIds.forEach((id) => send(["CLOSE", id]));
      } catch (_) {}
    }
    try { ws?.close(); } catch (_) {}
    ws = null;
  }

  open();

  return {
    url: relayUrl,
    close,
    send: (payload: unknown[]) => {
      if (payload[0] === "REQ" && typeof payload[1] === "string") {
        const dynId = payload[1] as string;
        // Evict oldest dynamic sub if at cap
        if (dynamicSubIds.size >= MAX_DYNAMIC_SUBS) {
          const oldest = dynamicSubIds.values().next().value;
          if (oldest) closeDynamicSub(oldest);
        }
        dynamicSubIds.add(dynId);
        // Auto-close after 5s if EOSE hasn't arrived
        dynamicSubTimeouts.set(dynId, setTimeout(() => closeDynamicSub(dynId), 5000));
      }
      send(payload);
    },
    waitForOk: (eventId: string, timeoutMs = 5000) =>
      new Promise<boolean>((resolve) => {
        const existing = okWaiters.get(eventId) ?? [];
        existing.push(resolve);
        okWaiters.set(eventId, existing);
        setTimeout(() => {
          const waiters = okWaiters.get(eventId);
          if (!waiters) return;
          const idx = waiters.indexOf(resolve);
          if (idx >= 0) waiters.splice(idx, 1);
          if (waiters.length === 0) okWaiters.delete(eventId);
          resolve(false);
        }, timeoutMs);
      }),
  };
}

export type ConnectRelaysResult = {
  close: () => void;
  /**
   * Publish a signed event via existing relay connections (no new WebSockets).
   * Resolves with how many relays confirmed via NIP-01 OK within `timeoutMs` --
   * callers should treat 0 as "failed to send" and warn the user / retry rather
   * than assuming the event went out, since `send()` succeeding only means the
   * local socket accepted the write, not that any relay received or stored it.
   */
  publish: (event: NostrEvent, timeoutMs?: number) => Promise<number>;
  requestProfiles: (pubkeys: string[]) => void;
  requestReplies: (noteIds: string[]) => void;
  /** Fetch notes, profile, and contacts for a specific author. */
  requestAuthor: (authorPubkey: string) => void;
  /** Who follows this pubkey (kind 3 with #p). */
  requestFollowers: (ofPubkey: string) => void;
  /** NIP-50: search notes by text (relay-dependent). */
  requestSearch: (query: string) => void;
  /** NIP-50: search profiles by text (relay-dependent; not all relays support). */
  requestProfileSearch: (query: string) => void;
  /** Load more notes (for infinite scroll). until = oldest created_at. */
  requestMore: (until: number) => void;
};

export function connectRelays(
  ourPubkeys: string[],
  onEvent: RelayEventCallback,
  onEose?: () => void,
  onError?: (err: unknown) => void,
  relays: string[] = DEFAULT_RELAYS,
  onStatus?: RelayStatusCallback,
): ConnectRelaysResult {
  const handles: RelayHandle[] = [];
  let lastSearchSubId: string | null = null;
  let lastMoreSubId: string | null = null;

  // The same note arrives from every relay that carries it. Collapsing here
  // keeps the cost off the UI, which would otherwise re-render per duplicate.
  const seenEventIds = new Set<string>();
  const SEEN_CAP = 20_000;
  const dedupe: RelayEventCallback = (event) => {
    if (seenEventIds.has(event.id)) return;
    if (seenEventIds.size >= SEEN_CAP) seenEventIds.clear();
    seenEventIds.add(event.id);
    onEvent(event);
  };

  // The initial load is done when every relay has *settled* - synced, errored
  // or closed - not when every relay has synced. One unreachable relay used to
  // leave this pending forever.
  const settled = new Set<string>();
  let syncReported = false;
  const failures = new Map<string, unknown>();

  const syncTimer = setTimeout(() => reportSync(), SYNC_TIMEOUT_MS);

  function reportSync() {
    if (syncReported) return;
    syncReported = true;
    clearTimeout(syncTimer);
    if (failures.size === relays.length && relays.length > 0) {
      // Every relay failed: this is the only case the UI should call an error.
      onError?.(new Error(`no relay reachable (tried ${relays.length})`));
      return;
    }
    onEose?.();
  }

  function markSettled(url: string) {
    settled.add(url);
    if (settled.size >= relays.length) reportSync();
  }

  for (const url of relays) {
    const h = connectRelay(
      url,
      ourPubkeys,
      dedupe,
      () => {
        failures.delete(url);
        markSettled(url);
      },
      (err) => {
        failures.set(url, err);
        markSettled(url);
      },
      onStatus,
    );
    handles.push(h);
  }

  const broadcast = (payload: unknown[]) => handles.forEach((h) => h.send(payload));

  return {
    close: () => {
      clearTimeout(syncTimer);
      handles.forEach((h) => h.close());
    },
    publish: async (event: NostrEvent, timeoutMs = 5000) => {
      broadcast(["EVENT", event]);
      const results = await Promise.all(handles.map((h) => h.waitForOk(event.id, timeoutMs)));
      return results.filter(Boolean).length;
    },
    requestProfiles: (pubkeys: string[]) => {
      if (pubkeys.length === 0) return;
      const subId = "stegstr-profiles-" + Math.random().toString(36).slice(2, 10);
      broadcast(["REQ", subId, { kinds: [0], authors: pubkeys, limit: 200 }]);
    },
    requestReplies: (noteIds: string[]) => {
      if (noteIds.length === 0) return;
      const subId = "stegstr-replies-" + Math.random().toString(36).slice(2, 10);
      broadcast(["REQ", subId, { kinds: [1], "#e": noteIds, limit: 500 }]);
    },
    requestAuthor: (authorPubkey: string) => {
      if (!authorPubkey) return;
      const subId = "stegstr-author-" + Math.random().toString(36).slice(2, 10);
      broadcast(["REQ", subId, { kinds: [0, 1, 3], authors: [authorPubkey], limit: 200 }]);
    },
    /** Who follows this pubkey (kind 3 events that list them in "p" tag). */
    requestFollowers: (ofPubkey: string) => {
      if (!ofPubkey) return;
      const subId = "stegstr-followers-" + Math.random().toString(36).slice(2, 10);
      broadcast(["REQ", subId, { kinds: [3], "#p": [ofPubkey], limit: 500 }]);
    },
    requestSearch: (query: string) => {
      const q = query.trim();
      if (!q) return;
      if (lastSearchSubId) {
        broadcast(["CLOSE", lastSearchSubId]);
        lastSearchSubId = null;
      }
      const subId = "stegstr-search-" + Math.random().toString(36).slice(2, 10);
      lastSearchSubId = subId;
      broadcast(["REQ", subId, { kinds: [1], search: q, limit: 100 }]);
    },
    requestProfileSearch: (query: string) => {
      const q = query.trim();
      if (!q || q.length < 2) return;
      const subId = "stegstr-profile-search-" + Math.random().toString(36).slice(2, 10);
      broadcast(["REQ", subId, { kinds: [0], search: q, limit: 50 }]);
    },
    requestMore: (until: number) => {
      if (lastMoreSubId) {
        broadcast(["CLOSE", lastMoreSubId]);
        lastMoreSubId = null;
      }
      const subId = "stegstr-more-" + Math.random().toString(36).slice(2, 10);
      lastMoreSubId = subId;
      broadcast(["REQ", subId, { kinds: [1], until, limit: 100 }]);
    },
  };
}

const PUBLISH_OK_TIMEOUT_MS = 5000;

export type PublishResult = {
  url: string;
  ok: boolean;
  /** Relay-supplied reason when it rejected the event. */
  message?: string;
};

/**
 * Publish a signed event to relays over one-shot connections.
 *
 * Prefer `connectRelays(...).publish` when a pool is already open. This exists
 * for the case where it is not, and unlike the previous version it reports what
 * each relay actually said: a post that no relay accepted used to look exactly
 * like a post that every relay accepted.
 */
export function publishEvent(
  event: NostrEvent,
  relays: string[] = DEFAULT_RELAYS,
  onResult?: (result: PublishResult) => void,
): Promise<PublishResult[]> {
  const payload = JSON.stringify(["EVENT", event]);

  return Promise.all(
    relays.map(
      (url) =>
        new Promise<PublishResult>((resolve) => {
          let settled = false;
          const finish = (result: PublishResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws?.close(); } catch (_) {}
            onResult?.(result);
            resolve(result);
          };

          let ws: WebSocket | null = null;
          const timer = setTimeout(
            () => finish({ url, ok: false, message: "timed out waiting for OK" }),
            PUBLISH_OK_TIMEOUT_MS,
          );

          try {
            ws = new WebSocket(url);
          } catch (err) {
            finish({ url, ok: false, message: err instanceof Error ? err.message : String(err) });
            return;
          }

          ws.onopen = () => {
            try {
              ws?.send(payload);
            } catch (err) {
              finish({ url, ok: false, message: err instanceof Error ? err.message : String(err) });
            }
          };
          ws.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data as string) as unknown[];
              if (msg[0] === "OK" && msg[1] === event.id) {
                finish({ url, ok: msg[2] === true, message: typeof msg[3] === "string" ? msg[3] : undefined });
              }
            } catch (_) {}
          };
          ws.onerror = () => finish({ url, ok: false, message: "connection error" });
          ws.onclose = () => finish({ url, ok: false, message: "closed before OK" });
        }),
    ),
  );
}
