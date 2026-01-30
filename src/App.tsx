import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as Nostr from "./nostr-stub";
import { connectRelays, publishEvent, DEFAULT_RELAYS } from "./relay";
import { extractImageUrls, imageUrlFromTags, contentWithoutImages } from "./utils";
import * as stegoCrypto from "./stego-crypto";
import type { NostrEvent, NostrStateBundle } from "./types";
import "./App.css";

const STEGSTR_BUNDLE_VERSION = 1;
const ANON_KEY_STORAGE = "stegstr_anon_key";
const MUTE_PUBKEYS_STORAGE = "stegstr_mute_pubkeys";
const MUTE_WORDS_STORAGE = "stegstr_mute_words";
const RELAYS_STORAGE = "stegstr_relays";

function getOrCreateAnonKey(): string {
  try {
    const stored = localStorage.getItem(ANON_KEY_STORAGE);
    if (stored && /^[a-fA-F0-9]{64}$/.test(stored)) return stored;
  } catch (_) {}
  const sk = Nostr.generateSecretKey();
  const hex = Nostr.bytesToHex(sk);
  try {
    localStorage.setItem(ANON_KEY_STORAGE, hex);
  } catch (_) {}
  return hex;
}

type View = "feed" | "messages" | "followers" | "notifications" | "profile" | "settings" | "bookmarks" | "explore";

