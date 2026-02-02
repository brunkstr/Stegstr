import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as Nostr from "./nostr-stub";
import { connectRelays, publishEvent, DEFAULT_RELAYS, getRelayUrls } from "./relay";
import { extractImageUrls, mediaUrlsFromTags, isVideoUrl, contentWithoutImages, uint8ArrayToBase64 } from "./utils";
import { uploadMedia } from "./upload";
import { ensureStegstrSuffix, MAX_NOTE_USER_CONTENT } from "./constants";
import * as stegoCrypto from "./stego-crypto";
import * as logger from "./logger";
import type { NostrEvent, NostrStateBundle } from "./types";
import "./App.css";

const STEGSTR_BUNDLE_VERSION = 1;
const BASE_ANON_KEY = "stegstr_anon_key";
const BASE_IDENTITIES = "stegstr_identities";
const BASE_ACTING = "stegstr_acting_identity";
const BASE_VIEWING = "stegstr_viewing_identities";
const BASE_MUTE_PUBKEYS = "stegstr_mute_pubkeys";
const BASE_MUTE_WORDS = "stegstr_mute_words";
const BASE_RELAYS = "stegstr_relays";

function getStorageProfileSync(): string | null {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search).get("profile");
  if (p) return p;
  try {
    return localStorage.getItem("stegstr_test_profile");
  } catch { return null; }
}
function getStorageKey(base: string, profile: string | null | undefined): string {
  const prefix = profile ? `stegstr_test_${profile}_` : "";
  return prefix + base;
}

function getOrCreateAnonKey(profile?: string | null): string {
  const key = getStorageKey(BASE_ANON_KEY, profile);
  try {
    const stored = localStorage.getItem(key);
    if (stored && /^[a-fA-F0-9]{64}$/.test(stored)) return stored;
  } catch (_) {}
  const sk = Nostr.generateSecretKey();
  const hex = Nostr.bytesToHex(sk);
  try {
    localStorage.setItem(getStorageKey(BASE_ANON_KEY, profile), hex);
  } catch (_) {}
  return hex;
}

function loadIdentities(profile: string | null): IdentityEntry[] {
  try {
    const raw = localStorage.getItem(getStorageKey(BASE_IDENTITIES, profile));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (x): x is IdentityEntry =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as IdentityEntry).id === "string" &&
          typeof (x as IdentityEntry).privKeyHex === "string" &&
          /^[a-fA-F0-9]{64}$/.test((x as IdentityEntry).privKeyHex)
      )
      .map((x) => {
        const ent = x as IdentityEntry;
        if (ent.category !== "local" && ent.category !== "nostr") {
          return { ...ent, category: ent.type === "nostr" ? "nostr" as const : "local" as const };
        }
        return ent;
      });
  } catch (_) {}
  return [];
}

function migrateToIdentities(profile: string | null): IdentityEntry[] {
  const existing = loadIdentities(profile);
  if (existing.length > 0) return existing;
  const migrated: IdentityEntry[] = [];
  try {
    const anonKey = localStorage.getItem(getStorageKey(BASE_ANON_KEY, profile));
    if (anonKey && /^[a-fA-F0-9]{64}$/.test(anonKey)) {
      const pubkey = Nostr.getPublicKey(Nostr.hexToBytes(anonKey));
      migrated.push({
        id: "anon-" + pubkey.slice(0, 12),
        privKeyHex: anonKey,
        label: "Local",
        type: "local",
        category: "local",
      });
    }
  } catch (_) {}
  if (migrated.length > 0) {
    try {
      localStorage.setItem(getStorageKey(BASE_IDENTITIES, profile), JSON.stringify(migrated));
    } catch (_) {}
  }
  return migrated;
}

type View = "feed" | "messages" | "followers" | "notifications" | "profile" | "settings" | "bookmarks" | "explore" | "identity";

export type IdentityEntry = {
  id: string;
  privKeyHex: string;
  label: string;
  type: "local" | "nostr";
  /** local = data only steganographic (images); nostr = published to relays when Network ON. Convertible both ways. */
  category: "local" | "nostr";
  isPrivate?: boolean;
};

