import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import * as Nostr from "./nostr-stub";
import { isWeb } from "./platform-web";
import { getActiveReferralCode, setReferralCode as storeReferralCode } from "./app/referral";
import { withReferralTag } from "./app/referral";
import { getTauri } from "./platform-desktop";
import { ensureStegstrSuffix } from "./constants";
import * as logger from "./logger";
import { useToast, ToastContainer } from "./Toast";
import type { NoteCardActions, NoteCardState } from "./NoteCard";
import { NotificationsView } from "./NotificationsView";
import { BookmarksView } from "./BookmarksView";
import { ExploreView } from "./ExploreView";
import { SettingsView } from "./SettingsView";
import { IdentityView } from "./IdentityView";
import { FollowingView } from "./FollowingView";
import { MessagesView } from "./MessagesView";
import { ProfileView } from "./ProfileView";
import { FeedView } from "./FeedView";
import type { FeedItem } from "./FeedView";
import { EmbedModal } from "./EmbedModal";
import { EditProfileModal } from "./EditProfileModal";
import { LoginModal } from "./LoginModal";
import { NewMessageModal } from "./NewMessageModal";
import type { NostrEvent, IdentityEntry, View, ProfileData } from "./types";
import { useRelayConnection } from "./app/useRelayConnection";
import { useStego } from "./app/useStego";
import { useNoteActions } from "./app/useNoteActions";
import { useProfileAndMedia } from "./app/useProfileAndMedia";
import "./App.css";

import { BASE_IDENTITIES, BASE_ACTING, BASE_VIEWING, BASE_MUTE_PUBKEYS, BASE_MUTE_WORDS, BASE_DM_READ, BASE_NOTIF_READ, getDefaultFollowPubkeys, getStorageProfileSync, getStorageKey, getOrCreateAnonKey, migrateToIdentities } from "./app/storage";

export type { IdentityEntry } from "./types";