function App() {
  const [nsec, setNsec] = useState("");
  const [privKeyHex, setPrivKeyHex] = useState<string | null>(null);
  const [loginFormOpen, setLoginFormOpen] = useState(false);
  const [networkEnabled, setNetworkEnabled] = useState(false);
  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [profiles, setProfiles] = useState<Record<string, { name?: string; about?: string; picture?: string; banner?: string; nip05?: string }>>({});
  const [newPost, setNewPost] = useState("");
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
      const raw = localStorage.getItem(MUTE_PUBKEYS_STORAGE);
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch (_) {}
    return new Set();
  });
  const [mutedWords, setMutedWords] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(MUTE_WORDS_STORAGE);
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
      const raw = localStorage.getItem(RELAYS_STORAGE);
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr) && arr.length > 0) return arr;
      }
    } catch (_) {}
    return [...DEFAULT_RELAYS];
  });
  const [newRelayUrl, setNewRelayUrl] = useState("");
  const [feedFilter, setFeedFilter] = useState<"global" | "following">("global");
  const relayRef = useRef<ReturnType<typeof connectRelays> | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(RELAYS_STORAGE, JSON.stringify(relayUrls));
    } catch (_) {}
  }, [relayUrls]);

  useEffect(() => {
    try {
      localStorage.setItem(MUTE_PUBKEYS_STORAGE, JSON.stringify([...mutedPubkeys]));
    } catch (_) {}
  }, [mutedPubkeys]);
  useEffect(() => {
    try {
      localStorage.setItem(MUTE_WORDS_STORAGE, JSON.stringify(mutedWords));
    } catch (_) {}
  }, [mutedWords]);

  useEffect(() => {
    if (searchQuery.trim()) setReplyingTo(null);
  }, [searchQuery]);
  useEffect(() => {
    if (view !== "feed") setFocusedNoteId(null);
  }, [view]);
  const prevNetworkRef = useRef(false);
  const hasSyncedAnonRef = useRef(false);

  const effectivePrivKey = privKeyHex ?? getOrCreateAnonKey();
  const pubkey = Nostr.getPublicKey(Nostr.hexToBytes(effectivePrivKey));
  const isNostrLoggedIn = privKeyHex !== null;
  const myProfile = pubkey ? profiles[pubkey] : null;
  const myName = myProfile?.name ?? (pubkey ? `${pubkey.slice(0, 8)}…` : "");
  const myPicture = myProfile?.picture ?? null;
  const myAbout = myProfile?.about ?? "";
  const myBanner = myProfile?.banner ?? null;

  const contacts = pubkey && events.find((e) => e.kind === 3 && e.pubkey === pubkey)
    ? (events.find((e) => e.kind === 3 && e.pubkey === pubkey)!.tags.filter((t) => t[0] === "p").map((t) => t[1]))
    : [];
  const dmEvents = events.filter((e) => e.kind === 4);
  const recentDmPartners = (() => {
    const seen = new Set<string>();
    const list: { pubkey: string }[] = [];
    for (const ev of dmEvents.sort((a, b) => b.created_at - a.created_at)) {
      const other = ev.pubkey === pubkey ? ev.tags.find((t) => t[0] === "p")?.[1] : ev.pubkey;
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
    events.filter((e) => e.kind === 5 && e.pubkey === pubkey).flatMap((e) => e.tags.filter((t) => t[0] === "e").map((t) => t[1]))
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

  const myNoteIds = pubkey ? new Set(notes.filter((n) => n.pubkey === pubkey).map((n) => n.id)) : new Set<string>();
  const notificationEventsRaw = pubkey
    ? events.filter(
        (e) =>
          (e.kind === 7 && e.tags.some((t) => t[0] === "p" && t[1] === pubkey)) ||
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
    pubkey && reactions.some((r) => r.pubkey === pubkey && r.tags.some((t) => t[0] === "e" && t[1] === noteId));

  const noteContentMatchesMutedWord = (content: string) =>
    mutedWords.some((w) => w.trim() && content.toLowerCase().includes(w.trim().toLowerCase()));

  const bookmarksEvent = pubkey ? events.filter((e) => e.kind === 10003 && e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at)[0] : null;
  const bookmarkIds = new Set(bookmarksEvent?.tags.filter((t) => t[0] === "e").map((t) => t[1]) ?? []);
  const hasBookmarked = (noteId: string) => bookmarkIds.has(noteId);

  const profileViewPubkey = viewingProfilePubkey ?? pubkey;
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
      if (feedFilter === "following") {
        const authorPk = item.type === "repost" ? item.repost.pubkey : item.note.pubkey;
        if (!contacts.includes(authorPk)) return false;
      }
      return true;
    })
    .sort((a, b) => b.sortAt - a.sortAt);

  useEffect(() => {
    if (!networkEnabled || !pubkey) {
      relayRef.current?.close();
      relayRef.current = null;
      setRelayStatus("");
      return;
    }
    setRelayStatus("Connecting…");
    relayRef.current = connectRelays(
      pubkey,
      (ev) => {
        setEvents((prev) => {
          const byId = new Map(prev.map((e) => [e.id, e]));
          byId.set(ev.id, ev);
          if (ev.kind === 0) {
            try {
              const meta = JSON.parse(ev.content) as { name?: string; about?: string; picture?: string; banner?: string; nip05?: string };
              setProfiles((p) => ({ ...p, [ev.pubkey]: meta }));
            } catch (_) {}
          }
          return Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
        });
      },
      () => setRelayStatus("Synced"),
      (err) => setRelayStatus("Error: " + (err instanceof Error ? err.message : String(err))),
      relayUrls
    );
    return () => {
      relayRef.current?.close();
      relayRef.current = null;
      setRelayStatus("");
    };
  }, [networkEnabled, pubkey, relayUrls.join(",")]);

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
  }, [networkEnabled, contacts.join(","), notes.length]);

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

  // NIP-50: when user searches by text (not pubkey), ask relays for matching notes (debounced)
  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const trimmed = searchQuery.trim();
    if (trimmed.length < 2) return;
    const isPubkey = /npub1[a-zA-Z0-9]+/i.test(trimmed.replace(/\s/g, "")) || /^[a-fA-F0-9]{64}$/.test(trimmed.replace(/\s/g, ""));
    if (isPubkey) return;
    const t = setTimeout(() => {
      relayRef.current?.requestSearch(trimmed);
    }, 500);
    return () => clearTimeout(t);
  }, [networkEnabled, searchQuery]);

  useEffect(() => {
    const justTurnedOn = networkEnabled && !prevNetworkRef.current;
    prevNetworkRef.current = networkEnabled;
    if (!justTurnedOn || !pubkey) return;
    setEvents((prev) => {
      const myEvents = prev.filter((e) => e.pubkey === pubkey);
      myEvents.forEach((ev) => publishEvent(ev, relayUrls));
      return prev;
    });
  }, [networkEnabled, pubkey]);

  const dmEventIds = dmEvents.map((e) => e.id).join(",");
  useEffect(() => {
    if (!effectivePrivKey || !pubkey || dmEvents.length === 0) {
      setDmDecrypted({});
      return;
    }
    let cancelled = false;
    const next: Record<string, string> = {};
    (async () => {
      for (const ev of dmEvents) {
        if (cancelled) return;
        const otherPubkey = ev.pubkey === pubkey
          ? (ev.tags.find((t) => t[0] === "p")?.[1])
          : ev.pubkey;
        if (!otherPubkey) {
          next[ev.id] = "[No peer]";
          continue;
        }
        try {
          const plain = await Nostr.nip04Decrypt(ev.content, effectivePrivKey, otherPubkey);
          if (!cancelled) next[ev.id] = plain;
        } catch {
          if (!cancelled) next[ev.id] = "[Decryption failed]";
        }
      }
      if (!cancelled) setDmDecrypted(next);
    })();
    return () => { cancelled = true; };
  }, [effectivePrivKey, pubkey, dmEventIds]);

  const handleLogin = useCallback(() => {
    if (!nsec.trim()) {
      setStatus("Enter nsec or click Generate");
      return;
    }
    const trimmed = nsec.trim();
    if (trimmed.toLowerCase().startsWith("nsec")) {
      try {
        const decoded = Nostr.nip19.decode(trimmed);
        if (decoded.type === "nsec") {
          setPrivKeyHex(Nostr.bytesToHex(decoded.data));
          setStatus("Logged in");
          setLoginFormOpen(false);
          return;
        }
      } catch (e) {
        setStatus("Invalid nsec: " + (e as Error).message);
        return;
      }
    }
    if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
      setPrivKeyHex(trimmed);
      setStatus("Logged in");
      setLoginFormOpen(false);
      return;
    }
    setStatus("Enter valid nsec or 64-char hex key");
  }, [nsec]);

  const handleGenerate = useCallback(() => {
    const sk = Nostr.generateSecretKey();
    setPrivKeyHex(Nostr.bytesToHex(sk));
    setNsec(Nostr.nip19.nsecEncode(sk));
    setStatus("New key generated");
    setLoginFormOpen(false);
  }, []);

  const handleLoadFromImage = useCallback(async () => {
    setDecodeError("");
    try {
      const path = await openDialog({
        multiple: false,
        filters: [
          { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
          { name: "PNG", extensions: ["png"] },
          { name: "JPEG", extensions: ["jpg", "jpeg"] },
        ],
      });
      if (!path || typeof path !== "string") return;
      const result = await invoke<{ ok: boolean; payload?: string; error?: string }>("decode_stego_image", { path });
      if (!result.ok || !result.payload) {
        setDecodeError(result.error || "Decode failed");
        return;
      }
      let jsonString: string;
      const raw = result.payload;
      if (raw.startsWith("base64:")) {
        const bytes = Uint8Array.from(atob(raw.slice(7)), (c) => c.charCodeAt(0));
        if (!stegoCrypto.isEncryptedPayload(bytes)) {
          setDecodeError("Not a Stegstr encrypted image");
          return;
        }
        jsonString = await stegoCrypto.decryptPayload(bytes, effectivePrivKey);
      } else if (raw.trimStart().startsWith("{")) {
        jsonString = raw;
      } else {
        setDecodeError("Invalid payload");
        return;
      }
      const bundle = JSON.parse(jsonString) as NostrStateBundle;
      if (bundle.events?.length) {
        setEvents((prev) => {
          const byId = new Map(prev.map((e) => [e.id, e]));
          bundle.events.forEach((e) => byId.set(e.id, e));
          return Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
        });
        setStatus(`Loaded ${bundle.events.length} events`);
      } else setDecodeError("Invalid payload");
    } catch (e) {
      setDecodeError((e as Error).message);
    }
  }, [effectivePrivKey]);

  const handleSaveToImage = useCallback(() => {
    setDecodeError("");
    setEmbedModalOpen(true);
  }, []);

  const handleEmbedConfirm = useCallback(async () => {
    if (!embedModalOpen) return;
    setDecodeError("");
    try {
      const coverPath = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (!coverPath || typeof coverPath !== "string") {
        setEmbedModalOpen(false);
        return;
      }
      const outputPath = await saveDialog({
        filters: [{ name: "PNG", extensions: ["png"] }],
        defaultPath: "stegstr-export.png",
      });
      if (!outputPath) {
        setEmbedModalOpen(false);
        return;
      }
      const bundle: NostrStateBundle = { version: STEGSTR_BUNDLE_VERSION, events };
      const jsonString = JSON.stringify(bundle);
      let payloadToEmbed: string;
      if (embedMode === "open") {
        const encrypted = await stegoCrypto.encryptOpen(jsonString);
        payloadToEmbed = "base64:" + btoa(String.fromCharCode(...encrypted));
      } else {
        const recipients = Array.from(embedSelectedPubkeys);
        if (pubkey && !recipients.includes(pubkey)) recipients.push(pubkey);
        if (recipients.length === 0) {
          setDecodeError("Select at least one recipient or use “Any Stegstr user”");
          return;
        }
        const encrypted = await stegoCrypto.encryptForRecipients(jsonString, effectivePrivKey, recipients);
        payloadToEmbed = "base64:" + btoa(String.fromCharCode(...encrypted));
      }
      const result = await invoke<{ ok: boolean; path?: string; error?: string }>("encode_stego_image", {
        coverPath,
        outputPath,
        payload: payloadToEmbed,
      });
      setEmbedModalOpen(false);
      if (result.ok && result.path) setStatus(`Saved to ${result.path}`);
      else setDecodeError(result.error || "Encode failed");
    } catch (e) {
      setDecodeError((e as Error).message);
      setEmbedModalOpen(false);
    }
  }, [embedModalOpen, embedMode, embedSelectedPubkeys, events, pubkey, effectivePrivKey]);

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
        if (networkEnabled) publishEvent(ev as NostrEvent, relayUrls);
        setStatus("Message sent");
      } catch (e) {
        setStatus("Send failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, networkEnabled]
  );

  const handlePost = useCallback(async () => {
    if (!effectivePrivKey || !newPost.trim()) return;
    const sk = Nostr.hexToBytes(effectivePrivKey);
    const ev = await Nostr.finishEventAsync(
      {
        kind: 1,
        content: newPost.trim(),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk
    );
    setEvents((prev) => [ev as NostrEvent, ...prev]);
    setNewPost("");
    if (networkEnabled) publishEvent(ev as NostrEvent, relayUrls);
    setStatus("Posted");
  }, [effectivePrivKey, newPost, networkEnabled]);

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
        if (networkEnabled) publishEvent(ev as NostrEvent, relayUrls);
        setStatus("Liked");
      } catch (e) {
        setStatus("Like failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, networkEnabled]
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
        if (networkEnabled) publishEvent(ev as NostrEvent, relayUrls);
        setStatus("Reposted");
      } catch (e) {
        setStatus("Repost failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, networkEnabled]
  );

  const handleDelete = useCallback(
    async (note: NostrEvent) => {
      if (!effectivePrivKey || !pubkey || note.pubkey !== pubkey) return;
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
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
        if (networkEnabled) publishEvent(ev as NostrEvent, relayUrls);
        setStatus("Note deleted");
      } catch (e) {
        setStatus("Delete failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, pubkey, networkEnabled]
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
        if (networkEnabled) publishEvent(ev as NostrEvent, relayUrls);
        setStatus("Bookmarked");
      } catch (e) {
        setStatus("Bookmark failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, pubkey, networkEnabled, bookmarksEvent]
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
        if (networkEnabled) publishEvent(ev as NostrEvent, relayUrls);
        setStatus("Removed from bookmarks");
      } catch (e) {
        setStatus("Unbookmark failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, pubkey, networkEnabled, bookmarksEvent]
  );

  const getRootId = useCallback((note: NostrEvent): string => {
    const eTag = note.tags.find((t) => t[0] === "e");
    return eTag ? eTag[1] : note.id;
  }, []);

  const handleReply = useCallback(
    async () => {
      if (!effectivePrivKey || !replyingTo || !replyContent.trim()) return;
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const rootId = getRootId(replyingTo);
        const tags: string[][] = [["e", rootId], ["e", replyingTo.id], ["p", replyingTo.pubkey]];
        const ev = await Nostr.finishEventAsync(
          {
            kind: 1,
            content: replyContent.trim(),
            tags,
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        setReplyingTo(null);
        setReplyContent("");
        if (networkEnabled) publishEvent(ev as NostrEvent, relayUrls);
        setStatus("Replied");
      } catch (e) {
        setStatus("Reply failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, replyingTo, replyContent, networkEnabled, getRootId]
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
      [pubkey]: {
        name: editName.trim() || undefined,
        about: editAbout.trim() || undefined,
        picture: editPicture.trim() || undefined,
        banner: editBanner.trim() || undefined,
      },
    }));
    setEditProfileOpen(false);
    if (networkEnabled) publishEvent(ev as NostrEvent, relayUrls);
    setStatus("Profile updated");
  }, [effectivePrivKey, pubkey, editName, editAbout, editPicture, editBanner, networkEnabled]);

  const handleFollow = useCallback(
    async (theirPk: string) => {
      if (!effectivePrivKey || !pubkey) return;
      const kind3 = events.find((e) => e.kind === 3 && e.pubkey === pubkey);
      const existingTags = kind3 ? kind3.tags.filter((t) => t[0] === "p") : [];
      if (existingTags.some((t) => t[1] === theirPk)) return;
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const newTags = [...existingTags.map((t) => ["p", t[1]]), ["p", theirPk]];
        const ev = await Nostr.finishEventAsync(
          { kind: 3, content: kind3?.content ?? "", tags: newTags, created_at: Math.floor(Date.now() / 1000) },
          sk
        );
        setEvents((prev) => prev.filter((e) => !(e.kind === 3 && e.pubkey === pubkey)).concat(ev as NostrEvent).sort((a, b) => b.created_at - a.created_at));
        if (networkEnabled) publishEvent(ev as NostrEvent, relayUrls);
        setStatus("Following");
      } catch (e) {
        setStatus("Follow failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, pubkey, events, networkEnabled]
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
        if (networkEnabled) publishEvent(ev as NostrEvent, relayUrls);
        setStatus("Unfollowed");
      } catch (e) {
        setStatus("Unfollow failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, pubkey, events, networkEnabled]
  );

  useEffect(() => {
    if (!privKeyHex || hasSyncedAnonRef.current) return;
    hasSyncedAnonRef.current = true;
    const anonPubkey = Nostr.getPublicKey(Nostr.hexToBytes(getOrCreateAnonKey()));
    const sk = Nostr.hexToBytes(privKeyHex);
    let cancelled = false;
    (async () => {
      const anonEvents = events.filter((e) => e.pubkey === anonPubkey);
      if (anonEvents.length === 0) return;
      const newEvents: NostrEvent[] = [];
      for (const ev of anonEvents) {
        if (cancelled) return;
        try {
          const newEv = await Nostr.finishEventAsync(
            { kind: ev.kind, content: ev.content, tags: ev.tags, created_at: ev.created_at },
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
  }, [privKeyHex]);

  return (
    <main className="app-root primal-layout">
      <header className="top-header">
        <h1 className="app-title">
          <img src="/steg.png" alt="" className="app-logo" />
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
              <img src={myPicture} alt="" className="profile-avatar" />
            ) : (
              <div className="profile-avatar placeholder">{myName.slice(0, 1)}</div>
            )}
            <strong className="profile-name">{myName}</strong>
            {myAbout && <p className="profile-about">{myAbout.slice(0, 120)}{myAbout.length > 120 ? "…" : ""}</p>}
            {isNostrLoggedIn ? (
              <p className="profile-note">From your Nostr profile (kind 0)</p>
            ) : (
              <p className="profile-note muted">Local identity · Log in to sync to Nostr</p>
            )}
            {isNostrLoggedIn ? (
              <button type="button" className="btn-secondary" onClick={handleEditProfileOpen}>Edit profile</button>
            ) : (
              <button type="button" className="btn-primary" onClick={() => setLoginFormOpen(true)}>Log in with Nostr</button>
            )}
          </div>
          <nav className="side-nav">
            <button type="button" className={view === "feed" ? "active" : ""} onClick={() => setView("feed")}>Home</button>
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
                  />
                  <button type="button" onClick={handlePost} className="btn-primary">Post</button>
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
                {searchTrim && feedItems.length === 0 && (
                  <p className="muted">
                    {searchPubkeyHex || npubStr
                      ? networkEnabled
                        ? "No notes from this pubkey yet. If we just fetched, wait a moment; otherwise they may have no public notes on these relays."
                        : "Turn Network ON to fetch this pubkey’s notes from relays, or load an image that contains their posts."
                      : "No notes match your search."}
                  </p>
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
                              <img src={profiles[ev.pubkey].picture!} alt="" />
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
                              </strong>
                              <span className="note-time">{new Date(ev.created_at * 1000).toLocaleString()}</span>
                            </div>
                            <div className="note-content">
                              {(contentWithoutImages(ev.content).trim() || ev.content.trim()) && (
                                <p>{contentWithoutImages(ev.content).trim() || ev.content}</p>
                              )}
                              {(() => {
                                const tagImg = imageUrlFromTags(ev.tags);
                                const urls = extractImageUrls(ev.content);
                                const imgs = tagImg ? [tagImg, ...urls] : urls;
                                if (imgs.length === 0) return null;
                                return (
                                  <div className="note-images">
                                    {imgs.slice(0, 4).map((url, i) => (
                                      <img key={i} src={url} alt="" className="note-img" />
                                    ))}
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
                              {ev.pubkey === pubkey && <button type="button" className="btn-delete muted" onClick={() => handleDelete(ev)} title="Delete">Delete</button>}
                            </div>
                          </div>
                        </div>
                        {replyingTo?.id === ev.id && (
                          <div className="reply-box">
                            <p className="muted">Replying to {(profiles[replyingTo.pubkey]?.name ?? replyingTo.pubkey.slice(0, 8))}…</p>
                            <textarea value={replyContent} onChange={(e) => setReplyContent(e.target.value)} placeholder="Write a reply…" rows={2} className="wide" />
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
                                    <img src={profiles[reply.pubkey].picture!} alt="" />
                                  ) : (
                                    <span>{(profiles[reply.pubkey]?.name || reply.pubkey).slice(0, 1)}</span>
                                  )}
                                </div>
                                <div className="note-body">
                                  <div className="note-meta">
                                    <strong>
                                      <button type="button" className="link-like" onClick={() => { setViewingProfilePubkey(reply.pubkey); setView("profile"); }}>
                                        {(profiles[reply.pubkey]?.name ?? `${reply.pubkey.slice(0, 8)}…`)}
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
                                    {reply.pubkey === pubkey && <button type="button" className="btn-delete muted" onClick={() => handleDelete(reply)} title="Delete">Delete</button>}
                                  </div>
                                </div>
                                {replyingTo?.id === reply.id && (
                                  <div className="reply-box reply-box-inline">
                                    <p className="muted">Replying to {(profiles[replyingTo.pubkey]?.name ?? replyingTo.pubkey.slice(0, 8))}…</p>
                                    <textarea value={replyContent} onChange={(e) => setReplyContent(e.target.value)} placeholder="Write a reply…" rows={2} className="wide" />
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
                          const other = ev.pubkey === pubkey ? ev.tags.find((t) => t[0] === "p")?.[1] : ev.pubkey;
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
                        const other = ev.pubkey === pubkey ? ev.tags.find((t) => t[0] === "p")?.[1] : ev.pubkey;
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
                            const isFromThem = ev.pubkey !== pubkey;
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
              <p className="muted">From your Nostr contact list (kind 3). Unfollow to remove; search below to add.</p>
              <div className="following-add-wrap">
                <input
                  type="text"
                  placeholder="npub or hex pubkey to follow…"
                  value={followingSearchInput}
                  onChange={(e) => setFollowingSearchInput(e.target.value)}
                  className="wide"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const pk = resolvePubkeyFromInput(followingSearchInput);
                      if (pk) { handleFollow(pk); setFollowingSearchInput(""); relayRef.current?.requestProfiles([pk]); }
                      else if (followingSearchInput.trim()) setStatus("Enter a valid npub or 64-char hex pubkey");
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    const pk = resolvePubkeyFromInput(followingSearchInput);
                    if (pk) { handleFollow(pk); setFollowingSearchInput(""); relayRef.current?.requestProfiles([pk]); }
                    else if (followingSearchInput.trim()) setStatus("Enter a valid npub or 64-char hex pubkey");
                  }}
                >
                  Add
                </button>
              </div>
              <ul className="contact-list">
                {contacts.map((pk) => (
                  <li key={pk} className="contact-list-item">
                    {profiles[pk]?.picture ? <img src={profiles[pk].picture!} alt="" className="contact-avatar" /> : <span className="contact-avatar placeholder">{pk.slice(0, 2)}</span>}
                    <button type="button" className="link-like" onClick={() => { setViewingProfilePubkey(pk); setView("profile"); }}>
                      {profiles[pk]?.name ?? `${pk.slice(0, 12)}…`}
                    </button>
                    <button type="button" className="btn-unfollow btn-secondary" onClick={() => handleUnfollow(pk)} title="Unfollow">Unfollow</button>
                  </li>
                ))}
              </ul>
              {contacts.length === 0 && <p className="muted">No one yet. Use the search above to add people.</p>}
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
                          {profiles[ev.pubkey]?.picture ? <img src={profiles[ev.pubkey].picture!} alt="" /> : <span>{(profiles[ev.pubkey]?.name || ev.pubkey).slice(0, 1)}</span>}
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
                              const tagImg = imageUrlFromTags(ev.tags);
                              const urls = extractImageUrls(ev.content);
                              const imgs = tagImg ? [tagImg, ...urls] : urls;
                              if (imgs.length === 0) return null;
                              return (
                                <div className="note-images">
                                  {imgs.slice(0, 4).map((url, i) => (
                                    <img key={i} src={url} alt="" className="note-img" />
                                  ))}
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
                                {profiles[reply.pubkey]?.picture ? <img src={profiles[reply.pubkey].picture!} alt="" /> : <span>{(profiles[reply.pubkey]?.name || reply.pubkey).slice(0, 1)}</span>}
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
                          {profiles[ev.pubkey]?.picture ? <img src={profiles[ev.pubkey].picture!} alt="" /> : <span>{(profiles[ev.pubkey]?.name || ev.pubkey).slice(0, 1)}</span>}
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
                              const tagImg = imageUrlFromTags(ev.tags);
                              const urls = extractImageUrls(ev.content);
                              const imgs = tagImg ? [tagImg, ...urls] : urls;
                              if (imgs.length === 0) return null;
                              return (
                                <div className="note-images">
                                  {imgs.slice(0, 4).map((url, i) => (
                                    <img key={i} src={url} alt="" className="note-img" />
                                  ))}
                                </div>
                              );
                            })()}
                          </div>
                          <div className="note-actions">
                            <button type="button" onClick={() => { setReplyingTo(ev); setReplyContent(""); setView("feed"); }} title="Reply">Reply</button>
                            <button type="button" onClick={() => !hasLiked(ev.id) && handleLike(ev)} title="Like" disabled={!!hasLiked(ev.id)}>{hasLiked(ev.id) ? "Liked" : "Like"} <span className="count">({likeCount})</span></button>
                            <button type="button" onClick={() => handleRepost(ev)} title="Repost">Repost</button>
                            <button type="button" onClick={() => handleUnbookmark(ev)} title="Remove bookmark">Unbookmark</button>
                            {ev.pubkey === pubkey && <button type="button" className="btn-delete muted" onClick={() => handleDelete(ev)} title="Delete">Delete</button>}
                          </div>
                        </div>
                      </div>
                      {replies.length > 0 && (
                        <ul className="note-replies">
                          {replies.map((reply) => (
                            <li key={reply.id} className="note-card note-reply">
                              <div className="note-avatar">
                                {profiles[reply.pubkey]?.picture ? <img src={profiles[reply.pubkey].picture!} alt="" /> : <span>{(profiles[reply.pubkey]?.name || reply.pubkey).slice(0, 1)}</span>}
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
                {(profiles[profileViewPubkey]?.banner ?? (profileViewPubkey === pubkey ? myBanner : null)) ? (
                  <div className="profile-banner-wrap">
                    <img src={profiles[profileViewPubkey]?.banner ?? myBanner!} alt="" className="profile-banner" />
                  </div>
                ) : (
                  <div className="profile-banner-placeholder" />
                )}
                <div className="profile-header-body">
                  {profiles[profileViewPubkey]?.picture ?? (profileViewPubkey === pubkey ? myPicture : null) ? (
                    <img src={(profiles[profileViewPubkey]?.picture ?? myPicture)!} alt="" className="profile-avatar profile-avatar-overlay" />
                  ) : (
                    <div className="profile-avatar profile-avatar-overlay placeholder">{(profiles[profileViewPubkey]?.name ?? (profileViewPubkey === pubkey ? myName : profileViewPubkey)).slice(0, 1)}</div>
                  )}
                  <strong className="profile-name">{(profileViewPubkey === pubkey ? myName : (profiles[profileViewPubkey]?.name ?? `${profileViewPubkey.slice(0, 8)}…`))}</strong>
                  <p className="profile-note pubkey-display">npub…{profileViewPubkey.slice(-12)}</p>
                  {(profiles[profileViewPubkey]?.nip05 ?? (profileViewPubkey === pubkey && myProfile?.nip05)) && (
                    <p className="profile-note profile-nip05 muted">{(profileViewPubkey === pubkey ? myProfile?.nip05 : profiles[profileViewPubkey]?.nip05)}</p>
                  )}
                  {(profiles[profileViewPubkey]?.about ?? (profileViewPubkey === pubkey ? myAbout : "")) && (
                    <p className="profile-about">{(profileViewPubkey === pubkey ? myAbout : profiles[profileViewPubkey]?.about) ?? ""}</p>
                  )}
                  <div className="profile-stats">
                    <span><strong>{profileRootNotes.length}</strong> posts</span>
                    <span><strong>{profileFollowing.length}</strong> following</span>
                    <span><strong>{profileFollowers.length}</strong> followers</span>
                  </div>
                  {profileViewPubkey === pubkey ? (
                    <button type="button" className="btn-secondary" onClick={handleEditProfileOpen}>Edit profile</button>
                  ) : (
                    contacts.includes(profileViewPubkey)
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
                          {profiles[ev.pubkey]?.picture ? <img src={profiles[ev.pubkey].picture!} alt="" /> : <span>{(profiles[ev.pubkey]?.name || ev.pubkey).slice(0, 1)}</span>}
                        </div>
                        <div className="note-body">
                          <div className="note-meta">
                            <strong>{profiles[ev.pubkey]?.name ?? `${ev.pubkey.slice(0, 8)}…`}</strong>
                            <span className="note-time">{new Date(ev.created_at * 1000).toLocaleString()}</span>
                          </div>
                          <div className="note-content">
                            {(contentWithoutImages(ev.content).trim() || ev.content.trim()) && <p>{contentWithoutImages(ev.content).trim() || ev.content}</p>}
                            {(() => {
                              const tagImg = imageUrlFromTags(ev.tags);
                              const urls = extractImageUrls(ev.content);
                              const imgs = tagImg ? [tagImg, ...urls] : urls;
                              if (imgs.length === 0) return null;
                              return (
                                <div className="note-images">
                                  {imgs.slice(0, 4).map((url, i) => (
                                    <img key={i} src={url} alt="" className="note-img" />
                                  ))}
                                </div>
                              );
                            })()}
                          </div>
                          <div className="note-actions">
                            <button type="button" onClick={() => { setReplyingTo(ev); setReplyContent(""); setView("feed"); }} title="Reply">Reply</button>
                            <button type="button" onClick={() => !hasLiked(ev.id) && handleLike(ev)} title="Like" disabled={!!hasLiked(ev.id)}>{hasLiked(ev.id) ? "Liked" : "Like"} <span className="count">({likeCount})</span></button>
                            <button type="button" onClick={() => window.open(`https://zap.stream/e/${ev.id}`, "_blank", "noopener")} title="Zap (opens zap.stream)">Zap <span className="count">({getZapCount(ev.id)})</span></button>
                            <button type="button" onClick={() => hasBookmarked(ev.id) ? handleUnbookmark(ev) : handleBookmark(ev)} title={hasBookmarked(ev.id) ? "Remove bookmark" : "Bookmark"}>{hasBookmarked(ev.id) ? "Unbookmark" : "Bookmark"}</button>
                            {ev.pubkey === pubkey && <button type="button" className="btn-delete muted" onClick={() => handleDelete(ev)} title="Delete">Delete</button>}
                          </div>
                        </div>
                      </div>
                      {replies.length > 0 && (
                        <ul className="note-replies">
                          {replies.map((reply) => (
                            <li key={reply.id} className="note-card note-reply">
                              <div className="note-avatar">
                                {profiles[reply.pubkey]?.picture ? <img src={profiles[reply.pubkey].picture!} alt="" /> : <span>{(profiles[reply.pubkey]?.name || reply.pubkey).slice(0, 1)}</span>}
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

          {view === "settings" && (
            <section className="settings-view">
              <h2>Settings</h2>
              <h3 className="settings-section">Relays</h3>
              <p className="muted">Relays used for feed and publish. Add or remove below.</p>
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
              {relayUrls.length === 0 && <p className="muted">Add at least one relay (e.g. wss://relay.damus.io).</p>}
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
            <div className="stego-actions">
              <button type="button" className="btn-stego" onClick={handleLoadFromImage}>Detect image</button>
              <button type="button" className="btn-stego btn-primary" onClick={handleSaveToImage}>Embed image</button>
            </div>
          </div>
        </aside>
      </div>

      {newMessageModalOpen && (
        <div className="modal-overlay" onClick={() => setNewMessageModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>New message</h3>
            <p className="muted">Enter their public key (npub or 64-char hex). Works for Nostr accounts and anyone with a key—share via Embed image if they’re not on Nostr.</p>
            <label>
              npub or hex pubkey
              <input type="text" value={newMessagePubkeyInput} onChange={(e) => setNewMessagePubkeyInput(e.target.value)} placeholder="npub1… or hex" className="wide" autoComplete="off" />
            </label>
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
                  } else setStatus("Enter a valid npub or 64-char hex pubkey");
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
              Picture URL
              <input type="url" value={editPicture} onChange={(e) => setEditPicture(e.target.value)} placeholder="https://…" className="wide" />
            </label>
            <label>
              Cover / banner URL
              <input type="url" value={editBanner} onChange={(e) => setEditBanner(e.target.value)} placeholder="https://…" className="wide" />
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

export default App;
