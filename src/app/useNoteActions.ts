/** Extracted verbatim from App.tsx (merge plan step 2). Outer state arrives via `deps`; nothing else changed. */
import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import * as Nostr from "../nostr-stub";
import { confirmDialog } from "../confirm";
import { ensureStegstrSuffix } from "../constants";
import * as logger from "../logger";
import type { IdentityEntry, NostrEvent } from "../types";
import { BASE_ZAP_QUEUE, getStorageKey, loadQueuedZaps } from "./storage";
import { withReferralTag } from "./referral";
import type { QueuedZap } from "./storage";

export interface NoteActionsDeps {
  bookmarksEvent: NostrEvent | null;
  canPublishToNetwork: boolean;
  effectivePrivKey: string;
  identities: IdentityEntry[];
  networkEnabled: boolean;
  profile: string | null;
  pubkey: string;
  publishViaRelay: (ev: NostrEvent) => void;
  relayStatus: string;
  relayUrls: string[];
  replyContent: string;
  replyingTo: NostrEvent | null;
  selfPubkeys: string[];
  setEvents: Dispatch<SetStateAction<NostrEvent[]>>;
  setReplyContent: Dispatch<SetStateAction<string>>;
  setReplyingTo: Dispatch<SetStateAction<NostrEvent | null>>;
  setStatus: Dispatch<SetStateAction<string>>;
}

