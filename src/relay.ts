/**
 * Nostr relay client: subscribe (feed, profiles, DMs, contacts, reactions, replies) and publish.
 */

import type { NostrEvent } from "./types";

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

export type RelayEventCallback = (event: NostrEvent) => void;

type RelayHandle = { close: () => void; send: (payload: unknown[]) => void };

function connectRelay(
  relayUrl: string,
  ourPubkeys: string[],
  onEvent: RelayEventCallback,
  onEose?: () => void,
  onError?: (err: unknown) => void
): RelayHandle {
  let closed = false;
  let ws: WebSocket | null = null;
  const subId = "stegstr-feed-" + Math.random().toString(36).slice(2, 10);
  const subDm = "stegstr-dm-" + Math.random().toString(36).slice(2, 10);
  const dynamicSubIds = new Set<string>();
  const authors = ourPubkeys.length > 0 ? ourPubkeys : ["0000000000000000000000000000000000000000000000000000000000000000"];

  function send(payload: unknown[]) {
    if (closed || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (_) {}
  }

  function close() {
    closed = true;
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

  try {
    ws = new WebSocket(relayUrl);

    ws.onopen = () => {
      if (closed) {
        close();
        return;
      }
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
    };

    ws.onmessage = (ev) => {
      if (closed) return;
      try {
        const msg = JSON.parse(ev.data as string) as unknown[];
        if (msg[0] === "EVENT" && msg[2]) {
          const e = msg[2] as NostrEvent;
          if (e.id && e.pubkey && typeof e.created_at === "number" && typeof e.kind === "number" && e.content !== undefined) {
            try {
              onEvent(e);
            } catch (err) {
              console.error("[relay] onEvent error", err);
            }
          }
        }
        if (msg[0] === "EOSE" && msg[1] === subId) {
          try {
            onEose?.();
          } catch (err) {
            console.error("[relay] onEose error", err);
          }
        }
      } catch (_) {}
    };

    ws.onerror = (err) => onError?.(err);
    ws.onclose = () => { ws = null; };
  } catch (err) {
    onError?.(err);
  }

  return {
    close,
    send: (payload: unknown[]) => {
      if (payload[0] === "REQ" && typeof payload[1] === "string") {
        dynamicSubIds.add(payload[1] as string);
      }
      send(payload);
    },
  };
}

export type ConnectRelaysResult = {
  close: () => void;
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
  relays: string[] = DEFAULT_RELAYS
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
      onError
    );
    handles.push(h);
  }

  return {
    close: () => handles.forEach((h) => h.close()),
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

/** Publish a signed event to relays. Keeps socket open until relay sends OK or timeout. */
export function publishEvent(event: NostrEvent, relays: string[] = DEFAULT_RELAYS): void {
  const payload = JSON.stringify(["EVENT", event]);
  const eventId = event.id;
  for (const url of relays) {
    try {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.close();
        } catch (_) {}
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
          }
        } catch (_) {}
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        try {
          ws.close();
        } catch (_) {}
      };
    } catch (_) {}
  }
}
