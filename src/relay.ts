/**
 * Nostr relay client: subscribe (feed, profiles, DMs, contacts, reactions, replies) and publish.
 * Relay list is fetched from the Stegstr website config (relay.json).
 */

import type { NostrEvent } from "./types";
import { verifyEvent } from "./nostr-stub";

/** URL where the app fetches relay list (JSON with "relays" array). */
export const STEGSTR_CONFIG_URL = "https://www.stegstr.com/config/relay.json";

/** Fallback when relay.json is not served (e.g. cPanel blocking .json). */
export const STEGSTR_CONFIG_URL_PHP = "https://www.stegstr.com/config/relay.php";

/** Default relay list when config fetch fails (direct Nostr relays). */
export const DEFAULT_RELAYS = [
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

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

/** Fetches relay list from website config; tries relay.php if relay.json fails (e.g. cPanel). */
export async function getRelayUrls(): Promise<string[]> {
  for (const configUrl of [STEGSTR_CONFIG_URL, STEGSTR_CONFIG_URL_PHP]) {
    try {
      const res = await fetch(configUrl);
      if (!res.ok) continue;
      const data = await res.json();
      const urls = parseConfigResponse(data);
      if (urls.length > 0) return urls;
    } catch (_) {
      // ignore, try next URL
    }
  }
  return [...DEFAULT_RELAYS];
}

export type RelayEventCallback = (event: NostrEvent) => void;

type RelayHandle = {
  close: () => void;
  send: (payload: unknown[]) => void;
  /** Resolves true if this relay sent OK/true for eventId before timeoutMs elapses. */
  waitForOk: (eventId: string, timeoutMs?: number) => Promise<boolean>;
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

function connectRelay(
  relayUrl: string,
  ourPubkeys: string[],
  onEvent: RelayEventCallback,
  onEose?: () => void,
  onError?: (err: unknown) => void,
  onReconnect?: () => void
): RelayHandle {
  let closed = false; // deliberately closed by caller -- never reconnect
  let ws: WebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const subId = "stegstr-feed-" + Math.random().toString(36).slice(2, 10);
  const subDm = "stegstr-dm-" + Math.random().toString(36).slice(2, 10);
  const dynamicSubIds = new Set<string>();
  const dynamicSubTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  const MAX_DYNAMIC_SUBS = 20;
  const authors = ourPubkeys.length > 0 ? ourPubkeys : ["0000000000000000000000000000000000000000000000000000000000000000"];
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
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed) return;
      open();
      onReconnect?.();
    }, delay);
  }

  function open() {
    try {
      ws = new WebSocket(relayUrl);

      ws.onopen = () => {
        if (closed) {
          close();
          return;
        }
        reconnectAttempt = 0; // connection succeeded -- reset backoff
        subscribe();
      };

      ws.onmessage = (ev) => {
        if (closed) return;
        try {
          const msg = JSON.parse(ev.data as string) as unknown[];
          if (msg[0] === "EVENT" && msg[2]) {
            const e = msg[2] as NostrEvent;
            if (e.id && e.pubkey && typeof e.created_at === "number" && typeof e.kind === "number" && e.content !== undefined) {
              // Structural shape alone proves nothing -- a relay (or a MITM
              // between us and one) could hand back any id/pubkey/content
              // combination it likes. Verify the id actually hashes to this
              // content and the signature actually matches pubkey+id before
              // treating the event as genuine; a relay is a message
              // transport, not a trusted source of truth for who said what.
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

      ws.onerror = (err) => onError?.(err);
      ws.onclose = () => {
        ws = null;
        if (!closed) scheduleReconnect();
      };
    } catch (err) {
      onError?.(err);
      if (!closed) scheduleReconnect();
    }
  }

  function close() {
    closed = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    dynamicSubTimeouts.forEach((t) => clearTimeout(t));
    dynamicSubTimeouts.clear();
    okWaiters.forEach((waiters) => waiters.forEach((resolve) => resolve(false)));
    okWaiters.clear();
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        send(["CLOSE", subId]);
        send(["CLOSE", subDm]);
        dynamicSubIds.forEach((id) => send(["CLOSE", id]));
      } catch (_) {}
      ws.close();
    }
    ws = null;
  }

  open();

  return {
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
  onReconnect?: () => void
): ConnectRelaysResult {
  const handles: RelayHandle[] = [];
  let eoseCount = 0;
  const expectedEose = relays.length;
  let lastSearchSubId: string | null = null;
  let lastMoreSubId: string | null = null;

  for (const url of relays) {
    const h = connectRelay(
      url,
      ourPubkeys,
      onEvent,
      () => {
        eoseCount++;
        if (eoseCount >= expectedEose) onEose?.();
      },
      onError,
      onReconnect
    );
    handles.push(h);
  }

  return {
    close: () => handles.forEach((h) => h.close()),
    publish: async (event: NostrEvent, timeoutMs = 5000) => {
      const payload = ["EVENT", event];
      handles.forEach((h) => h.send(payload));
      const results = await Promise.all(handles.map((h) => h.waitForOk(event.id, timeoutMs)));
      return results.filter(Boolean).length;
    },
    requestProfiles: (pubkeys: string[]) => {
      if (pubkeys.length === 0) return;
      const subId = "stegstr-profiles-" + Math.random().toString(36).slice(2, 10);
      const payload = ["REQ", subId, { kinds: [0], authors: pubkeys, limit: 200 }];
      handles.forEach((h) => h.send(payload));
    },
    requestReplies: (noteIds: string[]) => {
      if (noteIds.length === 0) return;
      const subId = "stegstr-replies-" + Math.random().toString(36).slice(2, 10);
      const payload = ["REQ", subId, { kinds: [1], "#e": noteIds, limit: 500 }];
      handles.forEach((h) => h.send(payload));
    },
    requestAuthor: (authorPubkey: string) => {
      if (!authorPubkey) return;
      const subId = "stegstr-author-" + Math.random().toString(36).slice(2, 10);
      handles.forEach((h) => h.send(["REQ", subId, { kinds: [0, 1, 3], authors: [authorPubkey], limit: 200 }]));
    },
    /** Who follows this pubkey (kind 3 events that list them in "p" tag). */
    requestFollowers: (ofPubkey: string) => {
      if (!ofPubkey) return;
      const subId = "stegstr-followers-" + Math.random().toString(36).slice(2, 10);
      handles.forEach((h) => h.send(["REQ", subId, { kinds: [3], "#p": [ofPubkey], limit: 500 }]));
    },
    requestSearch: (query: string) => {
      const q = query.trim();
      if (!q) return;
      if (lastSearchSubId) {
        handles.forEach((h) => h.send(["CLOSE", lastSearchSubId!]));
        lastSearchSubId = null;
      }
      const subId = "stegstr-search-" + Math.random().toString(36).slice(2, 10);
      lastSearchSubId = subId;
      const payload = ["REQ", subId, { kinds: [1], search: q, limit: 100 }];
      handles.forEach((h) => h.send(payload));
    },
    requestProfileSearch: (query: string) => {
      const q = query.trim();
      if (!q || q.length < 2) return;
      const subId = "stegstr-profile-search-" + Math.random().toString(36).slice(2, 10);
      const payload = ["REQ", subId, { kinds: [0], search: q, limit: 50 }];
      handles.forEach((h) => h.send(payload));
    },
    requestMore: (until: number) => {
      if (lastMoreSubId) {
        handles.forEach((h) => h.send(["CLOSE", lastMoreSubId!]));
        lastMoreSubId = null;
      }
      const subId = "stegstr-more-" + Math.random().toString(36).slice(2, 10);
      lastMoreSubId = subId;
      handles.forEach((h) => h.send(["REQ", subId, { kinds: [1], until, limit: 100 }]));
    },
  };
}

const PUBLISH_OK_TIMEOUT_MS = 3000;

/**
 * Publish a signed event to relays over fresh, one-shot connections. Resolves
 * with how many relays confirmed via NIP-01 OK before the timeout -- 0 means
 * the event did not reach any relay and the caller should surface that rather
 * than assume it sent (a resolved socket write is not a delivery guarantee).
 */
export function publishEvent(event: NostrEvent, relays: string[] = DEFAULT_RELAYS): Promise<number> {
  const payload = JSON.stringify(["EVENT", event]);
  const eventId = event.id;
  const confirmations = relays.map(
    (url) =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (ok: boolean) => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };
        try {
          const ws = new WebSocket(url);
          const timeout = setTimeout(() => {
            try {
              if (ws.readyState === WebSocket.OPEN) ws.close();
            } catch (_) {}
            settle(false);
          }, PUBLISH_OK_TIMEOUT_MS);
          ws.onopen = () => {
            ws.send(payload);
          };
          ws.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data as string) as unknown[];
              if (msg[0] === "OK" && msg[1] === eventId) {
                clearTimeout(timeout);
                try {
                  ws.close();
                } catch (_) {}
                settle(msg[2] !== false);
              }
            } catch (_) {}
          };
          ws.onerror = () => {
            clearTimeout(timeout);
            try {
              ws.close();
            } catch (_) {}
            settle(false);
          };
        } catch (_) {
          settle(false);
        }
      })
  );
  return Promise.all(confirmations).then((results) => results.filter(Boolean).length);
}