export function useNoteActions(deps: NoteActionsDeps) {
  const { bookmarksEvent, canPublishToNetwork, effectivePrivKey, identities, networkEnabled, profile, pubkey, publishViaRelay, relayStatus, relayUrls, replyContent, replyingTo, selfPubkeys, setEvents, setReplyContent, setReplyingTo, setStatus } = deps;

  const [queuedZaps, setQueuedZaps] = useState<QueuedZap[]>(() => loadQueuedZaps(profile));

  const handleLike = useCallback(
    async (note: NostrEvent) => {
      if (!effectivePrivKey) return;
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const ev = await Nostr.finishEventAsync(
          {
            kind: 7,
            content: "+",
            tags: [
              ["e", note.id],
              ["p", note.pubkey],
            ],
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Liked");
        logger.logAction("like", "Liked note", { noteId: note.id.slice(0, 8) + "…", networkEnabled });
      } catch (e) {
        setStatus("Like failed: " + (e instanceof Error ? e.message : String(e)));
        logger.logError("Like failed", e, { noteId: note.id.slice(0, 8) + "…" });
      }
    },
    [effectivePrivKey, networkEnabled, canPublishToNetwork]
  );

  const handleRepost = useCallback(
    async (note: NostrEvent) => {
      if (!effectivePrivKey) return;
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const ev = await Nostr.finishEventAsync(
          {
            kind: 6,
            content: JSON.stringify(note),
            tags: [
              ["e", note.id],
              ["p", note.pubkey],
            ],
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Reposted");
      } catch (e) {
        setStatus("Repost failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, networkEnabled, canPublishToNetwork]
  );

  const handleDelete = useCallback(
    async (note: NostrEvent) => {
      if (!selfPubkeys.includes(note.pubkey)) return;
      const preview = note.content.length > 60 ? note.content.slice(0, 60) + "…" : note.content;
      const warning = networkEnabled && canPublishToNetwork
        ? "A deletion request will be published to relays; relays and other clients may still keep copies."
        : "It will be removed from this device.";
      if (!(await confirmDialog(`Delete this note?\n\n"${preview}"\n\n${warning}`))) return;
      const identityForNote = identities.find((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === note.pubkey);
      const privToUse = identityForNote?.privKeyHex ?? effectivePrivKey;
      try {
        const sk = Nostr.hexToBytes(privToUse);
        const ev = await Nostr.finishEventAsync(
          {
            kind: 5,
            content: "",
            tags: [["e", note.id]],
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Note deleted");
      } catch (e) {
        setStatus("Delete failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, identities, selfPubkeys, networkEnabled, canPublishToNetwork]
  );

  const handleBookmark = useCallback(
    async (note: NostrEvent) => {
      if (!effectivePrivKey || !pubkey) return;
      const existing = bookmarksEvent?.tags.filter((t) => t[0] === "e").map((t) => t[1]) ?? [];
      if (existing.includes(note.id)) return;
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const newTags = [...existing.map((id) => ["e", id] as [string, string]), ["e", note.id]];
        const ev = await Nostr.finishEventAsync(
          { kind: 10003, content: "", tags: newTags, created_at: Math.floor(Date.now() / 1000) },
          sk
        );
        setEvents((prev) => prev.filter((e) => !(e.kind === 10003 && e.pubkey === pubkey)).concat(ev as NostrEvent).sort((a, b) => b.created_at - a.created_at));
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Bookmarked");
      } catch (e) {
        setStatus("Bookmark failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, pubkey, networkEnabled, canPublishToNetwork, bookmarksEvent]
  );

  const handleUnbookmark = useCallback(
    async (note: NostrEvent) => {
      if (!effectivePrivKey || !pubkey) return;
      const existing = bookmarksEvent?.tags.filter((t) => t[0] === "e").map((t) => t[1]) ?? [];
      if (!existing.includes(note.id)) return;
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const newTags = existing.filter((id) => id !== note.id).map((id) => ["e", id] as [string, string]);
        const ev = await Nostr.finishEventAsync(
          { kind: 10003, content: "", tags: newTags, created_at: Math.floor(Date.now() / 1000) },
          sk
        );
        setEvents((prev) => prev.filter((e) => !(e.kind === 10003 && e.pubkey === pubkey)).concat(ev as NostrEvent).sort((a, b) => b.created_at - a.created_at));
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Removed from bookmarks");
      } catch (e) {
        setStatus("Unbookmark failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, pubkey, networkEnabled, canPublishToNetwork, bookmarksEvent]
  );

  const getRootId = useCallback((note: NostrEvent): string => {
    const eTag = note.tags.find((t) => t[0] === "e");
    return eTag ? eTag[1] : note.id;
  }, []);

  const handleReply = useCallback(
    async () => {
      if (!effectivePrivKey || !replyingTo || !replyContent.trim()) return;
      const rootId = getRootId(replyingTo);
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const tags: string[][] = withReferralTag([["e", rootId], ["e", replyingTo.id], ["p", replyingTo.pubkey]]);
        const ev = await Nostr.finishEventAsync(
          {
            kind: 1,
            content: ensureStegstrSuffix(replyContent.trim()),
            tags,
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        setReplyingTo(null);
        setReplyContent("");
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Replied");
        logger.logAction("reply", "Replied to note", { rootId, networkEnabled });
      } catch (e) {
        setStatus("Reply failed: " + (e instanceof Error ? e.message : String(e)));
        logger.logError("Reply failed", e, { rootId });
      }
    },
    [effectivePrivKey, replyingTo, replyContent, networkEnabled, canPublishToNetwork, getRootId]
  );

  const openZapUrl = useCallback((url: string) => {
    try {
      window.open(url, "_blank", "noopener");
    } catch (_) {}
  }, []);

  const flushQueuedZaps = useCallback(() => {
    if (!networkEnabled || !canPublishToNetwork || queuedZaps.length === 0) return;
    const pending = [...queuedZaps];
    setQueuedZaps([]);
    pending.forEach((zap) => {
      try {
        publishViaRelay(zap.event as NostrEvent);
      } catch (_) {}
      openZapUrl(zap.zapStreamUrl);
    });
    setStatus(pending.length === 1 ? "Queued zap sent" : `Queued zaps sent (${pending.length})`);
  }, [networkEnabled, canPublishToNetwork, queuedZaps, relayUrls, openZapUrl]);

  const handleZap = useCallback(
    async (note: NostrEvent) => {
      if (!effectivePrivKey) return;
      if (!canPublishToNetwork) {
        setStatus("Zaps require a Nostr identity");
        return;
      }
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const zapRequest = await Nostr.finishEventAsync(
          {
            kind: 9734,
            content: "Zap request",
            tags: [
              ["e", note.id],
              ["p", note.pubkey],
              ["relays", ...relayUrls],
            ],
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        const zapStreamUrl = `https://zap.stream/e/${note.id}`;
        if (networkEnabled) {
          publishViaRelay(zapRequest as NostrEvent);
          openZapUrl(zapStreamUrl);
          setStatus("Zap sent");
        } else {
          const queued: QueuedZap = {
            id: zapRequest.id,
            noteId: note.id,
            event: zapRequest as NostrEvent,
            createdAt: Date.now(),
            zapStreamUrl,
          };
          setQueuedZaps((prev) => [...prev, queued]);
          setStatus("Zap queued. Turn Network ON to send.");
        }
      } catch (e) {
        setStatus("Zap failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, networkEnabled, canPublishToNetwork, relayUrls, openZapUrl]
  );

  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_ZAP_QUEUE, profile), JSON.stringify(queuedZaps));
    } catch (_) {}
  }, [queuedZaps, profile]);

  useEffect(() => {
    if (!networkEnabled || !canPublishToNetwork || relayStatus !== "Synced") return;
    if (queuedZaps.length === 0) return;
    flushQueuedZaps();
  }, [networkEnabled, canPublishToNetwork, relayStatus, queuedZaps.length, flushQueuedZaps]);

  return { flushQueuedZaps, getRootId, handleBookmark, handleDelete, handleLike, handleReply, handleRepost, handleUnbookmark, handleZap, openZapUrl, queuedZaps, setQueuedZaps };
}
