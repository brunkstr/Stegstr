/**
 * Nostr relay client: subscribe (feed, profiles, DMs, contacts, reactions, replies) and publish.
 */

import type { NostrEvent } from "./types";

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nos.lol",
];

export type RelayEventCallback = (event: NostrEvent) => void;

type RelayHandle = { close: () => void; send: (payload: unknown[]) => void };

function connectRelay(
  relayUrl: string,
  pubkey: string,
  onEvent: RelayEventCallback,
  onEose?: () => void,
  onError?: (err: unknown) => void
): RelayHandle {
  let closed = false;
  let ws: WebSocket | null = null;
  const subId = "stegstr-feed-" + Math.random().toString(36).slice(2, 10);
  const subDm = "stegstr-dm-" + Math.random().toString(36).slice(2, 10);
  const dynamicSubIds = new Set<string>();

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
        { kinds: [0, 1, 3], authors: [pubkey], limit: 200 },
        { kinds: [0], limit: 500 },
        { kinds: [1], limit: 300 },
        { kinds: [7], "#p": [pubkey], limit: 300 },
      ]);
      send(["REQ", subDm, { kinds: [4], "#p": [pubkey], limit: 100 }]);
    };

    ws.onmessage = (ev) => {
      if (closed) return;
      try {
        const msg = JSON.parse(ev.data as string) as unknown[];
        if (msg[0] === "EVENT" && msg[2]) {
          const e = msg[2] as NostrEvent;
          if (e.id && e.pubkey && typeof e.created_at === "number" && typeof e.kind === "number" && e.content !== undefined) {
            onEvent(e);
          }
        }
        if (msg[0] === "EOSE" && msg[1] === subId) {
          onEose?.();
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
};

export function connectRelays(
  pubkey: string,
  onEvent: RelayEventCallback,
  onEose?: () => void,
  onError?: (err: unknown) => void,
  relays: string[] = DEFAULT_RELAYS
): ConnectRelaysResult {
  const handles: RelayHandle[] = [];
  let eoseCount = 0;
  const expectedEose = relays.length;

  for (const url of relays) {
    const h = connectRelay(
      url,
      pubkey,
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