function App({ profile }: { profile: string | null }) {
  const toast = useToast();
  const [identities, setIdentities] = useState<IdentityEntry[]>(() => migrateToIdentities(profile));
  const [actingPubkey, setActingPubkey] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_ACTING, profile));
      if (raw && /^[a-fA-F0-9]{64}$/.test(raw)) return raw;
    } catch (_) {}
    return null;
  });
  const [viewingPubkeys, setViewingPubkeys] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_VIEWING, profile));
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === "string" && /^[a-fA-F0-9]{64}$/.test(x)));
      }
    } catch (_) {}
    return new Set();
  });
  const [nsec, setNsec] = useState("");
  const [loginFormOpen, setLoginFormOpen] = useState(false);
  const [networkEnabled, setNetworkEnabled] = useState(false);
  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [profiles, setProfiles] = useState<Record<string, ProfileData>>({});
  const [newPost, setNewPost] = useState("");
  const [status, setStatus] = useState<string>("");
  const [view, setView] = useState<View>("feed");
  const [replyingTo, setReplyingTo] = useState<NostrEvent | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [dmDecrypted, setDmDecrypted] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedMessagePeer, setSelectedMessagePeer] = useState<string | null>(null);
  const [dmReplyContent, setDmReplyContent] = useState("");
  const [lastReadTimestamps, setLastReadTimestamps] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_DM_READ, profile));
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, number>;
        if (typeof obj === "object" && obj !== null) return obj;
      }
    } catch (_) {}
    return {};
  });
  const [lastNotifReadAt, setLastNotifReadAt] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_NOTIF_READ, profile));
      if (raw) return Number(raw) || 0;
    } catch (_) {}
    return 0;
  });
  const [newMessagePubkeyInput, setNewMessagePubkeyInput] = useState("");
  const [newMessageModalOpen, setNewMessageModalOpen] = useState(false);
  const [viewingProfilePubkey, setViewingProfilePubkey] = useState<string | null>(null);
  const [profileTab, setProfileTab] = useState<"notes" | "replies">("notes");
  const [showNsecFor, setShowNsecFor] = useState<string | null>(null);
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);
  const [followingSearchInput, setFollowingSearchInput] = useState("");
  const [mutedPubkeys, setMutedPubkeys] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_MUTE_PUBKEYS, profile));
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch (_) {}
    return new Set();
  });
  // Event IDs loaded via Detect image; show them even if author identity has "view" off (shared with any Stegstr user).
  const [mutedWords, setMutedWords] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(BASE_MUTE_WORDS, profile));
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr)) return arr;
      }
    } catch (_) {}
    return [];
  });
  const [muteInput, setMuteInput] = useState("");
  const [feedFilter, setFeedFilter] = useState<"global" | "following">("global");
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const postMediaInputRef = useRef<HTMLInputElement | null>(null);
  const loadingMoreRef = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);


  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_MUTE_PUBKEYS, profile), JSON.stringify([...mutedPubkeys]));
    } catch (_) {}
  }, [mutedPubkeys, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_MUTE_WORDS, profile), JSON.stringify(mutedWords));
    } catch (_) {}
  }, [mutedWords, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_DM_READ, profile), JSON.stringify(lastReadTimestamps));
    } catch (_) {}
  }, [lastReadTimestamps, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_NOTIF_READ, profile), String(lastNotifReadAt));
    } catch (_) {}
  }, [lastNotifReadAt, profile]);

  useEffect(() => {
    if (searchQuery.trim()) setReplyingTo(null);
  }, [searchQuery]);
  useEffect(() => {
    if (view !== "feed") setFocusedNoteId(null);
  }, [view]);
  const prevViewRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevViewRef.current !== null && prevViewRef.current !== view) {
      logger.logAction("view_change", `View changed to ${view}`, { view });
    }
    prevViewRef.current = view;
  }, [view]);

  // Prevent browser from opening dropped images (global handler for web)
  useEffect(() => {
    if (!isWeb()) return;
    const preventDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("dragover", preventDrop);
    document.addEventListener("drop", preventDrop);
    return () => {
      document.removeEventListener("dragover", preventDrop);
      document.removeEventListener("drop", preventDrop);
    };
  }, []);

  const prevNetworkRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevNetworkRef.current !== null && prevNetworkRef.current !== networkEnabled) {
      logger.logAction("network_toggle", networkEnabled ? "Network enabled" : "Network disabled", { networkEnabled });
    }
    prevNetworkRef.current = networkEnabled;
  }, [networkEnabled]);
  const prevNetworkRefLegacy = useRef(false);
  const hasSyncedAnonRef = useRef(false);

  // Ensure at least one identity
  useEffect(() => {
    if (identities.length === 0) {
      const anon = getOrCreateAnonKey(profile);
      const pubkey = Nostr.getPublicKey(Nostr.hexToBytes(anon));
      setIdentities([{ id: "anon-" + pubkey.slice(0, 12), privKeyHex: anon, label: "Local", type: "local", category: "local" }]);
      setActingPubkey(pubkey);
      setViewingPubkeys(new Set([pubkey]));
    }
  }, [identities.length, profile]);

  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_IDENTITIES, profile), JSON.stringify(identities));
    } catch (_) {}
  }, [identities, profile]);
  useEffect(() => {
    if (actingPubkey) {
      try { localStorage.setItem(getStorageKey(BASE_ACTING, profile), actingPubkey); } catch (_) {}
    }
  }, [actingPubkey, profile]);
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_VIEWING, profile), JSON.stringify([...viewingPubkeys]));
    } catch (_) {}
  }, [viewingPubkeys, profile]);

  // Sync viewing to include all identities if empty
  useEffect(() => {
    if (viewingPubkeys.size === 0 && identities.length > 0) {
      setViewingPubkeys(new Set(identities.map((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)))));
    }
  }, [identities, viewingPubkeys.size]);
  useEffect(() => {
    if (!actingPubkey && identities.length > 0) {
      const firstPk = Nostr.getPublicKey(Nostr.hexToBytes(identities[0].privKeyHex));
      setActingPubkey(firstPk);
    }
  }, [actingPubkey, identities]);

  const actingIdentity = identities.find((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === actingPubkey);
  const effectivePrivKey = actingIdentity?.privKeyHex ?? identities[0]?.privKeyHex ?? getOrCreateAnonKey(profile);
  const pubkey = Nostr.getPublicKey(Nostr.hexToBytes(effectivePrivKey));
  const selfPubkeys = Array.from(viewingPubkeys).length > 0 ? Array.from(viewingPubkeys) : [pubkey];
  const selfPubkeysKey = useMemo(() => selfPubkeys.join(","), [selfPubkeys.length, ...selfPubkeys]);
  const viewingPubkeysKey = useMemo(() => [...viewingPubkeys].join(","), [viewingPubkeys]);
  /** Only publish to Nostr relays when identity category is "nostr". Local = steganographic only. */
  const canPublishToNetwork = actingIdentity?.category === "nostr";

  const getIdentityLabelsForPubkey = useCallback((pk: string): string[] => {
    return identities
      .filter((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === pk)
      .map((i) => profiles[pk]?.name || i.label || pk.slice(0, 8) + "…");
  }, [identities, profiles]);

  const isNostrLoggedIn = actingIdentity?.type === "nostr";
  // Use actingPubkey for profile display to avoid crossover with other identities (pubkey has fallback to identities[0])
  const profileDisplayKey = actingPubkey ?? pubkey;
  const myProfile = profileDisplayKey ? profiles[profileDisplayKey] : null;
  const myName = myProfile?.name ?? (profileDisplayKey ? `${profileDisplayKey.slice(0, 8)}…` : "");
  const myPicture = myProfile?.picture ?? null;
  const myAbout = myProfile?.about ?? "";
  const myBanner = myProfile?.banner ?? null;

  const ourPubkeysSet = new Set(identities.map((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex))));
  let contacts = Array.from(viewingPubkeys).flatMap((pk) => {
    const kind3 = events.find((e) => e.kind === 3 && e.pubkey === pk);
    return kind3 ? kind3.tags.filter((t) => t[0] === "p").map((t) => t[1]) : [];
  });
  if (actingIdentity?.category === "local" && actingPubkey && viewingPubkeys.has(actingPubkey) && !events.some((e) => e.kind === 3 && e.pubkey === actingPubkey)) {
    contacts = [...contacts, ...getDefaultFollowPubkeys()];
  }
  const contactsSet = new Set(contacts);

  // ---- extracted feature hooks (merge plan step 2) ----
  const { newRelayUrl, publishViaRelay, relayRef, relayStatus, relayUrls, setNewRelayUrl, setRelayUrls } = useRelayConnection({ contacts, networkEnabled, profile, selfPubkeys, setEvents, setProfiles, toast, viewingPubkeys, viewingPubkeysKey });
  // Publicity-contest referral code (see src/app/referral.ts). State mirrors localStorage
  // so Settings re-renders when it changes; the tag itself is read from storage at publish time.
  const [referralCode, setReferralCodeState] = useState<string | null>(() => getActiveReferralCode());
  const setReferralCode = useCallback((input: string | null) => {
    const code = storeReferralCode(input);
    setReferralCodeState(getActiveReferralCode());
    return code;
  }, []);
  const { decodeError, detecting, dragOverStego, embedCoverFile, embedMethod, embedModalOpen, embedRecipientInput, embedRecipientMode, embedRecipients, embedding, handleDetectFromExchange, handleEmbedConfirm, handleEmbedToExchange, handleLoadFromImage, handleSaveToImage, importedEventIds, setDecodeError, setDragOverStego, setEmbedCoverFile, setEmbedMethod, setEmbedModalOpen, setEmbedRecipientInput, setEmbedRecipientMode, setEmbedRecipients, setTargetPlatform, stegoLogs, stegoProgress, targetPlatform, stegoMode, setStegoMode } = useStego({ effectivePrivKey, events, identities, profile, profiles, setEvents, setFeedFilter, setProfiles, setSearchQuery, setStatus, setView, viewingPubkeys });
  const dmEvents = events.filter(
    (e) =>
      e.kind === 4 &&
      (selfPubkeys.includes(e.pubkey) || e.tags.some((t) => t[0] === "p" && t[1] && selfPubkeys.includes(t[1])))
  );
  const recentDmPartners = (() => {
    const seen = new Set<string>();
    const list: { pubkey: string }[] = [];
    for (const ev of dmEvents.sort((a, b) => b.created_at - a.created_at)) {
      const other = selfPubkeys.includes(ev.pubkey) ? ev.tags.find((t) => t[0] === "p")?.[1] : ev.pubkey;
      if (other && !seen.has(other)) {
        seen.add(other);
        list.push({ pubkey: other });
      }
    }
    return list;
  })();
  const notes = events.filter((e) => e.kind === 1);
  const noteIds = new Set(notes.map((n) => n.id));
  const deletedNoteIds = new Set(
    events.filter((e) => e.kind === 5 && selfPubkeys.includes(e.pubkey)).flatMap((e) => e.tags.filter((t) => t[0] === "e").map((t) => t[1]))
  );
  const rootNotes = notes
    .filter((n) => {
      const eTag = n.tags.find((t) => t[0] === "e");
      return (!eTag || !noteIds.has(eTag[1])) && !deletedNoteIds.has(n.id);
    });
  const getRepliesTo = (noteId: string) =>
    notes.filter((n) => n.tags.find((t) => t[0] === "e" && t[1] === noteId));

  const reposts = events.filter((e) => e.kind === 6);
  const getRepostedNote = (repost: NostrEvent): NostrEvent | null => {
    if (repost.content && repost.content.trim()) {
      try {
        const parsed = JSON.parse(repost.content) as NostrEvent;
        if (parsed.kind === 1 && parsed.id && parsed.pubkey) return parsed;
      } catch (_) {}
    }
    const eTag = repost.tags.find((t) => t[0] === "e");
    if (eTag) {
      const found = notes.find((n) => n.id === eTag[1]);
      if (found) return found;
    }
    return null;
  };

  const myNoteIds = new Set(notes.filter((n) => selfPubkeys.includes(n.pubkey)).map((n) => n.id));
  const noteContentMatchesMutedWord = (content: string) =>
    mutedWords.some((w) => w.trim() && content.toLowerCase().includes(w.trim().toLowerCase()));

  const notificationEventsRaw = selfPubkeys.length > 0
    ? events.filter(
        (e) =>
          (e.kind === 7 && e.tags.some((t) => t[0] === "p" && t[1] && selfPubkeys.includes(t[1]))) ||
          (e.kind === 1 && e.tags.some((t) => t[0] === "e" && myNoteIds.has(t[1]))) ||
          (e.kind === 6 && e.tags.some((t) => t[0] === "e" && myNoteIds.has(t[1]))) ||
          (e.kind === 9735 && e.tags.some((t) => t[0] === "e" && myNoteIds.has(t[1])))
      )
    : [];
  const notificationEvents = notificationEventsRaw
    .filter((e) => !mutedPubkeys.has(e.pubkey) && !noteContentMatchesMutedWord(e.kind === 1 ? e.content : ""))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 100);

  const reactions = events.filter((e) => e.kind === 7);
  const zapReceipts = events.filter((e) => e.kind === 9735);
  const getLikeCount = (noteId: string) =>
    reactions.filter((r) => r.tags.some((t) => t[0] === "e" && t[1] === noteId)).length;
  const getZapCount = (noteId: string) =>
    zapReceipts.filter((r) => r.tags.some((t) => t[0] === "e" && t[1] === noteId)).length;
  const hasLiked = (noteId: string) =>
    reactions.some((r) => selfPubkeys.includes(r.pubkey) && r.tags.some((t) => t[0] === "e" && t[1] === noteId));

  const bookmarksEvent = pubkey ? events.filter((e) => e.kind === 10003 && e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at)[0] : null;
  const bookmarkIds = new Set(
    events
      .filter((e) => e.kind === 10003 && viewingPubkeys.has(e.pubkey))
      .flatMap((e) => e.tags.filter((t) => t[0] === "e").map((t) => t[1]))
  );
  const hasBookmarked = (noteId: string) => bookmarkIds.has(noteId);

  // ---- extracted feature hooks that read derived data (merge plan step 2) ----
  const { flushQueuedZaps, handleBookmark, handleDelete, handleLike, handleReply, handleRepost, handleUnbookmark, handleZap, queuedZaps } = useNoteActions({ bookmarksEvent, canPublishToNetwork, effectivePrivKey, identities, networkEnabled, profile, pubkey, publishViaRelay, relayStatus, relayUrls, replyContent, replyingTo, selfPubkeys, setEvents, setReplyContent, setReplyingTo, setStatus });
  const { editAbout, editBanner, editName, editPicture, editProfileOpen, handleEditProfileOpen, handleEditProfileSave, handlePostMediaUpload, postMediaUrls, setEditAbout, setEditBanner, setEditName, setEditPicture, setEditProfileOpen, setPostMediaUrls, uploadingMedia } = useProfileAndMedia({ actingIdentity, canPublishToNetwork, effectivePrivKey, myAbout, myBanner, myName, myPicture, networkEnabled, pubkey, publishViaRelay, setEvents, setProfiles, setStatus });

  const profileViewPubkey = viewingProfilePubkey ?? profileDisplayKey;
  const profileRootNotes = rootNotes.filter((n) => n.pubkey === profileViewPubkey);
  // Profile's own replies (notes by this user that are replies to other notes)
  const profileReplies = notes.filter((n) => {
    if (n.pubkey !== profileViewPubkey) return false;
    const eTag = n.tags.find((t) => t[0] === "e");
    return eTag && noteIds.has(eTag[1]);
  }).sort((a, b) => b.created_at - a.created_at);
  // Helper to get parent note for a reply
  const getParentNote = (noteId: string) => notes.find((n) => n.id === noteId) ?? null;
  const profileFollowing = profileViewPubkey
    ? (events.find((e) => e.kind === 3 && e.pubkey === profileViewPubkey)?.tags?.filter((t) => t[0] === "p").map((t) => t[1]) ?? [])
    : [];
  const profileFollowers = profileViewPubkey
    ? [...new Set(events.filter((e) => e.kind === 3 && e.tags.some((t) => t[0] === "p" && t[1] === profileViewPubkey)).map((e) => e.pubkey))]
    : [];

  const searchTrim = searchQuery.trim();
  const searchLower = searchTrim.toLowerCase();
  const searchNoSpaces = searchTrim.replace(/\s/g, "");
  // Resolve npub to hex for author search (allow npub anywhere in query, strip spaces)
  let searchPubkeyHex: string | null = null;
  const npubMatch = searchNoSpaces.match(/npub1[a-zA-Z0-9]+/i);
  const npubStr = npubMatch ? npubMatch[0] : null;
  if (npubStr) {
    try {
      const decoded = Nostr.nip19.decode(npubStr);
      if (decoded.type === "npub") searchPubkeyHex = Nostr.bytesToHex(decoded.data);
    } catch (_) {}
  }
  if (!searchPubkeyHex && /^[a-fA-F0-9]{64}$/.test(searchNoSpaces)) {
    searchPubkeyHex = searchNoSpaces.toLowerCase();
  }
  const searchNoSpacesLower = searchNoSpaces.toLowerCase();
  const filteredRootNotes = searchTrim
    ? rootNotes.filter((n) => {
        if (searchPubkeyHex && n.pubkey.toLowerCase() === searchPubkeyHex) return true;
        // Partial hex match: only use no-spaces version for hex-like queries
        if (/^[a-f0-9]{8,64}$/.test(searchNoSpacesLower) && n.pubkey.toLowerCase().includes(searchNoSpacesLower)) return true;
        const authorName = profiles[n.pubkey]?.name?.toLowerCase() ?? "";
        if (authorName && searchLower && authorName.includes(searchLower)) return true;
        if (searchLower && n.content.toLowerCase().includes(searchLower)) return true;
        for (const t of n.tags) {
          if (t[0] === "t" && t[1]?.toLowerCase().includes(searchLower)) return true;
          if (t[1]?.toLowerCase().includes(searchLower)) return true;
        }
        return false;
      })
    : rootNotes;

  const noteMatchesSearch = (n: NostrEvent) => {
    if (!searchTrim) return true;
    if (searchPubkeyHex && n.pubkey.toLowerCase() === searchPubkeyHex) return true;
    const pkLower = n.pubkey.toLowerCase();
    if (searchLower && pkLower.includes(searchLower)) return true;
    const authorName = profiles[n.pubkey]?.name?.toLowerCase() ?? "";
    if (authorName && authorName.includes(searchLower)) return true;
    if (n.content.toLowerCase().includes(searchLower)) return true;
    for (const t of n.tags) {
      if (t[0] === "t" && t[1]?.toLowerCase().includes(searchLower)) return true;
      if (t[1]?.toLowerCase().includes(searchLower)) return true;
    }
    return false;
  };

  const isNoteMuted = (n: NostrEvent) => mutedPubkeys.has(n.pubkey) || noteContentMatchesMutedWord(n.content);

  const exploreNotes = rootNotes
    .filter((n) => !isNoteMuted(n))
    .sort((a, b) => {
      const la = getLikeCount(a.id);
      const lb = getLikeCount(b.id);
      if (lb !== la) return lb - la;
      return b.created_at - a.created_at;
    })
    .slice(0, 100);

  const feedItems: FeedItem[] = [
    ...filteredRootNotes.map((note) => ({ type: "note" as const, note, sortAt: note.created_at })),
    ...reposts
      .map((r) => ({ type: "repost" as const, repost: r, note: getRepostedNote(r), sortAt: r.created_at }))
      .filter((x): x is { type: "repost"; repost: NostrEvent; note: NostrEvent; sortAt: number } => x.note !== null && !deletedNoteIds.has(x.note.id) && noteMatchesSearch(x.note)),
  ]
    .filter((item) => {
      const note = item.type === "note" ? item.note : item.note;
      const reposter = item.type === "repost" ? item.repost.pubkey : null;
      if (mutedPubkeys.has(note.pubkey) || (reposter && mutedPubkeys.has(reposter))) return false;
      if (isNoteMuted(note)) return false;
      if (ourPubkeysSet.has(note.pubkey) && !viewingPubkeys.has(note.pubkey) && !importedEventIds.has(note.id)) return false;
      if (reposter && ourPubkeysSet.has(reposter) && !viewingPubkeys.has(reposter) && !importedEventIds.has(item.type === "repost" ? item.repost.id : note.id)) return false;
      if (feedFilter === "following") {
        const authorPk = item.type === "repost" ? item.repost.pubkey : item.note.pubkey;
        if (!contactsSet.has(authorPk)) return false;
      }
      return true;
    })
    .sort((a, b) => b.sortAt - a.sortAt);


  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel || !networkEnabled || !relayRef.current || view !== "feed") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting || loadingMoreRef.current) return;
        const notesForMin = events.filter((e) => e.kind === 1);
        if (notesForMin.length === 0) return;
        const oldest = Math.min(...notesForMin.map((n) => n.created_at));
        loadingMoreRef.current = true;
        setLoadingMore(true);
        relayRef.current?.requestMore(oldest);
        setTimeout(() => {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        }, 2000);
      },
      { rootMargin: "200px", threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [networkEnabled, view, events.length]);

  const contactsKey = useMemo(() => [...contactsSet].join(","), [contactsSet.size]);
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const toFetch = new Set<string>(contacts);
    notes.forEach((n) => toFetch.add(n.pubkey));
    if (toFetch.size > 0) relayRef.current.requestProfiles([...toFetch].slice(0, 300));
  }, [networkEnabled, contactsKey, notes.length]);

  const rootNoteIdsKey = useMemo(() => rootNotes.map((n) => n.id).join(","), [rootNotes.length]);
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const ids = rootNotes.map((n) => n.id);
    if (ids.length > 0) relayRef.current.requestReplies(ids);
  }, [networkEnabled, rootNoteIdsKey]);

  useEffect(() => {
    if (relayStatus !== "Synced" || !relayRef.current) return;
    const toFetch = new Set<string>(contacts);
    notes.forEach((n) => toFetch.add(n.pubkey));
    if (toFetch.size > 0) relayRef.current.requestProfiles([...toFetch].slice(0, 300));
    const ids = rootNotes.map((n) => n.id);
    if (ids.length > 0) relayRef.current.requestReplies(ids);
  }, [relayStatus]);

  // When user searches by pubkey/npub, fetch that author's notes and profile from relays (debounced)
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const trimmed = searchQuery.trim().replace(/\s/g, "");
    let toFetch: string | null = null;
    const npubMatch = trimmed.match(/npub1[a-zA-Z0-9]+/i);
    if (npubMatch) {
      try {
        const decoded = Nostr.nip19.decode(npubMatch[0]);
        if (decoded.type === "npub") toFetch = Nostr.bytesToHex(decoded.data);
      } catch (_) {}
    } else if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
      toFetch = trimmed.toLowerCase();
    }
    if (!toFetch) return;
    const t = setTimeout(() => {
      relayRef.current?.requestAuthor(toFetch!);
    }, 400);
    return () => clearTimeout(t);
  }, [networkEnabled, searchQuery]);

  // When relay becomes Synced and search is a pubkey, fetch that author (in case first request ran too early)
  useEffect(() => {
    if (relayStatus !== "Synced" || !relayRef.current) return;
    const trimmed = searchQuery.trim().replace(/\s/g, "");
    let toFetch: string | null = null;
    const npubMatch = trimmed.match(/npub1[a-zA-Z0-9]+/i);
    if (npubMatch) {
      try {
        const decoded = Nostr.nip19.decode(npubMatch[0]);
        if (decoded.type === "npub") toFetch = Nostr.bytesToHex(decoded.data);
      } catch (_) {}
    } else if (/^[a-fA-F0-9]{64}$/.test(trimmed)) toFetch = trimmed.toLowerCase();
    if (toFetch) relayRef.current.requestAuthor(toFetch);
  }, [relayStatus, searchQuery]);

  // When viewing a profile (own or other), fetch profile, notes, and followers
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const pk = viewingProfilePubkey ?? pubkey;
    if (!pk) return;
    relayRef.current.requestProfiles([pk]);
    relayRef.current.requestAuthor(pk);
    relayRef.current.requestFollowers(pk);
  }, [networkEnabled, viewingProfilePubkey, pubkey]);

  // When Nostr is acting and we lack profile data, aggressively fetch after relay syncs
  const profileSyncRetryRef = useRef(0);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  useEffect(() => {
    if (!networkEnabled || !relayRef.current || relayStatus !== "Synced") return;
    if (!actingPubkey || actingIdentity?.type !== "nostr") return;
    const haveProfile = profilesRef.current[actingPubkey]?.name || profilesRef.current[actingPubkey]?.picture || profilesRef.current[actingPubkey]?.about;
    if (haveProfile) { profileSyncRetryRef.current = 0; return; }
    if (profileSyncRetryRef.current >= 5) {
      setStatus("Could not fetch profile from relays. Try toggling Network off/on.");
      return;
    }
    profileSyncRetryRef.current++;
    relayRef.current.requestProfiles([actingPubkey]);
    relayRef.current.requestAuthor(actingPubkey);
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    for (const delay of [1500, 3500, 7000]) {
      timeouts.push(
        setTimeout(() => {
          if (profilesRef.current[actingPubkey]?.name || profilesRef.current[actingPubkey]?.picture) return;
          relayRef.current?.requestProfiles([actingPubkey]);
          relayRef.current?.requestAuthor(actingPubkey);
        }, delay)
      );
    }
    return () => timeouts.forEach((t) => clearTimeout(t));
  }, [networkEnabled, relayStatus, actingPubkey, actingIdentity?.type]);

  // NIP-50: when user searches by text (not pubkey), ask relays for matching notes and profiles (debounced)
  useEffect(() => {
    try {
      if (!networkEnabled || !relayRef.current) return;
      const trimmed = searchQuery.trim();
      if (trimmed.length < 2) return;
      const isPubkey = /npub1[a-zA-Z0-9]+/i.test(trimmed.replace(/\s/g, "")) || /^[a-fA-F0-9]{64}$/.test(trimmed.replace(/\s/g, ""));
      if (isPubkey) return;
      const t = setTimeout(() => {
        try {
          relayRef.current?.requestSearch(trimmed);
          relayRef.current?.requestProfileSearch(trimmed);
          logger.logAction("search", "Search performed", { query: trimmed.slice(0, 50), networkEnabled });
        } catch (e) {
          console.error("[Stegstr] search request error", e);
        }
      }, 500);
      return () => clearTimeout(t);
    } catch (e) {
      console.error("[Stegstr] search effect error", e);
    }
  }, [networkEnabled, searchQuery]);

  // New message modal: fetch profiles by name from relays when user types (debounced)
  useEffect(() => {
    if (!newMessageModalOpen || !networkEnabled || !relayRef.current) return;
    const trimmed = newMessagePubkeyInput.trim();
    if (trimmed.length < 2) return;
    if (resolvePubkeyFromInput(newMessagePubkeyInput)) return;
    const t = setTimeout(() => {
      relayRef.current?.requestProfileSearch(trimmed);
    }, 400);
    return () => clearTimeout(t);
  }, [newMessageModalOpen, newMessagePubkeyInput, networkEnabled]);

  // Follow area: fetch profiles by name from relays when user types (debounced)
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const trimmed = followingSearchInput.trim();
    if (trimmed.length < 2) return;
    if (resolvePubkeyFromInput(followingSearchInput)) return;
    const t = setTimeout(() => {
      relayRef.current?.requestProfileSearch(trimmed);
    }, 400);
    return () => clearTimeout(t);
  }, [networkEnabled, followingSearchInput]);

  useEffect(() => {
    const justTurnedOn = networkEnabled && !prevNetworkRefLegacy.current;
    prevNetworkRefLegacy.current = networkEnabled;
    if (!justTurnedOn || !pubkey || !canPublishToNetwork) return;
    setEvents((prev) => {
      const myEvents = prev.filter((e) => e.pubkey === pubkey);
      const BATCH = 5;
      const DELAY_MS = 400;
      myEvents.forEach((ev, i) => {
        setTimeout(() => {
          try {
            publishViaRelay(ev);
          } catch (_) {}
        }, Math.floor(i / BATCH) * DELAY_MS);
      });
      return prev;
    });
  }, [networkEnabled, pubkey, relayUrls, canPublishToNetwork]);

  const dmCacheRef = useRef<Record<string, string>>({});
  const dmEventIds = dmEvents.map((e) => e.id).join(",");
  useEffect(() => {
    if (dmEvents.length === 0) {
      dmCacheRef.current = {};
      setDmDecrypted({});
      return;
    }
    let cancelled = false;
    const cached = dmCacheRef.current;
    const newEvents = dmEvents.filter((ev) => !(ev.id in cached));
    if (newEvents.length === 0) {
      setDmDecrypted({ ...cached });
      return;
    }
    (async () => {
      for (const ev of newEvents) {
        if (cancelled) return;
        const weAreSender = selfPubkeys.includes(ev.pubkey);
        const ourPk = weAreSender ? ev.pubkey : ev.tags.find((t) => t[0] === "p")?.[1];
        const otherPubkey = weAreSender ? ev.tags.find((t) => t[0] === "p")?.[1] : ev.pubkey;
        if (!ourPk || !otherPubkey || !selfPubkeys.includes(ourPk)) {
          cached[ev.id] = "[No peer]";
          continue;
        }
        const identityForPk = identities.find((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === ourPk);
        const privToUse = identityForPk?.privKeyHex ?? effectivePrivKey;
        try {
          const plain = await Nostr.nip04Decrypt(ev.content, privToUse, otherPubkey);
          if (!cancelled) cached[ev.id] = plain;
        } catch {
          if (!cancelled) cached[ev.id] = "[Decryption failed]";
        }
      }
      if (!cancelled) {
        dmCacheRef.current = cached;
        setDmDecrypted({ ...cached });
      }
    })();
    return () => { cancelled = true; };
  }, [identities, effectivePrivKey, dmEventIds, selfPubkeysKey]);

  // Mark DM conversation as read when user opens it
  useEffect(() => {
    if (selectedMessagePeer) {
      setLastReadTimestamps((prev) => ({ ...prev, [selectedMessagePeer]: Math.floor(Date.now() / 1000) }));
    }
  }, [selectedMessagePeer]);

  // Compute total unread DM count across all peers
  const totalUnreadDmCount = useMemo(() => {
    let count = 0;
    for (const { pubkey: pk } of recentDmPartners) {
      const lastRead = lastReadTimestamps[pk] ?? 0;
      count += dmEvents.filter((ev) => {
        // Only count messages FROM them (not our own sent messages)
        if (selfPubkeys.includes(ev.pubkey)) return false;
        const other = ev.pubkey;
        return other === pk && ev.created_at > lastRead;
      }).length;
    }
    return count;
  }, [dmEvents, recentDmPartners, lastReadTimestamps, selfPubkeys]);

  const totalUnreadNotifCount = useMemo(() => {
    return notificationEvents.filter((ev) => ev.created_at > lastNotifReadAt).length;
  }, [notificationEvents, lastNotifReadAt]);

  // Mark notifications as read when viewing
  useEffect(() => {
    if (view === "notifications" && notificationEvents.length > 0) {
      const latest = notificationEvents[0].created_at;
      if (latest > lastNotifReadAt) {
        setLastNotifReadAt(latest);
      }
    }
  }, [view, notificationEvents, lastNotifReadAt]);

  const handleAddNostrIdentity = useCallback((hexOrNsec: string) => {
    const trimmed = hexOrNsec.trim();
    let privHex: string;
    if (trimmed.toLowerCase().startsWith("nsec")) {
      try {
        const decoded = Nostr.nip19.decode(trimmed);
        if (decoded.type === "nsec") privHex = Nostr.bytesToHex(decoded.data);
        else { setStatus("Invalid nsec"); return; }
      } catch (e) {
        setStatus("Invalid nsec: " + (e as Error).message);
        return;
      }
    } else if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
      privHex = trimmed;
    } else {
      setStatus("Enter valid nsec or 64-char hex key");
      return;
    }
    const pk = Nostr.getPublicKey(Nostr.hexToBytes(privHex));
    if (identities.some((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === pk)) {
      setStatus("Identity already added");
      return;
    }
    setIdentities((prev) => [...prev, { id: "nostr-" + pk.slice(0, 12), privKeyHex: privHex, label: pk.slice(0, 8) + "…", type: "nostr", category: "nostr" }]);
    setActingPubkey(pk);
    setViewingPubkeys((prev) => new Set(prev).add(pk));
    setLoginFormOpen(false);
    setNsec("");
    setStatus(networkEnabled ? "Nostr identity added. Fetching profile…" : "Nostr identity added. Turn Network ON to fetch your profile and posts.");
    if (networkEnabled) {
      const fetchProfile = () => {
        relayRef.current?.requestProfiles([pk]);
        relayRef.current?.requestAuthor(pk);
      };
      setTimeout(fetchProfile, 800);
      setTimeout(fetchProfile, 2500);
      setTimeout(fetchProfile, 5000);
    }
  }, [identities, networkEnabled]);

  const handleLogin = useCallback(() => {
    if (!nsec.trim()) {
      setStatus("Enter nsec or click Generate");
      return;
    }
    handleAddNostrIdentity(nsec.trim());
  }, [nsec, handleAddNostrIdentity]);

  const handleGenerate = useCallback(() => {
    const sk = Nostr.generateSecretKey();
    const hex = Nostr.bytesToHex(sk);
    const pk = Nostr.getPublicKey(sk);
    setIdentities((prev) => [...prev, { id: "local-" + pk.slice(0, 12), privKeyHex: hex, label: "Local " + (prev.length + 1), type: "local", category: "local" }]);
    setActingPubkey(pk);
    setViewingPubkeys((prev) => new Set(prev).add(pk));
    setNsec(Nostr.nip19.nsecEncode(sk));
    setStatus("New local identity created");
    setLoginFormOpen(false);
  }, []);

  // Helper to add stego log entries (visible in UI)


  const resolvePubkeyFromInput = useCallback((input: string): string | null => {
    const s = input.trim().replace(/\s/g, "");
    const npubMatch = s.match(/npub1[a-zA-Z0-9]+/i);
    if (npubMatch) {
      try {
        const decoded = Nostr.nip19.decode(npubMatch[0]);
        if (decoded.type === "npub") return Nostr.bytesToHex(decoded.data);
      } catch (_) {}
    }
    if (/^[a-fA-F0-9]{64}$/.test(s)) return s.toLowerCase();
    return null;
  }, []);

  const handleSendDm = useCallback(
    async (theirPubkeyHex: string, content: string) => {
      if (!effectivePrivKey || !content.trim()) return;
      try {
        const encrypted = await Nostr.nip04Encrypt(content.trim(), effectivePrivKey, theirPubkeyHex);
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const ev = await Nostr.finishEventAsync(
          {
            kind: 4,
            content: encrypted,
            tags: [["p", theirPubkeyHex]],
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        setDmReplyContent("");
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Message sent");
        logger.logAction("dm_send", "DM sent", { to: theirPubkeyHex.slice(0, 8) + "…", networkEnabled });
      } catch (e) {
        setStatus("Send failed: " + (e instanceof Error ? e.message : String(e)));
        logger.logError("DM send failed", e, { to: theirPubkeyHex.slice(0, 8) + "…" });
      }
    },
    [effectivePrivKey, networkEnabled, canPublishToNetwork]
  );

  const handlePost = useCallback(async () => {
    if (!effectivePrivKey) return;
    const textPart = newPost.trim();
    const mediaPart = postMediaUrls.length ? "\n" + postMediaUrls.join("\n") : "";
    if (!textPart && !postMediaUrls.length) return;
    const sk = Nostr.hexToBytes(effectivePrivKey);
    const content = ensureStegstrSuffix((textPart || " ") + mediaPart);
    const tags: string[][] = withReferralTag(postMediaUrls.flatMap((url) => [["im", url]]));
    const ev = await Nostr.finishEventAsync(
      {
        kind: 1,
        content,
        tags,
        created_at: Math.floor(Date.now() / 1000),
      },
      sk
    );
    setEvents((prev) => [ev as NostrEvent, ...prev]);
    setNewPost("");
    setPostMediaUrls([]);
    if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
    setStatus("Posted");
    logger.logAction("post", "Posted note", { networkEnabled, contentLength: content.length, mediaCount: postMediaUrls.length });
  }, [effectivePrivKey, newPost, postMediaUrls, networkEnabled, canPublishToNetwork]);

  const handleFollow = useCallback(
    async (theirPk: string) => {
      if (!effectivePrivKey || !pubkey) return;
      const kind3 = events.find((e) => e.kind === 3 && e.pubkey === pubkey);
      const existingTags = kind3 ? kind3.tags.filter((t) => t[0] === "p") : [];
      if (existingTags.some((t) => t[1] === theirPk)) {
        setStatus("Already following");
        return;
      }
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const newTags = [...existingTags.map((t) => ["p", t[1]]), ["p", theirPk]];
        const ev = await Nostr.finishEventAsync(
          { kind: 3, content: kind3?.content ?? "", tags: newTags, created_at: Math.floor(Date.now() / 1000) },
          sk
        );
        setEvents((prev) => prev.filter((e) => !(e.kind === 3 && e.pubkey === pubkey)).concat(ev as NostrEvent).sort((a, b) => b.created_at - a.created_at));
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Following");
        logger.logAction("follow", "Followed pubkey", { theirPk: theirPk.slice(0, 8) + "…", networkEnabled });
      } catch (e) {
        setStatus("Follow failed: " + (e instanceof Error ? e.message : String(e)));
        logger.logError("Follow failed", e, { theirPk: theirPk.slice(0, 8) + "…" });
      }
    },
    [effectivePrivKey, pubkey, events, networkEnabled, canPublishToNetwork]
  );

  const handleUnfollow = useCallback(
    async (theirPk: string) => {
      if (!effectivePrivKey || !pubkey) return;
      const kind3 = events.find((e) => e.kind === 3 && e.pubkey === pubkey);
      if (!kind3) return;
      const newTags = kind3.tags.filter((t) => t[0] !== "p" || t[1] !== theirPk);
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const ev = await Nostr.finishEventAsync(
          { kind: 3, content: kind3.content, tags: newTags, created_at: Math.floor(Date.now() / 1000) },
          sk
        );
        setEvents((prev) => prev.filter((e) => !(e.kind === 3 && e.pubkey === pubkey)).concat(ev as NostrEvent).sort((a, b) => b.created_at - a.created_at));
        if (networkEnabled && canPublishToNetwork) publishViaRelay(ev as NostrEvent);
        setStatus("Unfollowed");
      } catch (e) {
        setStatus("Unfollow failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, pubkey, events, networkEnabled, canPublishToNetwork]
  );

  useEffect(() => {
    if (!actingIdentity || actingIdentity.type !== "nostr" || actingIdentity.category !== "nostr" || hasSyncedAnonRef.current) return;
    hasSyncedAnonRef.current = true;
    const sk = Nostr.hexToBytes(actingIdentity.privKeyHex);
    const anonPubkey = Nostr.getPublicKey(Nostr.hexToBytes(getOrCreateAnonKey(profile)));
    let cancelled = false;
    (async () => {
      const anonEvents = events.filter((e) => e.pubkey === anonPubkey);
      if (anonEvents.length === 0) return;
      const newEvents: NostrEvent[] = [];
      for (const ev of anonEvents) {
        if (cancelled) return;
        try {
          const content = ev.kind === 1 ? ensureStegstrSuffix(ev.content) : ev.content;
          const newEv = await Nostr.finishEventAsync(
            { kind: ev.kind, content, tags: ev.tags, created_at: ev.created_at },
            sk
          );
          publishViaRelay(newEv as NostrEvent);
          newEvents.push(newEv as NostrEvent);
        } catch (_) {}
      }
      if (!cancelled && newEvents.length > 0) {
        setEvents((prev) => {
          const withoutAnon = prev.filter((e) => e.pubkey !== anonPubkey);
          return [...withoutAnon, ...newEvents].sort((a, b) => b.created_at - a.created_at);
        });
        setStatus("Synced previous posts to Nostr");
      }
    })();
    return () => { cancelled = true; };
  }, [actingIdentity, events, profile]);

  // --- Shared NoteCard state & actions ---
  const noteCardState: NoteCardState = useMemo(() => ({
    profiles,
    selfPubkeys,
    getIdentityLabels: getIdentityLabelsForPubkey,
    hasLiked,
    hasBookmarked,
    getLikeCount,
    getZapCount,
  }), [profiles, selfPubkeys, getIdentityLabelsForPubkey, hasLiked, hasBookmarked, getLikeCount, getZapCount]);

  const navigateToProfile = useCallback((pk: string) => {
    setViewingProfilePubkey(pk);
    setView("profile");
  }, []);

  const noteCardActions: NoteCardActions = useMemo(() => ({
    onNavigateProfile: navigateToProfile,
    onReply: (ev: NostrEvent) => { setReplyingTo(ev); setReplyContent(""); },
    onLike: handleLike,
    onRepost: handleRepost,
    onZap: handleZap,
    onBookmark: handleBookmark,
    onUnbookmark: handleUnbookmark,
    onDelete: handleDelete,
  }), [navigateToProfile, handleLike, handleRepost, handleZap, handleBookmark, handleUnbookmark, handleDelete]);

  /** Actions for views that redirect reply to the feed. */
  const noteCardActionsRedirectReply: NoteCardActions = useMemo(() => ({
    ...noteCardActions,
    onReply: (ev: NostrEvent) => { setReplyingTo(ev); setReplyContent(""); setView("feed"); },
  }), [noteCardActions]);

  const handleReplyCancel = useCallback(() => { setReplyingTo(null); setReplyContent(""); }, []);

  return (
    <main className="app-root primal-layout">
      <header className="top-header">
        <h1 className="app-title">
          <img src={`${import.meta.env.BASE_URL}LOGO.png`} alt="" className="app-logo" />
          Stegstr
        </h1>
        <div className="header-actions">
          {isWeb() ? (
            <div className="network-toggle-wrap" title="The web version embeds and detects only. Download the desktop app to post and sync over relays.">
              <span className="network-off-notice">Web version: embed &amp; detect only — nothing leaves your browser. <a href="https://stegstr.com/downloads.html">Get the app</a> for relays.</span>
            </div>
          ) : (
          <div className="network-toggle-wrap">
            <span className="network-label">Network</span>
            <button
              type="button"
              role="switch"
              aria-checked={networkEnabled}
              className={`network-toggle ${networkEnabled ? "on" : "off"}`}
              onClick={() => setNetworkEnabled((v) => !v)}
            >
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span className="toggle-state off">OFF</span>
              <span className="toggle-state on">ON</span>
            </button>
            <span className="network-status">{networkEnabled ? "ON" : "OFF"}</span>
            {!networkEnabled && (
              <span className="network-off-notice" title="When Network is OFF, no data is sent over the internet. Detect and Embed run entirely in your browser.">
                No internet — local only. Detect &amp; Embed stay in your browser; nothing is sent.
              </span>
            )}
          </div>
          )}
          {actingIdentity && (
            <span className="acting-identity" title={`Acting as ${profiles[actingPubkey ?? ""]?.name || actingIdentity.label} (${(actingIdentity.category ?? (actingIdentity.type === "nostr" ? "nostr" : "local")) === "nostr" ? "Nostr" : "Local"})`}>
              as {profiles[actingPubkey ?? ""]?.name || actingIdentity.label} ({(actingIdentity.category ?? (actingIdentity.type === "nostr" ? "nostr" : "local")) === "nostr" ? "Nostr" : "Local"})
            </span>
          )}
          {queuedZaps.length > 0 && (
            <button
              type="button"
              className="queued-zaps"
              onClick={flushQueuedZaps}
              disabled={!networkEnabled || !canPublishToNetwork}
              title={networkEnabled ? "Send queued zaps now" : "Queued zaps will send when Network is ON"}
            >
              Queued zaps <span className="queued-zaps-count">{queuedZaps.length}</span>
              <span className="queued-zaps-label">{networkEnabled ? "Send now" : "Waiting"}</span>
            </button>
          )}
          {relayStatus && <span className="relay-status">{relayStatus}</span>}
        </div>
      </header>

      {view === "feed" && (
        <div className="search-bar-wrap">
          <input
            type="search"
            placeholder="Search by text, hashtags, npub or hex pubkey, or name…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && networkEnabled && relayRef.current && searchQuery.trim().length >= 2) {
                try {
                  relayRef.current.requestSearch(searchQuery.trim());
                  relayRef.current.requestProfileSearch(searchQuery.trim());
                } catch (err) {
                  console.error("[Stegstr] search on enter error", err);
                }
              }
            }}
            className="search-input"
          />
          {searchQuery.trim() && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearchQuery("")}
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      )}

      <div className="body-wrap">
        <aside className="sidebar left">
          <div className="profile-card">
            {myPicture ? (
              <img src={myPicture} alt="" className="profile-avatar" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} />
            ) : (
              <div className="profile-avatar placeholder">{myName.slice(0, 1)}</div>
            )}
            <strong className="profile-name">{myName}</strong>
            {myAbout && <p className="profile-about">{myAbout.slice(0, 120)}{myAbout.length > 120 ? "…" : ""}</p>}
            {isNostrLoggedIn ? (
              !myProfile?.name && !myProfile?.picture && !myProfile?.about ? (
                <>
                  <p className="profile-note muted">{networkEnabled ? "Fetching profile from relays…" : "Turn Network ON to fetch profile"}</p>
                  {networkEnabled && actingPubkey && (
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ marginTop: "0.5rem" }}
                      onClick={() => {
                        relayRef.current?.requestProfiles([actingPubkey]);
                        relayRef.current?.requestAuthor(actingPubkey);
                        setStatus("Refreshing profile…");
                      }}
                    >
                      Refresh profile
                    </button>
                  )}
                </>
              ) : (
                <p className="profile-note muted">From Nostr</p>
              )
            ) : (
              <p className="profile-note muted">Local identity · Add Nostr to sync</p>
            )}
            {isNostrLoggedIn ? (
              <p className="profile-note muted">Nostr profile is from relays. Update via a Nostr client.</p>
            ) : (
              <button type="button" className="btn-secondary" onClick={handleEditProfileOpen}>Edit profile</button>
            )}
          </div>
          <nav className="side-nav">
            <button type="button" className={view === "feed" ? "active" : ""} onClick={() => setView("feed")}>Home</button>
            <button type="button" className={view === "identity" ? "active" : ""} onClick={() => setView("identity")}>Identity</button>
            <button type="button" className={view === "notifications" ? "active" : ""} onClick={() => setView("notifications")}>Notifications{totalUnreadNotifCount > 0 && <span className="nav-badge">{totalUnreadNotifCount}</span>}</button>
            <button type="button" className={view === "messages" ? "active" : ""} onClick={() => setView("messages")}>Messages{totalUnreadDmCount > 0 && <span className="nav-badge">{totalUnreadDmCount}</span>}</button>
            <button type="button" className={view === "profile" ? "active" : ""} onClick={() => { setViewingProfilePubkey(null); setView("profile"); }}>Profile</button>
            <button type="button" className={view === "followers" ? "active" : ""} onClick={() => setView("followers")}>Following ({contactsSet.size})</button>
            <button type="button" className={view === "bookmarks" ? "active" : ""} onClick={() => setView("bookmarks")}>Bookmarks</button>
            <button type="button" className={view === "explore" ? "active" : ""} onClick={() => setView("explore")}>Explore</button>
            <button type="button" className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>Settings</button>
          </nav>
        </aside>

        <div className="main-content">
          {view === "feed" && (
            <FeedView
              myPicture={myPicture}
              myName={myName}
              newPost={newPost}
              setNewPost={setNewPost}
              postMediaUrls={postMediaUrls}
              setPostMediaUrls={setPostMediaUrls}
              uploadingMedia={uploadingMedia}
              postMediaInputRef={postMediaInputRef}
              handlePostMediaUpload={handlePostMediaUpload}
              handlePost={handlePost}
              feedFilter={feedFilter}
              setFeedFilter={setFeedFilter}
              notesEmpty={notes.length === 0}
              feedItems={feedItems}
              searchTrim={searchTrim}
              searchLower={searchLower}
              searchNoSpaces={searchNoSpaces}
              searchPubkeyHex={searchPubkeyHex}
              npubStr={npubStr}
              networkEnabled={networkEnabled}
              profiles={profiles}
              pubkey={pubkey}
              focusedNoteId={focusedNoteId}
              notes={notes}
              getRepliesTo={getRepliesTo}
              noteCardState={noteCardState}
              noteCardActions={noteCardActions}
              replyingTo={replyingTo}
              replyContent={replyContent}
              onReplyContentChange={setReplyContent}
              handleReply={handleReply}
              handleReplyCancel={handleReplyCancel}
              loadingMore={loadingMore}
              loadMoreSentinelRef={loadMoreSentinelRef}
              setViewingProfilePubkey={setViewingProfilePubkey}
              setView={setView}
            />
          )}

          {view === "messages" && (
            <MessagesView
              dmEvents={dmEvents}
              selfPubkeys={selfPubkeys}
              dmDecrypted={dmDecrypted}
              profiles={profiles}
              lastReadTimestamps={lastReadTimestamps}
              recentDmPartners={recentDmPartners}
              selectedMessagePeer={selectedMessagePeer}
              setSelectedMessagePeer={setSelectedMessagePeer}
              myName={myName}
              dmReplyContent={dmReplyContent}
              setDmReplyContent={setDmReplyContent}
              handleSendDm={handleSendDm}
              onNewMessage={() => setNewMessageModalOpen(true)}
            />
          )}

          {view === "followers" && (
            <FollowingView
              followingSearchInput={followingSearchInput}
              setFollowingSearchInput={setFollowingSearchInput}
              contactsSet={contactsSet}
              profiles={profiles}
              pubkey={pubkey}
              resolvePubkeyFromInput={resolvePubkeyFromInput}
              handleFollow={handleFollow}
              handleUnfollow={handleUnfollow}
              relayRef={relayRef}
              onStatus={setStatus}
              onNavigateProfile={(pk) => setViewingProfilePubkey(pk)}
              setView={setView}
            />
          )}

          {view === "explore" && (
            <ExploreView
              notes={exploreNotes}
              getRepliesTo={getRepliesTo}
              getLikeCount={getLikeCount}
              state={noteCardState}
              actions={noteCardActionsRedirectReply}
            />
          )}

          {view === "bookmarks" && (
            <BookmarksView
              notes={notes}
              bookmarkIds={bookmarkIds}
              deletedNoteIds={deletedNoteIds}
              getRepliesTo={getRepliesTo}
              state={noteCardState}
              actions={noteCardActionsRedirectReply}
            />
          )}

          {view === "notifications" && (
            <NotificationsView
              events={notificationEvents}
              profiles={profiles}
              onNavigateProfile={navigateToProfile}
              onViewPost={(noteId) => { setFocusedNoteId(noteId); setView("feed"); }}
            />
          )}

          {view === "profile" && pubkey && (
            <ProfileView
              viewingProfilePubkey={viewingProfilePubkey}
              setViewingProfilePubkey={setViewingProfilePubkey}
              profileViewPubkey={profileViewPubkey}
              profileDisplayKey={profileDisplayKey}
              profiles={profiles}
              myName={myName}
              myPicture={myPicture}
              myAbout={myAbout}
              myBanner={myBanner}
              myProfile={myProfile}
              isNostrLoggedIn={isNostrLoggedIn}
              contactsSet={contactsSet}
              profileRootNotes={profileRootNotes}
              profileReplies={profileReplies}
              profileFollowing={profileFollowing}
              profileFollowers={profileFollowers}
              profileTab={profileTab}
              setProfileTab={setProfileTab}
              getRepliesTo={getRepliesTo}
              getParentNote={getParentNote}
              noteCardState={noteCardState}
              noteCardActionsRedirectReply={noteCardActionsRedirectReply}
              navigateToProfile={navigateToProfile}
              handleFollow={handleFollow}
              handleUnfollow={handleUnfollow}
              handleEditProfileOpen={handleEditProfileOpen}
              onStatus={setStatus}
              setView={setView}
            />
          )}

          {view === "identity" && (
            <IdentityView
              identities={identities}
              setIdentities={setIdentities}
              profiles={profiles}
              viewingPubkeys={viewingPubkeys}
              setViewingPubkeys={setViewingPubkeys}
              actingPubkey={actingPubkey}
              setActingPubkey={setActingPubkey}
              showNsecFor={showNsecFor}
              setShowNsecFor={setShowNsecFor}
              networkEnabled={networkEnabled}
              relayRef={relayRef}
              onGenerate={handleGenerate}
              onLoginOpen={() => setLoginFormOpen(true)}
              onStatus={setStatus}
            />
          )}

          {view === "settings" && (
            <SettingsView
              identities={identities}
              profiles={profiles}
              relayUrls={relayUrls}
              setRelayUrls={setRelayUrls}
              newRelayUrl={newRelayUrl}
              setNewRelayUrl={setNewRelayUrl}
              muteInput={muteInput}
              setMuteInput={setMuteInput}
              mutedPubkeys={mutedPubkeys}
              setMutedPubkeys={setMutedPubkeys}
              mutedWords={mutedWords}
              setMutedWords={setMutedWords}
              resolvePubkeyFromInput={resolvePubkeyFromInput}
              onStatus={setStatus}
              referralCode={referralCode}
              setReferralCode={setReferralCode}
            />
          )}
        </div>

        <aside className="sidebar right">
          <div className="widget steganography-widget">
            <h3>Steganography</h3>
            <p className="muted">Detect image: load an image to extract data. Embed image: save your feed and messages to an image to share.</p>
            <div
              className={`stego-drop-zone${dragOverStego ? " drag-active" : ""}`}
              aria-label="Drop image here to detect"
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverStego(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverStego(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverStego(false);
                if (detecting) return;
                const file = e.dataTransfer.files?.[0];
                if (!file || !file.type.startsWith("image/")) {
                  setDecodeError("Please drop an image file (e.g. PNG).");
                  return;
                }
                if (isWeb()) {
                  handleLoadFromImage(file);
                  return;
                }
                const filePath = (file as File & { path?: string }).path;
                if (!filePath) {
                  setDecodeError("Drop failed: file path not available.");
                  return;
                }
                handleLoadFromImage(filePath);
              }}
            >
              <strong>Drop image here to detect</strong>
              <br /><span style={{fontSize: "0.8rem", color: "#888"}}>or click "Detect image" below</span>
            </div>
            {(detecting || embedding) && (
              <div className="stego-progress">
                <p className="muted detect-status">{stegoProgress || (detecting ? "Processing..." : "Embedding...")}</p>
                <div className="progress-bar"><div className="progress-bar-indeterminate"></div></div>
              </div>
            )}
            <div className="stego-actions">
              <button type="button" className="btn-stego" onClick={() => handleLoadFromImage()} disabled={detecting || embedding}>Detect image</button>
              <button type="button" className="btn-stego btn-primary" onClick={handleSaveToImage} disabled={detecting || embedding}>Embed image</button>
              {profile != null && !isWeb() && (
                <>
                  <button type="button" className="btn-stego btn-quick-test" onClick={handleDetectFromExchange} disabled={detecting} title="1-click: detect from /tmp/stegstr-test-exchange/exchange.png">Detect from exchange</button>
                  <button type="button" className="btn-stego btn-quick-test" onClick={handleEmbedToExchange} disabled={detecting} title="2-click: pick cover → save to exchange path">Embed to exchange</button>
                </>
              )}
            </div>
            {stegoLogs.length > 0 && (
              <div className="stego-log">
                <details>
                  <summary>Stego Log ({stegoLogs.length} entries)</summary>
                  <pre className="stego-log-content">{stegoLogs.join("\n")}</pre>
                </details>
              </div>
            )}
          </div>
        </aside>
      </div>

      {newMessageModalOpen && (
        <NewMessageModal
          onClose={() => setNewMessageModalOpen(false)}
          input={newMessagePubkeyInput}
          onInputChange={setNewMessagePubkeyInput}
          profiles={profiles}
          selfPubkeys={selfPubkeys}
          resolvePubkey={resolvePubkeyFromInput}
          onSelectPeer={setSelectedMessagePeer}
          onStatus={setStatus}
        />
      )}

      {loginFormOpen && (
        <LoginModal
          onClose={() => setLoginFormOpen(false)}
          nsec={nsec}
          onNsecChange={setNsec}
          onLogin={handleLogin}
          onGenerate={handleGenerate}
        />
      )}

      {embedModalOpen && (
        <EmbedModal
          onClose={() => setEmbedModalOpen(false)}
          onConfirm={handleEmbedConfirm}
          embedding={embedding}
          stegoProgress={stegoProgress}
          embedCoverFile={embedCoverFile}
          onCoverFileChange={setEmbedCoverFile}
          recipientMode={embedRecipientMode}
          onRecipientModeChange={setEmbedRecipientMode}
          recipientInput={embedRecipientInput}
          onRecipientInputChange={setEmbedRecipientInput}
          recipients={embedRecipients}
          onRecipientsChange={setEmbedRecipients}
          profiles={profiles}
          stegoMethod={embedMethod}
          onStegoMethodChange={setEmbedMethod}
          targetPlatform={targetPlatform}
          onTargetPlatformChange={setTargetPlatform}
          stegoMode={stegoMode}
          onStegoModeChange={setStegoMode}
        />
      )}

      {editProfileOpen && (
        <EditProfileModal
          onClose={() => setEditProfileOpen(false)}
          onSave={handleEditProfileSave}
          editName={editName}
          onEditNameChange={setEditName}
          editAbout={editAbout}
          onEditAboutChange={setEditAbout}
          editPicture={editPicture}
          onEditPictureChange={setEditPicture}
          privKeyHex={effectivePrivKey}
          onError={(msg) => { setStatus(msg); toast.error(msg); }}
          editBanner={editBanner}
          onEditBannerChange={setEditBanner}
        />
      )}

      {(status || decodeError) && (
        <p className={decodeError ? "error" : "status"}>{decodeError || status}</p>
      )}
      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </main>
  );
}

function AppBootstrap() {
  const [profile, setProfile] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const sync = getStorageProfileSync();
    if (sync != null) {
      setProfile(sync);
      return;
    }
    if (isWeb()) {
      setProfile(null);
      return;
    }
    getTauri()
      .then((t) => t.invoke<string | null>("get_test_profile"))
      .then((p) => setProfile(p ?? null))
      .catch(() => setProfile(null));
  }, []);
  if (profile === undefined) return <p className="muted" style={{ padding: "2rem" }}>Loading…</p>;
  return <App profile={profile} />;
}

export default AppBootstrap;