function App({ profile }: { profile: string | null }) {
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
  const [profiles, setProfiles] = useState<Record<string, { name?: string; about?: string; picture?: string; banner?: string; nip05?: string }>>({});
  const [newPost, setNewPost] = useState("");
  const [postMediaUrls, setPostMediaUrls] = useState<string[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [decodeError, setDecodeError] = useState<string>("");
  const [relayStatus, setRelayStatus] = useState<string>("");
  const [view, setView] = useState<View>("feed");
  const [replyingTo, setReplyingTo] = useState<NostrEvent | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editAbout, setEditAbout] = useState("");
  const [editPicture, setEditPicture] = useState("");
  const [editBanner, setEditBanner] = useState("");
  const [dmDecrypted, setDmDecrypted] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [embedModalOpen, setEmbedModalOpen] = useState(false);
  const [embedMode, setEmbedMode] = useState<"open" | "recipients">("open");
  const [embedSelectedPubkeys, setEmbedSelectedPubkeys] = useState<Set<string>>(new Set());
  const [selectedMessagePeer, setSelectedMessagePeer] = useState<string | null>(null);
  const [dmReplyContent, setDmReplyContent] = useState("");
  const [newMessagePubkeyInput, setNewMessagePubkeyInput] = useState("");
  const [newMessageModalOpen, setNewMessageModalOpen] = useState(false);
  const [viewingProfilePubkey, setViewingProfilePubkey] = useState<string | null>(null);
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
  const [importedEventIds, setImportedEventIds] = useState<Set<string>>(() => new Set());
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
  useEffect(() => {
    getRelayUrls().then((urls) => {
      setRelayUrls((prev) => {
        if (prev.length === DEFAULT_RELAYS.length && prev.every((u, i) => u === DEFAULT_RELAYS[i])) return urls;
        return prev;
      });
    });
  }, []);
  const [newRelayUrl, setNewRelayUrl] = useState("");
  const [feedFilter, setFeedFilter] = useState<"global" | "following">("global");
  const [detecting, setDetecting] = useState(false);
  const relayRef = useRef<ReturnType<typeof connectRelays> | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const editPfpInputRef = useRef<HTMLInputElement | null>(null);
  const editCoverInputRef = useRef<HTMLInputElement | null>(null);
  const postMediaInputRef = useRef<HTMLInputElement | null>(null);
  const loadingMoreRef = useRef(false);
  const eventBufferRef = useRef<NostrEvent[]>([]);
  const FLUSH_MS = 120;

  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(BASE_RELAYS, profile), JSON.stringify(relayUrls));
    } catch (_) {}
  }, [relayUrls, profile]);

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
  const contacts = Array.from(viewingPubkeys).flatMap((pk) => {
    const kind3 = events.find((e) => e.kind === 3 && e.pubkey === pk);
    return kind3 ? kind3.tags.filter((t) => t[0] === "p").map((t) => t[1]) : [];
  });
  const contactsSet = new Set(contacts);
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

  const profileViewPubkey = viewingProfilePubkey ?? profileDisplayKey;
  const profileRootNotes = rootNotes.filter((n) => n.pubkey === profileViewPubkey);
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
  const filteredRootNotes = searchTrim
    ? rootNotes.filter((n) => {
        if (searchPubkeyHex && n.pubkey.toLowerCase() === searchPubkeyHex) return true;
        const pkLower = n.pubkey.toLowerCase();
        const searchNoSpacesLower = searchNoSpaces.toLowerCase();
        if (/^[a-f0-9]{8,64}$/.test(searchNoSpacesLower) && pkLower.includes(searchNoSpacesLower)) return true;
        if (searchLower && pkLower.includes(searchLower)) return true;
        const authorName = profiles[n.pubkey]?.name?.toLowerCase() ?? "";
        if (authorName && authorName.includes(searchLower)) return true;
        if (n.content.toLowerCase().includes(searchLower)) return true;
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

  type FeedItem = { type: "note"; note: NostrEvent; sortAt: number } | { type: "repost"; repost: NostrEvent; note: NostrEvent; sortAt: number };
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
      relayUrls
    );
    const flush = () => {
      const batch = eventBufferRef.current;
      if (batch.length === 0) return;
      eventBufferRef.current = [];
      try {
        setEvents((prev) => {
          const byId = new Map(prev.map((e) => [e.id, e]));
          batch.forEach((e) => byId.set(e.id, e));
          return Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
        });
        const profileUpdates: Record<string, { name?: string; about?: string; picture?: string; banner?: string; nip05?: string }> = {};
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
          setProfiles((p) => ({ ...p, ...profileUpdates }));
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
  }, [networkEnabled, [...viewingPubkeys].join(","), relayUrls.join(",")]);

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
        relayRef.current?.requestMore(oldest);
        setTimeout(() => {
          loadingMoreRef.current = false;
        }, 2000);
      },
      { rootMargin: "200px", threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [networkEnabled, view, events.length]);

  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const toFetch = new Set<string>(contacts);
    notes.forEach((n) => toFetch.add(n.pubkey));
    if (toFetch.size > 0) relayRef.current.requestProfiles([...toFetch].slice(0, 300));
  }, [networkEnabled, [...contactsSet].join(","), notes.length]);

  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const ids = rootNotes.map((n) => n.id);
    if (ids.length > 0) relayRef.current.requestReplies(ids);
  }, [networkEnabled, rootNotes.map((n) => n.id).join(",")]);

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
  useEffect(() => {
    if (!networkEnabled || !relayRef.current || relayStatus !== "Synced") return;
    if (!actingPubkey || actingIdentity?.type !== "nostr") return;
    const haveProfile = profiles[actingPubkey]?.name || profiles[actingPubkey]?.picture || profiles[actingPubkey]?.about;
    if (haveProfile) return;
    relayRef.current.requestProfiles([actingPubkey]);
    relayRef.current.requestAuthor(actingPubkey);
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    for (const delay of [1500, 3500, 7000]) {
      timeouts.push(
        setTimeout(() => {
          relayRef.current?.requestProfiles([actingPubkey]);
          relayRef.current?.requestAuthor(actingPubkey);
        }, delay)
      );
    }
    return () => timeouts.forEach((t) => clearTimeout(t));
  }, [networkEnabled, relayStatus, actingPubkey, actingIdentity?.type, profiles]);

  // NIP-50: when user searches by text (not pubkey), ask relays for matching notes and profiles (debounced)
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const trimmed = searchQuery.trim();
    if (trimmed.length < 2) return;
    const isPubkey = /npub1[a-zA-Z0-9]+/i.test(trimmed.replace(/\s/g, "")) || /^[a-fA-F0-9]{64}$/.test(trimmed.replace(/\s/g, ""));
    if (isPubkey) return;
    const t = setTimeout(() => {
      relayRef.current?.requestSearch(trimmed);
      relayRef.current?.requestProfileSearch(trimmed);
      logger.logAction("search", "Search performed", { query: trimmed.slice(0, 50), networkEnabled });
    }, 500);
    return () => clearTimeout(t);
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
            publishEvent(ev, relayUrls);
          } catch (_) {}
        }, Math.floor(i / BATCH) * DELAY_MS);
      });
      return prev;
    });
  }, [networkEnabled, pubkey, relayUrls, canPublishToNetwork]);

  const dmEventIds = dmEvents.map((e) => e.id).join(",");
  useEffect(() => {
    if (dmEvents.length === 0) {
      setDmDecrypted({});
      return;
    }
    let cancelled = false;
    const next: Record<string, string> = {};
    (async () => {
      for (const ev of dmEvents) {
        if (cancelled) return;
        const weAreSender = selfPubkeys.includes(ev.pubkey);
        const ourPk = weAreSender ? ev.pubkey : ev.tags.find((t) => t[0] === "p")?.[1];
        const otherPubkey = weAreSender ? ev.tags.find((t) => t[0] === "p")?.[1] : ev.pubkey;
        if (!ourPk || !otherPubkey || !selfPubkeys.includes(ourPk)) {
          next[ev.id] = "[No peer]";
          continue;
        }
        const identityForPk = identities.find((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === ourPk);
        const privToUse = identityForPk?.privKeyHex ?? effectivePrivKey;
        try {
          const plain = await Nostr.nip04Decrypt(ev.content, privToUse, otherPubkey);
          if (!cancelled) next[ev.id] = plain;
        } catch {
          if (!cancelled) next[ev.id] = "[Decryption failed]";
        }
      }
      if (!cancelled) setDmDecrypted(next);
    })();
    return () => { cancelled = true; };
  }, [identities, effectivePrivKey, dmEventIds, selfPubkeys.join(",")]);

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

  const handleLoadFromImage = useCallback(async (providedPath?: string | null) => {
    setDecodeError("");
    const w = typeof window !== "undefined" ? window : (globalThis as unknown as Window);
    if (!(w as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      setDecodeError("Detect requires the Stegstr desktop app. Run: npm run tauri dev (not in a browser)");
      return;
    }
    let path: string | null;
    if (providedPath === undefined) {
      setDetecting(true);
      try {
        path = await openDialog({
          multiple: false,
          filters: [
            { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
            { name: "PNG", extensions: ["png"] },
            { name: "JPEG", extensions: ["jpg", "jpeg"] },
          ],
        });
      } finally {
        setDetecting(false);
      }
      if (!path || typeof path !== "string") {
        setStatus("Cancelled");
        logger.logAction("detect_cancelled", "User cancelled detect file dialog");
        return;
      }
    } else {
      path = providedPath;
      if (!path || typeof path !== "string") return;
    }
    setDetecting(true);
    logger.logAction("detect_started", "Decoding stego image", { path });
    try {
      const result = await invoke<{ ok: boolean; payload?: string; error?: string }>("decode_stego_image", { path });
      if (!result.ok || !result.payload) {
        const err = result.error || "Decode failed";
        setDecodeError(err);
        logger.logAction("detect_error", err, { path });
        return;
      }
      let jsonString: string;
      const raw = result.payload;
      if (raw.startsWith("base64:")) {
        const bytes = Uint8Array.from(atob(raw.slice(7)), (c) => c.charCodeAt(0));
        if (!stegoCrypto.isEncryptedPayload(bytes)) {
          setDecodeError("Not a Stegstr encrypted image");
          logger.logAction("detect_error", "Not a Stegstr encrypted image", { path });
          return;
        }
        let keysToTry = identities
          .filter((i) => viewingPubkeys.has(Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex))))
          .map((i) => i.privKeyHex);
        if (keysToTry.length === 0) keysToTry = [effectivePrivKey];
        let lastErr: Error | null = null;
        jsonString = "";
        for (const key of keysToTry) {
          try {
            jsonString = await stegoCrypto.decryptPayload(bytes, key);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e instanceof Error ? e : new Error(String(e));
          }
        }
        if (!jsonString && lastErr) {
          try {
            jsonString = await stegoCrypto.decryptApp(bytes);
            const parsed = JSON.parse(jsonString);
            if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.events)) lastErr = null;
          } catch (_) {}
        }
        if (!jsonString) throw lastErr ?? new Error("Decryption failed");
      } else if (raw.trimStart().startsWith("{")) {
        jsonString = raw;
      } else {
        setDecodeError("Invalid payload");
        logger.logAction("detect_error", "Invalid payload", { path });
        return;
      }
      const bundle = JSON.parse(jsonString) as NostrStateBundle;
      if (!Array.isArray(bundle.events)) {
        setDecodeError("Invalid payload");
        logger.logAction("detect_error", "Invalid payload (events not array)", { path });
        return;
      }
      const normalized = bundle.events.map((e) => ({
        ...e,
        kind: typeof e.kind === "number" ? e.kind : parseInt(String(e.kind), 10) || 1,
        created_at: typeof e.created_at === "number" ? e.created_at : Math.floor(Date.now() / 1000),
      }));
      setEvents((prev) => {
        const byId = new Map(prev.map((e) => [e.id, e]));
        normalized.forEach((e) => byId.set(e.id, e));
        return Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
      });
      const profileUpdates: Record<string, { name?: string; about?: string; picture?: string; banner?: string; nip05?: string }> = {};
      bundle.events.filter((e) => e.kind === 0).forEach((e) => {
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
        setProfiles((p) => ({ ...p, ...profileUpdates }));
      }
      setImportedEventIds((prev) => {
        const next = new Set(prev);
        bundle.events.forEach((e) => next.add(e.id));
        if (next.size > 2000) {
          const arr = [...next];
          arr.splice(0, arr.length - 2000);
          return new Set(arr);
        }
        return next;
      });
      setView("feed");
      setFeedFilter("global");
      setSearchQuery("");
      setStatus(`Loaded ${bundle.events.length} events`);
      logger.logAction("detect_completed", `Loaded ${bundle.events.length} events`, { path, eventCount: bundle.events.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTauriBridgeError = /undefined.*invoke|__TAURI_INTERNALS__/i.test(msg);
      setDecodeError(
        isTauriBridgeError
          ? "Detect requires the Stegstr desktop app. Run: npm run tauri dev (not in a browser)"
          : msg
      );
      logger.logError("Detect failed", e, { path });
    } finally {
      setDetecting(false);
    }
  }, [effectivePrivKey, identities, viewingPubkeys]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths?.length) {
          handleLoadFromImage(event.payload.paths[0]);
        }
      })
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, [handleLoadFromImage]);

  const handleSaveToImage = useCallback(() => {
    setDecodeError("");
    setEmbedModalOpen(true);
  }, []);

  const handleDetectFromExchange = useCallback(async () => {
    try {
      const path = await invoke<string>("get_exchange_path");
      handleLoadFromImage(path);
    } catch (e) {
      setDecodeError(e instanceof Error ? e.message : String(e));
    }
  }, [handleLoadFromImage]);

  const handleEmbedToExchange = useCallback(async () => {
    if (!profile) return;
    setDecodeError("");
    setDetecting(true);
    logger.logAction("embed_started", "Embed to exchange (quick test)", { eventCount: events.length });
    try {
      const coverPath = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (!coverPath || typeof coverPath !== "string") {
        setDetecting(false);
        return;
      }
      const outputPath = await invoke<string>("get_exchange_path");
      const bundle: NostrStateBundle = { version: STEGSTR_BUNDLE_VERSION, events };
      const jsonString = JSON.stringify(bundle);
      const encrypted = await stegoCrypto.encryptOpen(jsonString);
      const payloadToEmbed = "base64:" + uint8ArrayToBase64(encrypted);
      const result = await invoke<{ ok: boolean; path?: string; error?: string }>("encode_stego_image", {
        coverPath,
        outputPath,
        payload: payloadToEmbed,
      });
      if (result.ok && result.path) {
        setStatus(`Saved to exchange. B can click Detect from exchange.`);
        logger.logAction("embed_completed", "Embed to exchange done", { path: result.path, eventCount: events.length });
      } else {
        setDecodeError(result.error || "Encode failed");
      }
    } catch (e) {
      setDecodeError(e instanceof Error ? e.message : String(e));
      logger.logError("Embed to exchange failed", e, {});
    } finally {
      setDetecting(false);
    }
  }, [profile, events]);

  const handleEmbedConfirm = useCallback(async () => {
    if (!embedModalOpen) return;
    setDecodeError("");
    logger.logAction("embed_started", "Starting embed flow", { eventCount: events.length });
    try {
      const coverPath = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (!coverPath || typeof coverPath !== "string") {
        setEmbedModalOpen(false);
        return;
      }
      const coverName = coverPath.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "") || "image";
      let defaultPath = `${coverName}.png`;
      try {
        const desktop = await invoke<string>("get_desktop_path");
        if (desktop) defaultPath = `${desktop}/${coverName}.png`;
      } catch (_) {}
      const outputPath = await saveDialog({
        filters: [{ name: "PNG", extensions: ["png"] }],
        defaultPath,
      });
      if (!outputPath) {
        setEmbedModalOpen(false);
        return;
      }
      const finalOutputPath = outputPath.endsWith(".png") ? outputPath : outputPath + ".png";
      const pubkeysInEmbed = new Set(events.flatMap((e) => [e.pubkey, ...e.tags.filter((t) => t[0] === "p").map((t) => t[1])]));
      const kind0InEvents = new Set(events.filter((e) => e.kind === 0).map((e) => e.pubkey));
      const syntheticKind0: NostrEvent[] = [];
      for (const pk of pubkeysInEmbed) {
        if (!pk || kind0InEvents.has(pk)) continue;
        const idForPk = identities.find((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === pk);
        if (!idForPk) continue;
        const prof = profiles[pk];
        if (!prof) continue;
        try {
          const content = JSON.stringify(prof);
          const ev = await Nostr.finishEventAsync(
            { kind: 0, content, tags: [], created_at: Math.floor(Date.now() / 1000) },
            Nostr.hexToBytes(idForPk.privKeyHex)
          );
          syntheticKind0.push(ev as NostrEvent);
        } catch (_) {}
      }
      const bundle: NostrStateBundle = { version: STEGSTR_BUNDLE_VERSION, events: [...syntheticKind0, ...events] };
      const jsonString = JSON.stringify(bundle);
      let payloadToEmbed: string;
      if (embedMode === "open") {
        const encrypted = await stegoCrypto.encryptOpen(jsonString);
        payloadToEmbed = "base64:" + uint8ArrayToBase64(encrypted);
      } else {
        const recipients = Array.from(embedSelectedPubkeys);
        if (pubkey && !recipients.includes(pubkey)) recipients.push(pubkey);
        if (recipients.length === 0) {
          setDecodeError("Select at least one recipient or use “Any Stegstr user”");
          return;
        }
        const encrypted = await stegoCrypto.encryptForRecipients(jsonString, effectivePrivKey, recipients);
        payloadToEmbed = "base64:" + uint8ArrayToBase64(encrypted);
      }
      const result = await invoke<{ ok: boolean; path?: string; error?: string }>("encode_stego_image", {
        coverPath,
        outputPath: finalOutputPath,
        payload: payloadToEmbed,
      });
      setEmbedModalOpen(false);
      if (result.ok && result.path) {
        setStatus(`Saved to ${result.path}. Finder opened.`);
        logger.logAction("embed_completed", "Embed saved successfully", { path: result.path, eventCount: events.length });
        try {
          await invoke("reveal_in_finder", { path: result.path });
        } catch (_) {}
      } else {
        const err = result.error || "Encode failed";
        setDecodeError(err);
        logger.logAction("embed_error", err, { coverPath, outputPath: finalOutputPath });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDecodeError(msg);
      logger.logError("Embed failed", e, {});
      setEmbedModalOpen(false);
    }
  }, [embedModalOpen, embedMode, embedSelectedPubkeys, events, pubkey, effectivePrivKey, profiles, identities]);

  const toggleEmbedRecipient = useCallback((pk: string) => {
    setEmbedSelectedPubkeys((prev) => {
      const next = new Set(prev);
      if (next.has(pk)) next.delete(pk);
      else next.add(pk);
      return next;
    });
  }, []);

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
        if (networkEnabled && canPublishToNetwork) publishEvent(ev as NostrEvent, relayUrls);
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
    const tags: string[][] = postMediaUrls.flatMap((url) => [["im", url]]);
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
    if (networkEnabled && canPublishToNetwork) publishEvent(ev as NostrEvent, relayUrls);
    setStatus("Posted");
    logger.logAction("post", "Posted note", { networkEnabled, contentLength: content.length, mediaCount: postMediaUrls.length });
  }, [effectivePrivKey, newPost, postMediaUrls, networkEnabled, canPublishToNetwork]);

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
        if (networkEnabled && canPublishToNetwork) publishEvent(ev as NostrEvent, relayUrls);
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
        if (networkEnabled && canPublishToNetwork) publishEvent(ev as NostrEvent, relayUrls);
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
        if (networkEnabled && canPublishToNetwork) publishEvent(ev as NostrEvent, relayUrls);
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
        if (networkEnabled && canPublishToNetwork) publishEvent(ev as NostrEvent, relayUrls);
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
        if (networkEnabled && canPublishToNetwork) publishEvent(ev as NostrEvent, relayUrls);
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
        const tags: string[][] = [["e", rootId], ["e", replyingTo.id], ["p", replyingTo.pubkey]];
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
        if (networkEnabled && canPublishToNetwork) publishEvent(ev as NostrEvent, relayUrls);
        setStatus("Replied");
        logger.logAction("reply", "Replied to note", { rootId, networkEnabled });
      } catch (e) {
        setStatus("Reply failed: " + (e instanceof Error ? e.message : String(e)));
        logger.logError("Reply failed", e, { rootId });
      }
    },
    [effectivePrivKey, replyingTo, replyContent, networkEnabled, canPublishToNetwork, getRootId]
  );

  const handleEditProfileOpen = useCallback(() => {
    setEditName(myName);
    setEditAbout(myAbout);
    setEditPicture(myPicture ?? "");
    setEditBanner(myBanner ?? "");
    setEditProfileOpen(true);
  }, [myName, myAbout, myPicture, myBanner]);

  const handleEditProfileSave = useCallback(async () => {
    if (!effectivePrivKey || !pubkey) return;
    const sk = Nostr.hexToBytes(effectivePrivKey);
    const content = JSON.stringify({
      name: editName.trim() || undefined,
      about: editAbout.trim() || undefined,
      picture: editPicture.trim() || undefined,
      banner: editBanner.trim() || undefined,
    });
    const ev = await Nostr.finishEventAsync(
      {
        kind: 0,
        content,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk
    );
    setEvents((prev) => {
      const byId = new Map(prev.map((e) => [e.id, e]));
      byId.set(ev.id, ev as NostrEvent);
      return Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
    });
    setProfiles((p) => ({
      ...p,
      [(ev as NostrEvent).pubkey]: {
        name: editName.trim() || undefined,
        about: editAbout.trim() || undefined,
        picture: editPicture.trim() || undefined,
        banner: editBanner.trim() || undefined,
      },
    }));
    setEditProfileOpen(false);
    // Never publish kind 0 for Nostr identities—their profile lives on Nostr; publishing would overwrite it
    const isNostr = actingIdentity?.type === "nostr";
    if (networkEnabled && canPublishToNetwork && !isNostr) publishEvent(ev as NostrEvent, relayUrls);
    setStatus(isNostr ? "Profile updated (local only)" : "Profile updated");
    logger.logAction("profile_edit", isNostr ? "Profile updated (local only)" : "Profile updated", { networkEnabled, isNostr });
  }, [effectivePrivKey, pubkey, editName, editAbout, editPicture, editBanner, networkEnabled, canPublishToNetwork, actingIdentity?.type]);

  const handleEditPfpUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith("image/")) {
      setStatus("Select an image file (jpg, png, gif, webp)");
      return;
    }
    e.target.value = "";
    setStatus("Uploading…");
    try {
      const url = await uploadMedia(file);
      setEditPicture(url);
      setStatus("Picture uploaded");
    } catch (err) {
      setStatus("Upload failed: " + (err instanceof Error ? err.message : String(err)));
    }
  }, []);

  const handleEditCoverUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith("image/")) {
      setStatus("Select an image file (jpg, png, gif, webp)");
      return;
    }
    e.target.value = "";
    setStatus("Uploading…");
    try {
      const url = await uploadMedia(file);
      setEditBanner(url);
      setStatus("Cover uploaded");
    } catch (err) {
      setStatus("Upload failed: " + (err instanceof Error ? err.message : String(err)));
    }
  }, []);

  const handlePostMediaUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    e.target.value = "";
    setUploadingMedia(true);
    setStatus("Uploading…");
    try {
      const urls: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
          const url = await uploadMedia(file);
          urls.push(url);
        }
      }
      setPostMediaUrls((prev) => [...prev, ...urls]);
      setStatus(urls.length ? `Uploaded ${urls.length} file(s)` : "Select image or video files");
    } catch (err) {
      setStatus("Upload failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setUploadingMedia(false);
    }
  }, []);

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
        if (networkEnabled && canPublishToNetwork) publishEvent(ev as NostrEvent, relayUrls);
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
        if (networkEnabled && canPublishToNetwork) publishEvent(ev as NostrEvent, relayUrls);
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
          publishEvent(newEv as NostrEvent, relayUrls);
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

  return (
    <main className="app-root primal-layout">
      <header className="top-header">
        <h1 className="app-title">
          <img src="/LOGO.png" alt="" className="app-logo" />
          Stegstr
        </h1>
        <div className="header-actions">
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
          </div>
          {actingIdentity && (
            <span className="acting-identity" title={`Acting as ${profiles[actingPubkey ?? ""]?.name || actingIdentity.label}`}>
              as {profiles[actingPubkey ?? ""]?.name || actingIdentity.label}
            </span>
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
            className="search-input"
          />
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
            <button type="button" className={view === "notifications" ? "active" : ""} onClick={() => setView("notifications")}>Notifications</button>
            <button type="button" className={view === "messages" ? "active" : ""} onClick={() => setView("messages")}>Messages</button>
            <button type="button" className={view === "profile" ? "active" : ""} onClick={() => { setViewingProfilePubkey(null); setView("profile"); }}>Profile</button>
            <button type="button" className={view === "followers" ? "active" : ""} onClick={() => setView("followers")}>Following</button>
            <button type="button" className={view === "bookmarks" ? "active" : ""} onClick={() => setView("bookmarks")}>Bookmarks</button>
            <button type="button" className={view === "explore" ? "active" : ""} onClick={() => setView("explore")}>Explore</button>
            <button type="button" className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>Settings</button>
          </nav>
        </aside>

        <div className="main-content">
          {view === "feed" && (
            <>
              <section className="compose-section">
                <div className="compose-avatar">
                  {myPicture ? <img src={myPicture} alt="" /> : <span>{myName.slice(0, 1)}</span>}
                </div>
                <div className="compose-body">
                  <textarea
                    placeholder="What's happening?"
                    value={newPost}
                    onChange={(e) => setNewPost(e.target.value)}
                    rows={3}
                    className="wide"
                    maxLength={MAX_NOTE_USER_CONTENT}
                  />
                  {postMediaUrls.length > 0 && (
                    <div className="post-media-preview">
                      {postMediaUrls.map((url, i) => (
                        <span key={i} className="post-media-item">
                          {url.match(/\.(gif|jpg|jpeg|png|webp)(\?|$)/i) ? (
                            <img src={url} alt="" />
                          ) : (
                            <a href={url} target="_blank" rel="noreferrer">{url.slice(0, 40)}…</a>
                          )}
                          <button type="button" className="btn-remove muted" onClick={() => setPostMediaUrls((p) => p.filter((_, j) => j !== i))}>×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="compose-actions">
                    <input ref={postMediaInputRef} type="file" accept="image/*,video/*" multiple className="hidden-input" onChange={handlePostMediaUpload} />
                    <button type="button" className="btn-secondary" onClick={() => postMediaInputRef.current?.click()} disabled={uploadingMedia} title="Add photo or video">
                      {uploadingMedia ? "Uploading…" : "Attach"}
                    </button>
                    <button type="button" onClick={handlePost} className="btn-primary" disabled={(!newPost.trim() && postMediaUrls.length === 0) || uploadingMedia}>Post</button>
                  </div>
                  <p className="muted char-counter">{newPost.length}/{MAX_NOTE_USER_CONTENT} (appends &quot; Sent by Stegstr.&quot;)</p>
                </div>
              </section>

              <section className="feed-section">
                <div className="feed-header-row">
                  <h2 className="feed-title">Feed</h2>
                  <div className="feed-filter-tabs">
                    <button type="button" className={feedFilter === "global" ? "active" : ""} onClick={() => setFeedFilter("global")}>Global</button>
                    <button type="button" className={feedFilter === "following" ? "active" : ""} onClick={() => setFeedFilter("following")}>Following</button>
                  </div>
                </div>
                {notes.length === 0 && (
                  <p className="muted">No notes yet. Turn Network ON for relay feed, or load from image.</p>
                )}
                {searchTrim && (
                  <>
                    {(() => {
                      const profileMatches = Object.entries(profiles).filter(
                        ([pk, p]) => pk !== pubkey &&
                          ((searchPubkeyHex && pk === searchPubkeyHex) ||
                            p?.name?.toLowerCase().includes(searchLower) ||
                            p?.nip05?.toLowerCase().includes(searchLower) ||
                            pk.toLowerCase().includes(searchNoSpaces.toLowerCase()))
                      );
                      if (searchPubkeyHex && profileMatches.length === 0 && feedItems.length === 0 && !profiles[searchPubkeyHex]) {
                        return (
                          <div className="profile-result-card">
                            <p className="muted">No notes from this pubkey. View profile to follow.</p>
                            <button type="button" className="btn-primary" onClick={() => { setViewingProfilePubkey(searchPubkeyHex); setView("profile"); }}>
                              View profile ({searchPubkeyHex.slice(0, 12)}…)
                            </button>
                          </div>
                        );
                      }
                      if (profileMatches.length > 0) {
                        return (
                          <div className="search-profiles-section">
                            <h3 className="search-section-title">Profiles</h3>
                            <ul className="profile-result-list">
                              {profileMatches.slice(0, 10).map(([pk, p]) => (
                                <li key={pk} className="profile-result-item">
                                  {p?.picture ? <img src={p.picture} alt="" className="contact-avatar" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span className="contact-avatar placeholder">{(p?.name ?? pk).slice(0, 2)}</span>}
                                  <div className="profile-result-info">
                                    <strong>{p?.name ?? `${pk.slice(0, 12)}…`}</strong>
                                    {p?.nip05 && <span className="muted"> {p.nip05}</span>}
                                  </div>
                                  <button type="button" className="btn-primary" onClick={() => { setViewingProfilePubkey(pk); setView("profile"); }}>View profile</button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        );
                      }
                      if (feedItems.length === 0) {
                        return (
                          <p className="muted">
                            {searchPubkeyHex || npubStr
                      ? networkEnabled
                        ? "No notes from this pubkey yet. If we just fetched, wait a moment; otherwise they may have no public notes on these relays."
                        : "Turn Network ON to fetch this pubkey’s notes from relays, or load an image that contains their posts."
                      : "No notes match your search."}
                          </p>
                        );
                      }
                      return null;
                    })()}
                  </>
                )}
                <ul className="note-list">
                  {(() => {
                    const rootIdForFocus = focusedNoteId
                      ? (() => {
                          const n = notes.find((n) => n.id === focusedNoteId);
                          if (n) {
                            const eTag = n.tags.find((t) => t[0] === "e");
                            return eTag?.[1] ?? n.id;
                          }
                          return focusedNoteId;
                        })()
                      : null;
                    const feedItemsSorted: FeedItem[] = !rootIdForFocus
                      ? feedItems
                      : [...feedItems].sort((a, b) => {
                          const aId = a.type === "note" ? a.note.id : a.note.id;
                          const bId = b.type === "note" ? b.note.id : b.note.id;
                          if (aId === rootIdForFocus) return -1;
                          if (bId === rootIdForFocus) return 1;
                          return b.sortAt - a.sortAt;
                        });
                    return feedItemsSorted.map((item) => {
                    const ev = item.type === "note" ? item.note : item.note;
                    const replies = getRepliesTo(ev.id).sort((a, b) => a.created_at - b.created_at);
                    const likeCount = getLikeCount(ev.id);
                    const isFocused = rootIdForFocus && ev.id === rootIdForFocus;
                    return (
                      <li key={item.type === "repost" ? item.repost.id : ev.id} className={`note-thread${isFocused ? " focused" : ""}`}>
                        {item.type === "repost" && (
                          <p className="repost-label muted">
                            <button type="button" className="link-like" onClick={() => { setViewingProfilePubkey(item.repost.pubkey); setView("profile"); }}>
                              {(profiles[item.repost.pubkey]?.name ?? `${item.repost.pubkey.slice(0, 8)}…`)}
                            </button>
                            {" reposted"}
                          </p>
                        )}
                        <div className="note-card">
                          <div className="note-avatar">
                            {profiles[ev.pubkey]?.picture ? (
                              <img src={profiles[ev.pubkey].picture!} alt="" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                            ) : (
                              <span>{(profiles[ev.pubkey]?.name || ev.pubkey).slice(0, 1)}</span>
                            )}
                          </div>
                          <div className="note-body">
                            <div className="note-meta">
                              <strong>
                                <button type="button" className="link-like" onClick={() => { setViewingProfilePubkey(ev.pubkey); setView("profile"); }}>
                                  {(profiles[ev.pubkey]?.name ?? `${ev.pubkey.slice(0, 8)}…`)}
                                </button>
                                {selfPubkeys.includes(ev.pubkey) && getIdentityLabelsForPubkey(ev.pubkey).map((l) => (
                                  <span key={l} className="event-identity-tag">{l}</span>
                                ))}
                              </strong>
                              <span className="note-time">{new Date(ev.created_at * 1000).toLocaleString()}</span>
                            </div>
                            <div className="note-content">
                              {(contentWithoutImages(ev.content).trim() || ev.content.trim()) && (
                                <p>{contentWithoutImages(ev.content).trim() || ev.content}</p>
                              )}
                              {(() => {
                                const tagMedia = mediaUrlsFromTags(ev.tags);
                                const contentUrls = extractImageUrls(ev.content);
                                const urls = tagMedia.length > 0 ? tagMedia : contentUrls;
                                if (urls.length === 0) return null;
                                return (
                                  <div className="note-images">
                                    {urls.slice(0, 4).map((url, i) =>
                                      isVideoUrl(url) ? (
                                        <video key={i} src={url} controls className="note-img note-video" />
                                      ) : (
                                        <img key={i} src={url} alt="" className="note-img" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                                      )
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                            <div className="note-actions">
                              <button type="button" onClick={() => { setReplyingTo(ev); setReplyContent(""); }} title="Reply">Reply</button>
                              <button type="button" onClick={() => !hasLiked(ev.id) && handleLike(ev)} title="Like" disabled={!!hasLiked(ev.id)}>{hasLiked(ev.id) ? "Liked" : "Like"} <span className="count">({likeCount})</span></button>
                              <button type="button" onClick={() => handleRepost(ev)} title="Repost">Repost</button>
                              <button type="button" onClick={() => window.open(`https://zap.stream/e/${ev.id}`, "_blank", "noopener")} title="Zap (opens zap.stream)">Zap <span className="count">({getZapCount(ev.id)})</span></button>
                              <button type="button" onClick={() => hasBookmarked(ev.id) ? handleUnbookmark(ev) : handleBookmark(ev)} title={hasBookmarked(ev.id) ? "Remove bookmark" : "Bookmark"}>{hasBookmarked(ev.id) ? "Unbookmark" : "Bookmark"}</button>
                              {selfPubkeys.includes(ev.pubkey) && <button type="button" className="btn-delete muted" onClick={() => handleDelete(ev)} title="Delete">Delete</button>}
                            </div>
                          </div>
                        </div>
                        {replyingTo?.id === ev.id && (
                          <div className="reply-box">
                            <p className="muted">Replying to {(profiles[replyingTo.pubkey]?.name ?? replyingTo.pubkey.slice(0, 8))}…</p>
                            <textarea value={replyContent} onChange={(e) => setReplyContent(e.target.value)} placeholder="Write a reply…" rows={2} className="wide" maxLength={MAX_NOTE_USER_CONTENT} />
                            <p className="muted char-counter">{replyContent.length}/{MAX_NOTE_USER_CONTENT}</p>
                            <div className="row">
                              <button type="button" onClick={() => { setReplyingTo(null); setReplyContent(""); }}>Cancel</button>
                              <button type="button" onClick={handleReply} className="btn-primary">Reply</button>
                            </div>
                          </div>
                        )}
                        {replies.length > 0 && (
                          <ul className="note-replies">
                            {replies.map((reply) => {
                              const replyLikeCount = getLikeCount(reply.id);
                              return (
                              <li key={reply.id} className="note-card note-reply">
                                <div className="note-avatar">
                                  {profiles[reply.pubkey]?.picture ? (
                                    <img src={profiles[reply.pubkey].picture!} alt="" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                                  ) : (
                                    <span>{(profiles[reply.pubkey]?.name || reply.pubkey).slice(0, 1)}</span>
                                  )}
                                </div>
                                <div className="note-body">
                                  <div className="note-meta">
                                    <strong>
                                      <button type="button" className="link-like" onClick={() => { setViewingProfilePubkey(reply.pubkey); setView("profile"); }}>
                                        {(profiles[reply.pubkey]?.name ?? `${reply.pubkey.slice(0, 8)}…`)}
                                        {selfPubkeys.includes(reply.pubkey) && getIdentityLabelsForPubkey(reply.pubkey).map((l) => (
                                          <span key={l} className="event-identity-tag">{l}</span>
                                        ))}
                                      </button>
                                    </strong>
                                    <span className="note-time">{new Date(reply.created_at * 1000).toLocaleString()}</span>
                                  </div>
                                  <div className="note-content">
                                    <p>{contentWithoutImages(reply.content).trim() || reply.content}</p>
                                  </div>
                                  <div className="note-actions">
                                    <button type="button" onClick={() => { setReplyingTo(reply); setReplyContent(""); }} title="Reply">Reply</button>
                                    <button type="button" onClick={() => !hasLiked(reply.id) && handleLike(reply)} title="Like" disabled={!!hasLiked(reply.id)}>{hasLiked(reply.id) ? "Liked" : "Like"} <span className="count">({replyLikeCount})</span></button>
                                    <button type="button" onClick={() => handleRepost(reply)} title="Repost">Repost</button>
                                    <button type="button" onClick={() => window.open(`https://zap.stream/e/${reply.id}`, "_blank", "noopener")} title="Zap (opens zap.stream)">Zap <span className="count">({getZapCount(reply.id)})</span></button>
                                    <button type="button" onClick={() => hasBookmarked(reply.id) ? handleUnbookmark(reply) : handleBookmark(reply)} title={hasBookmarked(reply.id) ? "Remove bookmark" : "Bookmark"}>{hasBookmarked(reply.id) ? "Unbookmark" : "Bookmark"}</button>
                                    {selfPubkeys.includes(reply.pubkey) && <button type="button" className="btn-delete muted" onClick={() => handleDelete(reply)} title="Delete">Delete</button>}
                                  </div>
                                </div>
                                {replyingTo?.id === reply.id && (
                                  <div className="reply-box reply-box-inline">
                                    <p className="muted">Replying to {(profiles[replyingTo.pubkey]?.name ?? replyingTo.pubkey.slice(0, 8))}…</p>
                                    <textarea value={replyContent} onChange={(e) => setReplyContent(e.target.value)} placeholder="Write a reply…" rows={2} className="wide" maxLength={MAX_NOTE_USER_CONTENT} />
                                    <p className="muted char-counter">{replyContent.length}/{MAX_NOTE_USER_CONTENT}</p>
                                    <div className="row">
                                      <button type="button" onClick={() => { setReplyingTo(null); setReplyContent(""); }}>Cancel</button>
                                      <button type="button" onClick={handleReply} className="btn-primary">Reply</button>
                                    </div>
                                  </div>
                                )}
                              </li>
                            );})}
                          </ul>
                        )}
                      </li>
                    );
                  });
                  })()}
                  <li key="load-more-sentinel" aria-hidden="true">
                    <div ref={loadMoreSentinelRef} style={{ height: 1, visibility: "hidden" }} />
                  </li>
                </ul>
              </section>
            </>
          )}

          {view === "messages" && (
            <section className="messages-view">
              <h2>Messages</h2>
              <p className="muted">Nostr DMs when Network is ON; you can also message any pubkey (npub or hex) and share via Embed image.</p>
              <div className="messages-layout">
                <div className="conversation-list-wrap">
                  <button type="button" className="btn-new-message btn-primary" onClick={() => setNewMessageModalOpen(true)}>New message</button>
                  <ul className="conversation-list">
                    {recentDmPartners.map(({ pubkey: pk }) => {
                      const thread = dmEvents
                        .filter((ev) => {
                          const other = selfPubkeys.includes(ev.pubkey) ? ev.tags.find((t) => t[0] === "p")?.[1] : ev.pubkey;
                          return other === pk;
                        })
                        .sort((a, b) => a.created_at - b.created_at);
                      const last = thread[thread.length - 1];
                      const preview = last ? (dmDecrypted[last.id] ?? "[Decrypting…]").slice(0, 60) : "";
                      const name = profiles[pk]?.name ?? `${pk.slice(0, 8)}…`;
                      return (
                        <li key={pk} className={selectedMessagePeer === pk ? "active" : ""}>
                          <button type="button" className="conversation-item" onClick={() => setSelectedMessagePeer(pk)}>
                            <span className="conversation-name">{name}</span>
                            <span className="conversation-preview muted">{preview || "No messages"}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {recentDmPartners.length === 0 && (
                    <p className="muted">No conversations yet. Use New message to start one (npub or hex pubkey).</p>
                  )}
                </div>
                <div className="thread-wrap">
                  {selectedMessagePeer ? (() => {
                    const peerPk = selectedMessagePeer;
                    const thread = dmEvents
                      .filter((ev) => {
                        const other = selfPubkeys.includes(ev.pubkey) ? ev.tags.find((t) => t[0] === "p")?.[1] : ev.pubkey;
                        return other === peerPk;
                      })
                      .sort((a, b) => a.created_at - b.created_at);
                    const peerName = profiles[peerPk]?.name ?? `${peerPk.slice(0, 8)}…${peerPk.slice(-4)}`;
                    return (
                      <>
                        <div className="thread-header">
                          <strong>Conversation with {peerName}</strong>
                          <button type="button" className="btn-back" onClick={() => setSelectedMessagePeer(null)}>← Back</button>
                        </div>
                        <ul className="thread-messages">
                          {thread.map((ev) => {
                            const isFromThem = !selfPubkeys.includes(ev.pubkey);
                            const content = dmDecrypted[ev.id] ?? "[Decrypting…]";
                            const senderName = isFromThem ? (profiles[ev.pubkey]?.name ?? `${ev.pubkey.slice(0, 8)}…`) : myName;
                            return (
                              <li key={ev.id} className={isFromThem ? "msg-from" : "msg-to"}>
                                <span className="msg-meta">{isFromThem ? "From" : "To"} {senderName} · {new Date(ev.created_at * 1000).toLocaleString()}</span>
                                <p className="msg-content">{content}</p>
                              </li>
                            );
                          })}
                        </ul>
                        <div className="thread-reply">
                          <textarea value={dmReplyContent} onChange={(e) => setDmReplyContent(e.target.value)} placeholder={`Reply to ${peerName}…`} rows={2} className="wide" />
                          <button type="button" className="btn-primary" onClick={() => handleSendDm(peerPk, dmReplyContent)}>Send</button>
                        </div>
                      </>
                    );
                  })() : (
                    <p className="muted">Select a conversation or start a New message.</p>
                  )}
                </div>
              </div>
            </section>
          )}

          {view === "followers" && (
            <section className="followers-view">
              <h2>Following</h2>
              <p className="muted">From your Nostr contact list (kind 3). Unfollow to remove; search below to add by npub, hex pubkey, or name.</p>
              <div className="following-add-wrap">
                <input
                  type="text"
                  placeholder="npub, hex pubkey, or name to follow…"
                  value={followingSearchInput}
                  onChange={(e) => setFollowingSearchInput(e.target.value)}
                  className="wide"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const pk = resolvePubkeyFromInput(followingSearchInput);
                      if (pk) { handleFollow(pk); setFollowingSearchInput(""); relayRef.current?.requestProfiles([pk]); }
                      else if (followingSearchInput.trim()) {
                        const matches = Object.entries(profiles).filter(
                          ([pk, p]) => pk !== pubkey && !contactsSet.has(pk) &&
                            (p?.name?.toLowerCase().includes(followingSearchInput.trim().toLowerCase()) ||
                              p?.nip05?.toLowerCase().includes(followingSearchInput.trim().toLowerCase()))
                        );
                        if (matches.length === 0) setStatus("No match. Enter npub, hex pubkey, or try a name from your feed.");
                      }
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    const pk = resolvePubkeyFromInput(followingSearchInput);
                    if (pk) { handleFollow(pk); setFollowingSearchInput(""); relayRef.current?.requestProfiles([pk]); }
                    else if (followingSearchInput.trim()) {
                      const matches = Object.entries(profiles).filter(
                        ([pk, p]) => pk !== pubkey && !contactsSet.has(pk) &&
                          (p?.name?.toLowerCase().includes(followingSearchInput.trim().toLowerCase()) ||
                            p?.nip05?.toLowerCase().includes(followingSearchInput.trim().toLowerCase()))
                      );
                      if (matches.length === 0) setStatus("No match. Enter npub, hex pubkey, or try a name from your feed.");
                    }
                  }}
                >
                  Add
                </button>
              </div>
              {followingSearchInput.trim() && !resolvePubkeyFromInput(followingSearchInput) && (() => {
                const matches = Object.entries(profiles).filter(
                  ([pk, p]) => pk !== pubkey && !contactsSet.has(pk) &&
                    (p?.name?.toLowerCase().includes(followingSearchInput.trim().toLowerCase()) ||
                      p?.nip05?.toLowerCase().includes(followingSearchInput.trim().toLowerCase()))
                );
                if (matches.length === 0) return null;
                return (
                  <div className="search-results profiles-search">
                    <p className="muted">Profiles matching &quot;{followingSearchInput.trim()}&quot;</p>
                    <ul className="contact-list">
                      {matches.map(([pk, p]) => (
                        <li key={pk} className="contact-list-item">
                          {p?.picture ? <img src={p.picture} alt="" className="contact-avatar" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span className="contact-avatar placeholder">{(p?.name ?? pk).slice(0, 2)}</span>}
                          <button type="button" className="link-like" onClick={() => { setViewingProfilePubkey(pk); setView("profile"); }}>
                            {p?.name ?? `${pk.slice(0, 12)}…`}
                          </button>
                          <button type="button" className="btn-primary" onClick={() => { handleFollow(pk); setFollowingSearchInput(""); relayRef.current?.requestProfiles([pk]); setStatus("Following"); }}>Add</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })()}
              <ul className="contact-list">
                {[...contactsSet].map((pk) => (
                  <li key={pk} className="contact-list-item">
                    {profiles[pk]?.picture ? <img src={profiles[pk].picture!} alt="" className="contact-avatar" /> : <span className="contact-avatar placeholder">{pk.slice(0, 2)}</span>}
                    <button type="button" className="link-like" onClick={() => { setViewingProfilePubkey(pk); setView("profile"); }}>
                      {profiles[pk]?.name ?? `${pk.slice(0, 12)}…`}
                    </button>
                    <button type="button" className="btn-unfollow btn-secondary" onClick={() => handleUnfollow(pk)} title="Unfollow">Unfollow</button>
                  </li>
                ))}
              </ul>
              {contactsSet.size === 0 && <p className="muted">No one yet. Use the search above to add people.</p>}
            </section>
          )}

          {view === "explore" && (
            <section className="explore-view">
              <h2>Explore</h2>
              <p className="muted">Notes with most likes (trending).</p>
              <ul className="note-list">
                {exploreNotes.map((ev) => {
                  const replies = getRepliesTo(ev.id).sort((a, b) => a.created_at - b.created_at);
                  const likeCount = getLikeCount(ev.id);
                  return (
                    <li key={ev.id} className="note-thread">
                      <div className="note-card">
                        <div className="note-avatar">
                          {profiles[ev.pubkey]?.picture ? <img src={profiles[ev.pubkey].picture!} alt="" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span>{(profiles[ev.pubkey]?.name || ev.pubkey).slice(0, 1)}</span>}
                        </div>
                        <div className="note-body">
                          <div className="note-meta">
                            <strong>
                              <button type="button" className="link-like" onClick={() => { setViewingProfilePubkey(ev.pubkey); setView("profile"); }}>
                                {(profiles[ev.pubkey]?.name ?? `${ev.pubkey.slice(0, 8)}…`)}
                              </button>
                            </strong>
                            <span className="note-time">{new Date(ev.created_at * 1000).toLocaleString()}</span>
                            <span className="muted"> · {likeCount} like{likeCount !== 1 ? "s" : ""}</span>
                          </div>
                          <div className="note-content">
                            {(contentWithoutImages(ev.content).trim() || ev.content.trim()) && <p>{contentWithoutImages(ev.content).trim() || ev.content}</p>}
                            {(() => {
                              const tagMedia = mediaUrlsFromTags(ev.tags);
                              const contentUrls = extractImageUrls(ev.content);
                              const urls = tagMedia.length > 0 ? tagMedia : contentUrls;
                              if (urls.length === 0) return null;
                              return (
                                <div className="note-images">
                                  {urls.slice(0, 4).map((url, i) =>
                                    isVideoUrl(url) ? (
                                      <video key={i} src={url} controls className="note-img note-video" />
                                    ) : (
                                      <img key={i} src={url} alt="" className="note-img" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                                    )
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                          <div className="note-actions">
                            <button type="button" onClick={() => { setReplyingTo(ev); setReplyContent(""); setView("feed"); }} title="Reply">Reply</button>
                            <button type="button" onClick={() => !hasLiked(ev.id) && handleLike(ev)} title="Like" disabled={!!hasLiked(ev.id)}>{hasLiked(ev.id) ? "Liked" : "Like"} <span className="count">({likeCount})</span></button>
                            <button type="button" onClick={() => handleRepost(ev)} title="Repost">Repost</button>
                            <button type="button" onClick={() => hasBookmarked(ev.id) ? handleUnbookmark(ev) : handleBookmark(ev)} title={hasBookmarked(ev.id) ? "Remove bookmark" : "Bookmark"}>{hasBookmarked(ev.id) ? "Unbookmark" : "Bookmark"}</button>
                            <button type="button" onClick={() => window.open(`https://zap.stream/e/${ev.id}`, "_blank", "noopener")} title="Zap (opens zap.stream)">Zap <span className="count">({getZapCount(ev.id)})</span></button>
                          </div>
                        </div>
                      </div>
                      {replies.length > 0 && (
                        <ul className="note-replies">
                          {replies.slice(0, 3).map((reply) => (
                            <li key={reply.id} className="note-card note-reply">
                              <div className="note-avatar">
                                {profiles[reply.pubkey]?.picture ? <img src={profiles[reply.pubkey].picture!} alt="" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span>{(profiles[reply.pubkey]?.name || reply.pubkey).slice(0, 1)}</span>}
                              </div>
                              <div className="note-body">
                                <div className="note-meta">
                                  <strong>{profiles[reply.pubkey]?.name ?? `${reply.pubkey.slice(0, 8)}…`}</strong>
                                  <span className="note-time">{new Date(reply.created_at * 1000).toLocaleString()}</span>
                                </div>
                                <div className="note-content"><p>{contentWithoutImages(reply.content).trim() || reply.content}</p></div>
                              </div>
                            </li>
                          ))}
                          {replies.length > 3 && <p className="muted">… and {replies.length - 3} more replies</p>}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
              {exploreNotes.length === 0 && <p className="muted">No notes yet. Turn Network ON for relay feed.</p>}
            </section>
          )}

          {view === "bookmarks" && (
            <section className="bookmarks-view">
              <h2>Bookmarks</h2>
              <p className="muted">Notes you saved (kind 10003).</p>
              <ul className="note-list">
                {notes.filter((n) => bookmarkIds.has(n.id) && !deletedNoteIds.has(n.id)).sort((a, b) => b.created_at - a.created_at).map((ev) => {
                  const replies = getRepliesTo(ev.id).sort((a, b) => a.created_at - b.created_at);
                  const likeCount = getLikeCount(ev.id);
                  return (
                    <li key={ev.id} className="note-thread">
                      <div className="note-card">
                        <div className="note-avatar">
                          {profiles[ev.pubkey]?.picture ? <img src={profiles[ev.pubkey].picture!} alt="" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span>{(profiles[ev.pubkey]?.name || ev.pubkey).slice(0, 1)}</span>}
                        </div>
                        <div className="note-body">
                          <div className="note-meta">
                            <strong>
                              <button type="button" className="link-like" onClick={() => { setViewingProfilePubkey(ev.pubkey); setView("profile"); }}>
                                {(profiles[ev.pubkey]?.name ?? `${ev.pubkey.slice(0, 8)}…`)}
                              </button>
                            </strong>
                            <span className="note-time">{new Date(ev.created_at * 1000).toLocaleString()}</span>
                          </div>
                          <div className="note-content">
                            {(contentWithoutImages(ev.content).trim() || ev.content.trim()) && <p>{contentWithoutImages(ev.content).trim() || ev.content}</p>}
                            {(() => {
                              const tagMedia = mediaUrlsFromTags(ev.tags);
                              const contentUrls = extractImageUrls(ev.content);
                              const urls = tagMedia.length > 0 ? tagMedia : contentUrls;
                              if (urls.length === 0) return null;
                              return (
                                <div className="note-images">
                                  {urls.slice(0, 4).map((url, i) =>
                                    isVideoUrl(url) ? (
                                      <video key={i} src={url} controls className="note-img note-video" />
                                    ) : (
                                      <img key={i} src={url} alt="" className="note-img" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                                    )
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                          <div className="note-actions">
                            <button type="button" onClick={() => { setReplyingTo(ev); setReplyContent(""); setView("feed"); }} title="Reply">Reply</button>
                            <button type="button" onClick={() => !hasLiked(ev.id) && handleLike(ev)} title="Like" disabled={!!hasLiked(ev.id)}>{hasLiked(ev.id) ? "Liked" : "Like"} <span className="count">({likeCount})</span></button>
                            <button type="button" onClick={() => handleRepost(ev)} title="Repost">Repost</button>
                            <button type="button" onClick={() => handleUnbookmark(ev)} title="Remove bookmark">Unbookmark</button>
                            {selfPubkeys.includes(ev.pubkey) && <button type="button" className="btn-delete muted" onClick={() => handleDelete(ev)} title="Delete">Delete</button>}
                          </div>
                        </div>
                      </div>
                      {replies.length > 0 && (
                        <ul className="note-replies">
                          {replies.map((reply) => (
                            <li key={reply.id} className="note-card note-reply">
                              <div className="note-avatar">
                                {profiles[reply.pubkey]?.picture ? <img src={profiles[reply.pubkey].picture!} alt="" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span>{(profiles[reply.pubkey]?.name || reply.pubkey).slice(0, 1)}</span>}
                              </div>
                              <div className="note-body">
                                <div className="note-meta">
                                  <strong>{profiles[reply.pubkey]?.name ?? `${reply.pubkey.slice(0, 8)}…`}</strong>
                                  <span className="note-time">{new Date(reply.created_at * 1000).toLocaleString()}</span>
                                </div>
                                <div className="note-content"><p>{contentWithoutImages(reply.content).trim() || reply.content}</p></div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
              {bookmarkIds.size === 0 && <p className="muted">No bookmarks yet. Use Bookmark on any note to save it here.</p>}
            </section>
          )}

          {view === "notifications" && (
            <section className="notifications-view">
              <h2>Notifications</h2>
              <p className="muted">Reactions and replies to your notes. Click a name to open their profile; click View post to see it in the feed.</p>
              <ul className="event-list">
                {notificationEvents.map((ev) => {
                  const noteIdRef = ev.kind === 7 ? ev.tags.find((t) => t[0] === "e")?.[1] : ev.kind === 6 || ev.kind === 9735 ? ev.tags.find((t) => t[0] === "e")?.[1] : (ev.kind === 1 ? (ev.tags.find((t) => t[0] === "e")?.[1] ?? ev.id) : ev.id);
                  return (
                    <li key={ev.id} className="event notification-item">
                      <span className="event-meta">
                        {ev.kind === 7 ? "Like" : ev.kind === 6 ? "Repost" : ev.kind === 9735 ? "Zap" : "Reply"} from{" "}
                        <button type="button" className="link-like" onClick={() => { setViewingProfilePubkey(ev.pubkey); setView("profile"); }}>
                          {(profiles[ev.pubkey]?.name ?? `${ev.pubkey.slice(0, 8)}…`)}
                        </button>
                        {" · "}{new Date(ev.created_at * 1000).toLocaleString()}
                      </span>
                      {ev.kind === 1 && <p className="event-content">{contentWithoutImages(ev.content).trim() || ev.content}</p>}
                      {ev.kind === 7 && <p className="event-content muted">{ev.content || "+"}</p>}
                      {ev.kind === 6 && <p className="event-content muted">Reposted your note</p>}
                      {ev.kind === 9735 && <p className="event-content muted">Zapped your note</p>}
                      {noteIdRef && (
                        <button type="button" className="link-like view-post-link" onClick={() => { setFocusedNoteId(noteIdRef); setView("feed"); }}>
                          View post
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {notificationEvents.length === 0 && <p className="muted">No notifications yet.</p>}
            </section>
          )}

          {view === "profile" && pubkey && (
            <section className="profile-view">
              <h2>{viewingProfilePubkey ? "Profile" : "My profile"}</h2>
              {viewingProfilePubkey && (
                <button type="button" className="btn-back" onClick={() => setViewingProfilePubkey(null)} style={{ marginBottom: "0.5rem" }}>← Back to feed</button>
              )}
              <div className="profile-header-card">
                {(profiles[profileViewPubkey]?.banner ?? (profileViewPubkey === profileDisplayKey ? myBanner : null)) ? (
                  <div className="profile-banner-wrap">
                    <img src={profiles[profileViewPubkey]?.banner ?? myBanner!} alt="" className="profile-banner" />
                  </div>
                ) : (
                  <div className="profile-banner-placeholder" />
                )}
                <div className="profile-header-body">
                  {profiles[profileViewPubkey]?.picture ?? (profileViewPubkey === profileDisplayKey ? myPicture : null) ? (
                    <img src={(profiles[profileViewPubkey]?.picture ?? myPicture)!} alt="" className="profile-avatar profile-avatar-overlay" />
                  ) : (
                    <div className="profile-avatar profile-avatar-overlay placeholder">{(profiles[profileViewPubkey]?.name ?? (profileViewPubkey === profileDisplayKey ? myName : profileViewPubkey)).slice(0, 1)}</div>
                  )}
                  <strong className="profile-name">{(profileViewPubkey === profileDisplayKey ? myName : (profiles[profileViewPubkey]?.name ?? `${profileViewPubkey.slice(0, 8)}…`))}</strong>
                  <p
                    className="profile-note pubkey-display pubkey-copy"
                    title="Click to copy"
                    onClick={async () => {
                      const npub = Nostr.nip19.npubEncode(profileViewPubkey);
                      await navigator.clipboard.writeText(npub);
                      setStatus("Copied!");
                      setTimeout(() => setStatus(""), 1500);
                    }}
                  >
                    {Nostr.nip19.npubEncode(profileViewPubkey)}
                  </p>
                  {(profiles[profileViewPubkey]?.nip05 ?? (profileViewPubkey === profileDisplayKey && myProfile?.nip05)) && (
                    <p className="profile-note profile-nip05 muted">{(profileViewPubkey === profileDisplayKey ? myProfile?.nip05 : profiles[profileViewPubkey]?.nip05)}</p>
                  )}
                  {(profiles[profileViewPubkey]?.about ?? (profileViewPubkey === profileDisplayKey ? myAbout : "")) && (
                    <p className="profile-about">{(profileViewPubkey === profileDisplayKey ? myAbout : profiles[profileViewPubkey]?.about) ?? ""}</p>
                  )}
                  <div className="profile-stats">
                    <span><strong>{profileRootNotes.length}</strong> posts</span>
                    <span><strong>{profileFollowing.length}</strong> following</span>
                    <span><strong>{profileFollowers.length}</strong> followers</span>
                  </div>
                  {profileViewPubkey === profileDisplayKey ? (
                    isNostrLoggedIn ? (
                      <p className="profile-note muted">Your Nostr profile is fetched from relays. To update it, use a Nostr client (e.g. Damus, Primal).</p>
                    ) : (
                      <button type="button" className="btn-secondary" onClick={handleEditProfileOpen}>Edit profile</button>
                    )
                  ) : (
                    contactsSet.has(profileViewPubkey)
                      ? <button type="button" className="btn-secondary" onClick={() => handleUnfollow(profileViewPubkey)}>Unfollow</button>
                      : <button type="button" className="btn-primary" onClick={() => handleFollow(profileViewPubkey)}>Follow</button>
                  )}
                </div>
              </div>
              <h3 className="profile-section-title">Posts</h3>
              <ul className="note-list">
                {profileRootNotes.length === 0 && <p className="muted">No posts yet.</p>}
                {profileRootNotes.map((ev) => {
                  const replies = getRepliesTo(ev.id).sort((a, b) => a.created_at - b.created_at);
                  const likeCount = getLikeCount(ev.id);
                  return (
                    <li key={ev.id} className="note-thread">
                      <div className="note-card">
                        <div className="note-avatar">
                          {profiles[ev.pubkey]?.picture ? <img src={profiles[ev.pubkey].picture!} alt="" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span>{(profiles[ev.pubkey]?.name || ev.pubkey).slice(0, 1)}</span>}
                        </div>
                        <div className="note-body">
                          <div className="note-meta">
                            <strong>{profiles[ev.pubkey]?.name ?? `${ev.pubkey.slice(0, 8)}…`}</strong>
                            <span className="note-time">{new Date(ev.created_at * 1000).toLocaleString()}</span>
                          </div>
                          <div className="note-content">
                            {(contentWithoutImages(ev.content).trim() || ev.content.trim()) && <p>{contentWithoutImages(ev.content).trim() || ev.content}</p>}
                            {(() => {
                              const tagMedia = mediaUrlsFromTags(ev.tags);
                              const contentUrls = extractImageUrls(ev.content);
                              const urls = tagMedia.length > 0 ? tagMedia : contentUrls;
                              if (urls.length === 0) return null;
                              return (
                                <div className="note-images">
                                  {urls.slice(0, 4).map((url, i) =>
                                    isVideoUrl(url) ? (
                                      <video key={i} src={url} controls className="note-img note-video" />
                                    ) : (
                                      <img key={i} src={url} alt="" className="note-img" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                                    )
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                          <div className="note-actions">
                            <button type="button" onClick={() => { setReplyingTo(ev); setReplyContent(""); setView("feed"); }} title="Reply">Reply</button>
                            <button type="button" onClick={() => !hasLiked(ev.id) && handleLike(ev)} title="Like" disabled={!!hasLiked(ev.id)}>{hasLiked(ev.id) ? "Liked" : "Like"} <span className="count">({likeCount})</span></button>
                            <button type="button" onClick={() => window.open(`https://zap.stream/e/${ev.id}`, "_blank", "noopener")} title="Zap (opens zap.stream)">Zap <span className="count">({getZapCount(ev.id)})</span></button>
                            <button type="button" onClick={() => hasBookmarked(ev.id) ? handleUnbookmark(ev) : handleBookmark(ev)} title={hasBookmarked(ev.id) ? "Remove bookmark" : "Bookmark"}>{hasBookmarked(ev.id) ? "Unbookmark" : "Bookmark"}</button>
                            {selfPubkeys.includes(ev.pubkey) && <button type="button" className="btn-delete muted" onClick={() => handleDelete(ev)} title="Delete">Delete</button>}
                          </div>
                        </div>
                      </div>
                      {replies.length > 0 && (
                        <ul className="note-replies">
                          {replies.map((reply) => (
                            <li key={reply.id} className="note-card note-reply">
                              <div className="note-avatar">
                                {profiles[reply.pubkey]?.picture ? <img src={profiles[reply.pubkey].picture!} alt="" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span>{(profiles[reply.pubkey]?.name || reply.pubkey).slice(0, 1)}</span>}
                              </div>
                              <div className="note-body">
                                <div className="note-meta">
                                  <strong>{profiles[reply.pubkey]?.name ?? `${reply.pubkey.slice(0, 8)}…`}</strong>
                                  <span className="note-time">{new Date(reply.created_at * 1000).toLocaleString()}</span>
                                </div>
                                <div className="note-content"><p>{contentWithoutImages(reply.content).trim() || reply.content}</p></div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
              <h3 className="profile-section-title">Following</h3>
              <ul className="contact-list">
                {profileFollowing.slice(0, 50).map((pk) => (
                  <li key={pk}>
                    {profiles[pk]?.picture ? <img src={profiles[pk].picture!} alt="" className="contact-avatar" /> : <span className="contact-avatar placeholder">{pk.slice(0, 2)}</span>}
                    <button type="button" className="link-like" onClick={() => { setViewingProfilePubkey(pk); setView("profile"); }}>
                      {profiles[pk]?.name ?? `${pk.slice(0, 12)}…`}
                    </button>
                  </li>
                ))}
                {profileFollowing.length === 0 && <p className="muted">None yet.</p>}
                {profileFollowing.length > 50 && <p className="muted">… and {profileFollowing.length - 50} more</p>}
              </ul>
              <h3 className="profile-section-title">Followers</h3>
              <ul className="contact-list">
                {profileFollowers.slice(0, 50).map((pk) => (
                  <li key={pk}>
                    {profiles[pk]?.picture ? <img src={profiles[pk].picture!} alt="" className="contact-avatar" /> : <span className="contact-avatar placeholder">{pk.slice(0, 2)}</span>}
                    <button type="button" className="link-like" onClick={() => { setViewingProfilePubkey(pk); setView("profile"); }}>
                      {profiles[pk]?.name ?? `${pk.slice(0, 12)}…`}
                    </button>
                  </li>
                ))}
                {profileFollowers.length === 0 && <p className="muted">None yet.</p>}
                {profileFollowers.length > 50 && <p className="muted">… and {profileFollowers.length - 50} more</p>}
              </ul>
            </section>
          )}

          {view === "identity" && (
            <section className="identity-view">
              <h2>Identity</h2>
              <p className="muted">Check identities to view their content; choose one as acting for new posts, replies, and DMs.</p>
              <p className="identity-category-intro muted">Each identity has a <strong>category</strong>: <strong>Local</strong> = data only in embedded images (never sent to Nostr). <strong>Nostr</strong> = when Network is ON, posts and profile go to relays. Use <strong>Convert to Local</strong> / <strong>Convert to Nostr</strong> to switch (hover ⓘ on the button for details).</p>
              <div className="identity-actions">
                <button type="button" className="btn-primary" onClick={handleGenerate}>Create local identity</button>
                <button type="button" className="btn-secondary" onClick={() => setLoginFormOpen(true)}>Add Nostr identity</button>
              </div>
              <ul className="identity-list">
                {identities.map((id) => {
                  const pk = Nostr.getPublicKey(Nostr.hexToBytes(id.privKeyHex));
                  const isViewing = viewingPubkeys.has(pk);
                  const isActing = actingPubkey === pk;
                  const displayLabel = profiles[pk]?.name || id.label || pk.slice(0, 8) + "…";
                  const category = id.category ?? (id.type === "nostr" ? "nostr" : "local");
                  const categoryExplainer = "Local: data is only shared via embedded images (steganographic). Nostr: when Network is ON, your posts and profile are published to Nostr relays. You can convert between Local and Nostr at any time.";
                  return (
                    <li key={id.id} className="identity-item">
                      <label className="identity-viewing">
                        <input
                          type="checkbox"
                          checked={isViewing}
                          onChange={() => {
                            setViewingPubkeys((prev) => {
                              const next = new Set(prev);
                              if (isViewing) next.delete(pk);
                              else next.add(pk);
                              return next;
                            });
                          }}
                        />
                        View
                      </label>
                      <label className="identity-acting">
                        <input
                          type="radio"
                          name="acting"
                          checked={isActing}
                          onChange={() => setActingPubkey(pk)}
                        />
                        Act
                      </label>
                      <span className="identity-label">{displayLabel}</span>
                      <span
                        className="identity-pubkey pubkey-copy muted"
                        title="Click to copy npub"
                        onClick={async () => {
                          const npub = Nostr.nip19.npubEncode(pk);
                          await navigator.clipboard.writeText(npub);
                          setStatus("Copied!");
                          setTimeout(() => setStatus(""), 1500);
                        }}
                      >
                        {Nostr.nip19.npubEncode(pk)}
                      </span>
                      <span className="identity-type muted">({id.type})</span>
                      <div className="identity-category-row">
                        <span className="identity-category-label">Category:</span>
                        <span className="identity-category-badge" data-category={category}>{category === "nostr" ? "Nostr" : "Local"}</span>
                        <button
                          type="button"
                          className="btn-secondary identity-convert"
                          onClick={(e) => {
                            e.preventDefault();
                            const nextCat = category === "nostr" ? "local" : "nostr";
                            setIdentities((prev) =>
                              prev.map((i) => (i.id === id.id ? { ...i, category: nextCat } : i))
                            );
                            setStatus(nextCat === "local" ? "Identity is now Local (steganographic only)" : "Identity is now Nostr (will sync when Network ON)");
                          }}
                          title={category === "nostr" ? "Convert to Local (data only in images)" : "Convert to Nostr (publish to relays when Network ON)"}
                        >
                          {category === "nostr" ? "Convert to Local" : "Convert to Nostr"}
                          <span className="identity-convert-info" title={categoryExplainer} aria-label="Info" onClick={(e) => e.stopPropagation()}>ⓘ</span>
                        </button>
                      </div>
                      <label className="identity-private">
                        <input
                          type="checkbox"
                          checked={!!id.isPrivate}
                          onChange={() => {
                            setIdentities((prev) =>
                              prev.map((i) => (i.id === id.id ? { ...i, isPrivate: !i.isPrivate } : i))
                            );
                          }}
                        />
                        Private
                      </label>
                      {identities.length > 1 && (
                        <button
                          type="button"
                          className="btn-delete muted"
                          onClick={() => {
                            const remaining = identities.filter((i) => i.id !== id.id);
                            setIdentities(remaining);
                            setViewingPubkeys((prev) => { const n = new Set(prev); n.delete(pk); return n; });
                            if (isActing && remaining[0]) setActingPubkey(Nostr.getPublicKey(Nostr.hexToBytes(remaining[0].privKeyHex)));
                          }}
                          title="Remove identity"
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {identities.some((i) => i.isPrivate) && (
                <div className="identity-follow-requests">
                  <h3 className="profile-section-title">Follow requests</h3>
                  <p className="muted">When your profile is private, only approved followers can view. Follow requests will appear here when a NIP for follow requests is supported.</p>
                </div>
              )}
            </section>
          )}

          {view === "settings" && (
            <section className="settings-view">
              <h2>Settings</h2>
              <h3 className="settings-section">Identities</h3>
              <p className="muted">Public keys (npub). Click to copy.</p>
              <ul className="settings-list">
                {identities.map((id) => {
                  const pk = Nostr.getPublicKey(Nostr.hexToBytes(id.privKeyHex));
                  const label = profiles[pk]?.name || id.label || pk.slice(0, 8) + "…";
                  return (
                    <li key={id.id} className="settings-list-item settings-identity-item">
                      <span className="muted">{label}</span>
                      <span
                        className="pubkey-copy muted"
                        style={{ fontFamily: "monospace", fontSize: "0.8rem", wordBreak: "break-all" }}
                        title="Click to copy npub"
                        onClick={async () => {
                          const npub = Nostr.nip19.npubEncode(pk);
                          await navigator.clipboard.writeText(npub);
                          setStatus("Copied!");
                          setTimeout(() => setStatus(""), 1500);
                        }}
                      >
                        {Nostr.nip19.npubEncode(pk)}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <h3 className="settings-section">Relays</h3>
              <p className="muted">Default is the Stegstr relay (proxy); relay path is managed by Stegstr. You can add or remove relay URLs below.</p>
              <div className="mute-add-wrap">
                <input
                  type="url"
                  placeholder="wss://…"
                  value={newRelayUrl}
                  onChange={(e) => setNewRelayUrl(e.target.value)}
                  className="wide"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newRelayUrl.trim()) {
                      const url = newRelayUrl.trim().toLowerCase();
                      if (url.startsWith("wss://") || url.startsWith("ws://")) {
                        setRelayUrls((prev) => prev.includes(url) ? prev : [...prev, url]);
                        setNewRelayUrl("");
                      }
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    if (newRelayUrl.trim()) {
                      const url = newRelayUrl.trim().toLowerCase();
                      if (url.startsWith("wss://") || url.startsWith("ws://")) {
                        setRelayUrls((prev) => prev.includes(url) ? prev : [...prev, url]);
                        setNewRelayUrl("");
                      }
                    }
                  }}
                >
                  Add
                </button>
              </div>
              <ul className="settings-list">
                {relayUrls.map((url) => (
                  <li key={url} className="settings-list-item">
                    <span className="muted" style={{ wordBreak: "break-all" }}>{url}</span>
                    <button type="button" className="btn-delete muted" onClick={() => setRelayUrls((prev) => prev.filter((u) => u !== url))}>Remove</button>
                  </li>
                ))}
              </ul>
              {relayUrls.length === 0 && <p className="muted">Add at least one relay (e.g. the Stegstr proxy or wss://relay.damus.io).</p>}
              <h3 className="settings-section">Mute</h3>
              <p className="muted">Muted users and words are hidden from feed and notifications.</p>
              <div className="mute-add-wrap">
                <input
                  type="text"
                  placeholder="npub / hex pubkey or word…"
                  value={muteInput}
                  onChange={(e) => setMuteInput(e.target.value)}
                  className="wide"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const pk = resolvePubkeyFromInput(muteInput.trim());
                      if (pk) {
                        setMutedPubkeys((prev) => new Set(prev).add(pk));
                        setMuteInput("");
                      } else if (muteInput.trim()) {
                        setMutedWords((prev) => prev.includes(muteInput.trim().toLowerCase()) ? prev : [...prev, muteInput.trim().toLowerCase()]);
                        setMuteInput("");
                      }
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    const pk = resolvePubkeyFromInput(muteInput.trim());
                    if (pk) {
                      setMutedPubkeys((prev) => new Set(prev).add(pk));
                      setMuteInput("");
                    } else if (muteInput.trim()) {
                      setMutedWords((prev) => prev.includes(muteInput.trim().toLowerCase()) ? prev : [...prev, muteInput.trim().toLowerCase()]);
                      setMuteInput("");
                    }
                  }}
                >
                  Add
                </button>
              </div>
              {mutedPubkeys.size > 0 && (
                <>
                  <p className="settings-sub">Muted users</p>
                  <ul className="settings-list">
                    {[...mutedPubkeys].map((pk) => (
                      <li key={pk} className="settings-list-item">
                        <span className="muted">{pk.slice(0, 12)}…{pk.slice(-6)}</span>
                        <button type="button" className="btn-delete muted" onClick={() => setMutedPubkeys((prev) => { const s = new Set(prev); s.delete(pk); return s; })}>Remove</button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {mutedWords.length > 0 && (
                <>
                  <p className="settings-sub">Muted words</p>
                  <ul className="settings-list">
                    {mutedWords.map((w) => (
                      <li key={w} className="settings-list-item">
                        <span className="muted">{w}</span>
                        <button type="button" className="btn-delete muted" onClick={() => setMutedWords((prev) => prev.filter((x) => x !== w))}>Remove</button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h3 className="settings-section">Stego</h3>
              <p className="muted">Detect: load image to extract Nostr state. Embed: save current feed to image. When Network is OFF, use images to pass state P2P. Turn Network ON to sync local changes to relays.</p>
              <p className="muted" style={{ marginTop: "0.5rem" }}>Stegstr 0.1.0</p>
            </section>
          )}
        </div>

        <aside className="sidebar right">
          <div className="widget steganography-widget">
            <h3>Steganography</h3>
            <p className="muted">Detect image: load an image to extract data. Embed image: save your feed and messages to an image to share.</p>
            <div className="stego-drop-zone" aria-label="Drop image here to detect">
              Drop image here to detect
            </div>
            {detecting && <p className="muted detect-status">Decoding…</p>}
            <div className="stego-actions">
              <button type="button" className="btn-stego" onClick={() => handleLoadFromImage()} disabled={detecting}>Detect image</button>
              <button type="button" className="btn-stego btn-primary" onClick={handleSaveToImage} disabled={detecting}>Embed image</button>
              {profile != null && (
                <>
                  <button type="button" className="btn-stego btn-quick-test" onClick={handleDetectFromExchange} disabled={detecting} title="1-click: detect from /tmp/stegstr-test-exchange/exchange.png">Detect from exchange</button>
                  <button type="button" className="btn-stego btn-quick-test" onClick={handleEmbedToExchange} disabled={detecting} title="2-click: pick cover → save to exchange path">Embed to exchange</button>
                </>
              )}
            </div>
          </div>
        </aside>
      </div>

      {newMessageModalOpen && (
        <div className="modal-overlay" onClick={() => setNewMessageModalOpen(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h3>New message</h3>
            <p className="muted">Type their name or public key (npub/hex). Search finds people from your feed and relays.</p>
            <label>
              Name or npub/hex pubkey
              <input type="text" value={newMessagePubkeyInput} onChange={(e) => setNewMessagePubkeyInput(e.target.value)} placeholder="e.g. Alice or npub1…" className="wide" autoComplete="off" />
            </label>
            {newMessagePubkeyInput.trim() && !resolvePubkeyFromInput(newMessagePubkeyInput) && (() => {
              const q = newMessagePubkeyInput.trim().toLowerCase();
              const matches = Object.entries(profiles).filter(
                ([pk, p]) => !selfPubkeys.includes(pk) &&
                  (p?.name?.toLowerCase().includes(q) || p?.nip05?.toLowerCase().includes(q) || pk.toLowerCase().includes(q))
              );
              if (matches.length === 0) return <p className="muted">No matches. Try a different name or enter npub/hex pubkey.</p>;
              return (
                <div className="search-results profiles-search">
                  <p className="muted">Matching profiles—click to open conversation:</p>
                  <ul className="contact-list">
                    {matches.slice(0, 12).map(([pk, p]) => (
                      <li key={pk} className="contact-list-item">
                        {p?.picture ? <img src={p.picture} alt="" className="contact-avatar" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span className="contact-avatar placeholder">{(p?.name ?? pk).slice(0, 2)}</span>}
                        <button type="button" className="link-like" onClick={() => { setSelectedMessagePeer(pk); setNewMessagePubkeyInput(""); setNewMessageModalOpen(false); }}>
                          {p?.name ?? `${pk.slice(0, 12)}…`}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            <div className="row modal-actions">
              <button type="button" onClick={() => setNewMessageModalOpen(false)}>Cancel</button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  const pk = resolvePubkeyFromInput(newMessagePubkeyInput);
                  if (pk) {
                    setSelectedMessagePeer(pk);
                    setNewMessagePubkeyInput("");
                    setNewMessageModalOpen(false);
                  } else {
                    const q = newMessagePubkeyInput.trim().toLowerCase();
                    const matches = Object.entries(profiles).filter(
                      ([p, pr]) => !selfPubkeys.includes(p) &&
                        (pr?.name?.toLowerCase().includes(q) || pr?.nip05?.toLowerCase().includes(q))
                    );
                    if (matches.length === 1) {
                      setSelectedMessagePeer(matches[0][0]);
                      setNewMessagePubkeyInput("");
                      setNewMessageModalOpen(false);
                    } else if (matches.length > 1) setStatus("Several matches—click one above or enter npub");
                    else setStatus("No match. Enter a name (from your feed) or npub/hex pubkey.");
                  }
                }}
              >
                Open conversation
              </button>
            </div>
          </div>
        </div>
      )}

      {loginFormOpen && (
        <div className="modal-overlay" onClick={() => setLoginFormOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Log in with Nostr</h3>
            <p className="muted">Enter your nsec or 64-char hex private key to use your Nostr account. Your local posts will be re-signed and published.</p>
            <label>
              nsec or hex key
              <input type="password" value={nsec} onChange={(e) => setNsec(e.target.value)} placeholder="nsec1… or hex" className="wide" autoComplete="off" />
            </label>
            <div className="row modal-actions">
              <button type="button" onClick={() => setLoginFormOpen(false)}>Cancel</button>
              <button type="button" onClick={handleGenerate}>Generate new key</button>
              <button type="button" onClick={handleLogin} className="btn-primary">Log in</button>
            </div>
          </div>
        </div>
      )}

      {embedModalOpen && (
        <div className="modal-overlay" onClick={() => setEmbedModalOpen(false)}>
          <div className="modal embed-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Embed feed into image</h3>
            <p className="muted">Data is encrypted so only Stegstr can read it. Choose who can view:</p>
            <div className="embed-options">
              <label className="embed-option">
                <input
                  type="radio"
                  name="embedMode"
                  checked={embedMode === "open"}
                  onChange={() => setEmbedMode("open")}
                />
                <span>Any Stegstr user can view</span>
              </label>
              <label className="embed-option">
                <input
                  type="radio"
                  name="embedMode"
                  checked={embedMode === "recipients"}
                  onChange={() => setEmbedMode("recipients")}
                />
                <span>Only these people (with Stegstr) can view</span>
              </label>
            </div>
            {embedMode === "recipients" && (
              <div className="embed-recipients">
                <p className="muted">Recent message partners (you are always included):</p>
                <ul className="embed-recipient-list">
                  {recentDmPartners.length === 0 ? (
                    <li className="muted">No DM partners yet. Use “Any Stegstr user” or add contacts and message them first.</li>
                  ) : (
                    recentDmPartners.map(({ pubkey: pk }) => (
                      <li key={pk}>
                        <label>
                          <input
                            type="checkbox"
                            checked={embedSelectedPubkeys.has(pk)}
                            onChange={() => toggleEmbedRecipient(pk)}
                          />
                          <span>{profiles[pk]?.name ?? `${pk.slice(0, 8)}…${pk.slice(-4)}`}</span>
                        </label>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            )}
            <div className="row modal-actions">
              <button type="button" onClick={() => setEmbedModalOpen(false)}>Cancel</button>
              <button type="button" onClick={handleEmbedConfirm} className="btn-primary">Embed</button>
            </div>
          </div>
        </div>
      )}

      {editProfileOpen && (
        <div className="modal-overlay" onClick={() => setEditProfileOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Edit profile</h3>
            <label>
              Name
              <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Display name" className="wide" />
            </label>
            <label>
              About
              <textarea value={editAbout} onChange={(e) => setEditAbout(e.target.value)} placeholder="Bio" rows={3} className="wide" />
            </label>
            <label>
              Picture
              <div className="edit-media-row">
                <input type="url" value={editPicture} onChange={(e) => setEditPicture(e.target.value)} placeholder="https://… or upload" className="wide" />
                <input ref={editPfpInputRef} type="file" accept="image/*" className="hidden-input" onChange={handleEditPfpUpload} />
                <button type="button" className="btn-secondary" onClick={() => editPfpInputRef.current?.click()}>Choose file</button>
              </div>
            </label>
            <label>
              Cover / banner
              <div className="edit-media-row">
                <input type="url" value={editBanner} onChange={(e) => setEditBanner(e.target.value)} placeholder="https://… or upload" className="wide" />
                <input ref={editCoverInputRef} type="file" accept="image/*" className="hidden-input" onChange={handleEditCoverUpload} />
                <button type="button" className="btn-secondary" onClick={() => editCoverInputRef.current?.click()}>Choose file</button>
              </div>
            </label>
            <div className="row modal-actions">
              <button type="button" onClick={() => setEditProfileOpen(false)}>Cancel</button>
              <button type="button" onClick={handleEditProfileSave} className="btn-primary">Save</button>
            </div>
          </div>
        </div>
      )}

      {(status || decodeError) && (
        <p className={decodeError ? "error" : "status"}>{decodeError || status}</p>
      )}
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
    invoke<string | null>("get_test_profile")
      .then((p) => setProfile(p ?? null))
      .catch(() => setProfile(null));
  }, []);
  if (profile === undefined) return <p className="muted" style={{ padding: "2rem" }}>Loading…</p>;
  return <App profile={profile} />;
}

export default AppBootstrap;
