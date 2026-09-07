/** Extracted verbatim from App.tsx (merge plan step 2). Outer state arrives via `deps`; nothing else changed. */
import { useState, useCallback, useEffect, useRef, useMemo, type Dispatch, type SetStateAction } from "react";
import { connectRelays, publishEvent, DEFAULT_RELAYS, getRelayUrls } from "../relay";
import { useToast } from "../Toast";
import type { NostrEvent, ProfileData } from "../types";
import { BASE_RELAYS, getStorageKey } from "./storage";

export interface RelayConnectionDeps {
  profile: string | null;
  networkEnabled: boolean;
  viewingPubkeys: Set<string>;
  viewingPubkeysKey: string;
  selfPubkeys: string[];
  contacts: string[];
  setEvents: Dispatch<SetStateAction<NostrEvent[]>>;
  setProfiles: Dispatch<SetStateAction<Record<string, ProfileData>>>;
  toast: ReturnType<typeof useToast>;
}

export function useRelayConnection(deps: RelayConnectionDeps) {
  const { contacts, networkEnabled, profile, selfPubkeys, setEvents, setProfiles, toast, viewingPubkeys, viewingPubkeysKey } = deps;

  const [relayStatus, setRelayStatus] = useState<string>("");

  const [relayUrls, setRelayUrls] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_RELAYS, profile));
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr) && arr.length > 0) return arr;
      }
    } catch (_) {}
    return [...DEFAULT_RELAYS];
  });

  const [newRelayUrl, setNewRelayUrl] = useState("");

  const relayRef = useRef<ReturnType<typeof connectRelays> | null>(null);

  const eventBufferRef = useRef<NostrEvent[]>([]);

  const FLUSH_MS = 120;

  const relayUrlsKey = useMemo(() => relayUrls.join(","), [relayUrls]);

  const publishViaRelay = useCallback((ev: NostrEvent) => {
    const confirmed = relayRef.current
      ? relayRef.current.publish(ev)
      : publishEvent(ev, relayUrls).then((results) => results.filter((r) => r.ok).length);
    const total = relayUrls.length;
    confirmed
      .then((count) => {
        if (count === 0) {
          toast.error("Could not reach any relay -- this post/message may not have sent. Check your connection and try again.");
        } else if (total > 0 && count < total) {
          // A socket accepting a write is not a delivery guarantee -- only
          // report success for the relays that actually sent back NIP-01 OK.
          // Silently treating "1 of 5 relays confirmed" the same as "5 of 5"
          // hides real delivery risk (the other 4 relays' subscribers may
          // never see this note) behind a UI that looks identical either way.
          toast.info(`Reached ${count} of ${total} relays -- some may not have received this.`);
        }
      })
      .catch(() => {
        toast.error("Failed to publish to relays.");
      });
  }, [relayUrls, toast]);

  useEffect(() => {
    getRelayUrls().then((urls) => {
      setRelayUrls((prev) => {
        if (prev.length === DEFAULT_RELAYS.length && prev.every((u, i) => u === DEFAULT_RELAYS[i])) return urls;
        return prev;
      });
    });
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_RELAYS, profile), JSON.stringify(relayUrls));
    } catch (_) {}
  }, [relayUrls, profile]);

  useEffect(() => {
    const authors = Array.from(viewingPubkeys).filter((pk) => pk && /^[a-fA-F0-9]{64}$/.test(pk));
    if (!networkEnabled || authors.length === 0) {
      relayRef.current?.close();
      relayRef.current = null;
      eventBufferRef.current = [];
      setRelayStatus("");
      return;
    }
    setRelayStatus("Connecting…");
    eventBufferRef.current = [];
    let everSynced = false;
    relayRef.current = connectRelays(
      authors,
      (ev) => {
        try {
          if (typeof ev.id !== "string" || typeof ev.pubkey !== "string") return;
          const safe: NostrEvent = {
            id: ev.id,
            pubkey: ev.pubkey,
            created_at: typeof ev.created_at === "number" ? ev.created_at : 0,
            kind: typeof ev.kind === "number" ? ev.kind : 0,
            tags: Array.isArray(ev.tags) ? ev.tags : [],
            content: typeof ev.content === "string" ? ev.content : "",
            sig: typeof ev.sig === "string" ? ev.sig : "",
          };
          eventBufferRef.current.push(safe);
        } catch (_) {}
      },
      () => setRelayStatus("Synced"),
      (err) => setRelayStatus("Error: " + (err instanceof Error ? err.message : String(err))),
      relayUrls,
      (_url, state) => {
        // Per-relay state from the pool. After the initial sync, a relay going
        // back to "connecting" means a drop is being recovered; say so instead of
        // leaving a stale "Synced".
        if (state === "connecting" && everSynced) setRelayStatus("Reconnecting…");
        if (state === "synced" || state === "open") everSynced = true;
      }
    );
    const flush = () => {
      const batch = eventBufferRef.current;
      if (batch.length === 0) return;
      eventBufferRef.current = [];
      try {
        setEvents((prev) => {
          const byId = new Map(prev.map((e) => [e.id, e]));
          batch.forEach((e) => byId.set(e.id, e));
          let all = Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
          const MAX_EVENTS = 10000;
          if (all.length > MAX_EVENTS) {
            const ownPks = new Set(selfPubkeys);
            const own = all.filter((e) => ownPks.has(e.pubkey));
            const rest = all.filter((e) => !ownPks.has(e.pubkey)).slice(0, MAX_EVENTS - own.length);
            all = [...own, ...rest].sort((a, b) => b.created_at - a.created_at);
          }
          return all;
        });
        const profileUpdates: Record<string, ProfileData> = {};
        batch.filter((e) => e.kind === 0).forEach((e) => {
          try {
            const raw = JSON.parse(e.content) as { name?: string; display_name?: string; about?: string; picture?: string; banner?: string; nip05?: string };
            profileUpdates[e.pubkey] = {
              name: raw.name ?? raw.display_name,
              about: raw.about,
              picture: raw.picture,
              banner: raw.banner,
              nip05: raw.nip05,
            };
          } catch (_) {}
        });
        if (Object.keys(profileUpdates).length > 0) {
          setProfiles((p) => {
            const merged = { ...p, ...profileUpdates };
            const MAX_PROFILES = 1000;
            const keys = Object.keys(merged);
            if (keys.length <= MAX_PROFILES) return merged;
            const keepKeys = new Set<string>();
            selfPubkeys.forEach((pk) => keepKeys.add(pk));
            contacts.forEach((pk) => keepKeys.add(pk));
            for (const k of Object.keys(profileUpdates)) keepKeys.add(k);
            const evictable = keys.filter((k) => !keepKeys.has(k));
            const toRemove = evictable.slice(0, keys.length - MAX_PROFILES);
            for (const k of toRemove) delete merged[k];
            return merged;
          });
        }
      } catch (err) {
        console.error("[Stegstr] flush error", err);
      }
    };
    const interval = setInterval(flush, FLUSH_MS);
    return () => {
      clearInterval(interval);
      relayRef.current?.close();
      relayRef.current = null;
      eventBufferRef.current = [];
      setRelayStatus("");
    };
  }, [networkEnabled, viewingPubkeysKey, relayUrlsKey]);

  return { FLUSH_MS, eventBufferRef, newRelayUrl, publishViaRelay, relayRef, relayStatus, relayUrls, relayUrlsKey, setNewRelayUrl, setRelayStatus, setRelayUrls };
}
