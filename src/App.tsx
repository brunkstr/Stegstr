import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as Nostr from "./nostr-stub";
import { connectRelays, publishEvent } from "./relay";
import { extractImageUrls, imageUrlFromTags, contentWithoutImages } from "./utils";
import type { NostrEvent, NostrStateBundle } from "./types";
import "./App.css";

const STEGSTR_BUNDLE_VERSION = 1;
const ANON_KEY_STORAGE = "stegstr_anon_key";

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

type View = "feed" | "messages" | "followers" | "notifications" | "profile" | "settings";

function App() {
  const [nsec, setNsec] = useState("");
  const [privKeyHex, setPrivKeyHex] = useState<string | null>(null);
  const [loginFormOpen, setLoginFormOpen] = useState(false);
  const [networkEnabled, setNetworkEnabled] = useState(false);
  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [profiles, setProfiles] = useState<Record<string, { name?: string; about?: string; picture?: string; nip05?: string }>>({});
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
  const [dmDecrypted, setDmDecrypted] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const relayRef = useRef<ReturnType<typeof connectRelays> | null>(null);

  useEffect(() => {
    if (searchQuery.trim()) setReplyingTo(null);
  }, [searchQuery]);
  const prevNetworkRef = useRef(false);
  const hasSyncedAnonRef = useRef(false);

  const effectivePrivKey = privKeyHex ?? getOrCreateAnonKey();
  const pubkey = Nostr.getPublicKey(Nostr.hexToBytes(effectivePrivKey));
  const isNostrLoggedIn = privKeyHex !== null;
  const myProfile = pubkey ? profiles[pubkey] : null;
  const myName = myProfile?.name ?? (pubkey ? `${pubkey.slice(0, 8)}…` : "");
  const myPicture = myProfile?.picture ?? null;
  const myAbout = myProfile?.about ?? "";

  const contacts = pubkey && events.find((e) => e.kind === 3 && e.pubkey === pubkey)
    ? (events.find((e) => e.kind === 3 && e.pubkey === pubkey)!.tags.filter((t) => t[0] === "p").map((t) => t[1]))
    : [];
  const dmEvents = events.filter((e) => e.kind === 4);
  const notes = events.filter((e) => e.kind === 1);
  const noteIds = new Set(notes.map((n) => n.id));
  const rootNotes = notes.filter((n) => {
    const eTag = n.tags.find((t) => t[0] === "e");
    return !eTag || !noteIds.has(eTag[1]);
  });
  const getRepliesTo = (noteId: string) =>
    notes.filter((n) => n.tags.find((t) => t[0] === "e" && t[1] === noteId));

  const myNoteIds = pubkey ? new Set(notes.filter((n) => n.pubkey === pubkey).map((n) => n.id)) : new Set<string>();
  const notificationEvents = pubkey
    ? events
        .filter(
          (e) =>
            (e.kind === 7 && e.tags.some((t) => t[0] === "p" && t[1] === pubkey)) ||
            (e.kind === 1 && e.tags.some((t) => t[0] === "e" && myNoteIds.has(t[1])))
        )
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 100)
    : [];

  const reactions = events.filter((e) => e.kind === 7);
  const getLikeCount = (noteId: string) =>
    reactions.filter((r) => r.tags.some((t) => t[0] === "e" && t[1] === noteId)).length;

  const searchLower = searchQuery.trim().toLowerCase();
  const filteredRootNotes = searchLower
    ? rootNotes.filter((n) => {
        if (n.content.toLowerCase().includes(searchLower)) return true;
        for (const t of n.tags) {
          if (t[0] === "t" && t[1]?.toLowerCase().includes(searchLower)) return true;
          if (t[1]?.toLowerCase().includes(searchLower)) return true;
        }
        return false;
      })
    : rootNotes;

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
              const meta = JSON.parse(ev.content) as { name?: string; about?: string; picture?: string; nip05?: string };
              setProfiles((p) => ({ ...p, [ev.pubkey]: meta }));
            } catch (_) {}
          }
          return Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
        });
      },
      () => setRelayStatus("Synced"),
      (err) => setRelayStatus("Error: " + (err instanceof Error ? err.message : String(err)))
    );
    return () => {
      relayRef.current?.close();
      relayRef.current = null;
      setRelayStatus("");
    };
  }, [networkEnabled, pubkey]);

  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    if (contacts.length > 0) relayRef.current.requestProfiles(contacts);
  }, [networkEnabled, contacts.join(",")]);

  useEffect(() => {
    if (!networkEnabled || !relayRef.current) return;
    const ids = rootNotes.map((n) => n.id);
    if (ids.length > 0) relayRef.current.requestReplies(ids);
  }, [networkEnabled, rootNotes.map((n) => n.id).join(",")]);

  useEffect(() => {
    if (relayStatus !== "Synced" || !relayRef.current) return;
    if (contacts.length > 0) relayRef.current.requestProfiles(contacts);
    const ids = rootNotes.map((n) => n.id);
    if (ids.length > 0) relayRef.current.requestReplies(ids);
  }, [relayStatus]);

  useEffect(() => {
    const justTurnedOn = networkEnabled && !prevNetworkRef.current;
    prevNetworkRef.current = networkEnabled;
    if (!justTurnedOn || !pubkey) return;
    setEvents((prev) => {
      const myEvents = prev.filter((e) => e.pubkey === pubkey);
      myEvents.forEach((ev) => publishEvent(ev));
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
      const bundle = JSON.parse(result.payload) as NostrStateBundle;
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
  }, []);

  const handleSaveToImage = useCallback(async () => {
    setDecodeError("");
    try {
      const coverPath = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (!coverPath || typeof coverPath !== "string") return;
      const outputPath = await saveDialog({
        filters: [{ name: "PNG", extensions: ["png"] }],
        defaultPath: "stegstr-export.png",
      });
      if (!outputPath) return;
      const payload: NostrStateBundle = { version: STEGSTR_BUNDLE_VERSION, events };
      const result = await invoke<{ ok: boolean; path?: string; error?: string }>("encode_stego_image", {
        coverPath,
        outputPath,
        payload: JSON.stringify(payload),
      });
      if (result.ok && result.path) setStatus(`Saved to ${result.path}`);
      else setDecodeError(result.error || "Encode failed");
    } catch (e) {
      setDecodeError((e as Error).message);
    }
  }, [events]);

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
    if (networkEnabled) publishEvent(ev as NostrEvent);
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
            content: "❤️",
            tags: [
              ["e", note.id],
              ["p", note.pubkey],
            ],
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        if (networkEnabled) publishEvent(ev as NostrEvent);
        setStatus("Liked");
      } catch (e) {
        setStatus("Like failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, networkEnabled]
  );

  const handleReply = useCallback(
    async () => {
      if (!effectivePrivKey || !replyingTo || !replyContent.trim()) return;
      try {
        const sk = Nostr.hexToBytes(effectivePrivKey);
        const ev = await Nostr.finishEventAsync(
          {
            kind: 1,
            content: replyContent.trim(),
            tags: [
              ["e", replyingTo.id],
              ["p", replyingTo.pubkey],
            ],
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        setEvents((prev) => [ev as NostrEvent, ...prev]);
        setReplyingTo(null);
        setReplyContent("");
        if (networkEnabled) publishEvent(ev as NostrEvent);
        setStatus("Replied");
      } catch (e) {
        setStatus("Reply failed: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [effectivePrivKey, replyingTo, replyContent, networkEnabled]
  );

  const handleEditProfileOpen = useCallback(() => {
    setEditName(myName);
    setEditAbout(myAbout);
    setEditPicture(myPicture ?? "");
    setEditProfileOpen(true);
  }, [myName, myAbout, myPicture]);

  const handleEditProfileSave = useCallback(async () => {
    if (!effectivePrivKey || !pubkey) return;
    const sk = Nostr.hexToBytes(effectivePrivKey);
    const content = JSON.stringify({
      name: editName.trim() || undefined,
      about: editAbout.trim() || undefined,
      picture: editPicture.trim() || undefined,
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
      },
    }));
    setEditProfileOpen(false);
    if (networkEnabled) publishEvent(ev as NostrEvent);
    setStatus("Profile updated");
  }, [effectivePrivKey, pubkey, editName, editAbout, editPicture, networkEnabled]);

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
          publishEvent(newEv as NostrEvent);
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
        <h1>Stegstr</h1>
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
          <button type="button" onClick={handleLoadFromImage}>Detect</button>
          <button type="button" onClick={handleSaveToImage}>Embed</button>
        </div>
      </header>

      {view === "feed" && (
        <div className="search-bar-wrap">
          <input
            type="search"
            placeholder="Search notes and hashtags…"
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
            <button type="button" className={view === "profile" ? "active" : ""} onClick={() => setView("profile")}>Profile</button>
            <button type="button" className={view === "followers" ? "active" : ""} onClick={() => setView("followers")}>Following</button>
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
                <h2 className="feed-title">Feed</h2>
                {notes.length === 0 && (
                  <p className="muted">No notes yet. Turn Network ON for relay feed, or load from image.</p>
                )}
                {searchQuery.trim() && filteredRootNotes.length === 0 && (
                  <p className="muted">No notes match your search.</p>
                )}
                <ul className="note-list">
                  {filteredRootNotes.map((ev) => {
                    const replies = getRepliesTo(ev.id).sort((a, b) => a.created_at - b.created_at);
                    const likeCount = getLikeCount(ev.id);
                    return (
                      <li key={ev.id} className="note-thread">
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
                              <strong>{(profiles[ev.pubkey]?.name ?? `${ev.pubkey.slice(0, 8)}…`)}</strong>
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
                              <button type="button" onClick={() => { setReplyingTo(ev); setReplyContent(""); }} title="Reply">💬 Reply</button>
                              <button type="button" onClick={() => handleLike(ev)} title="Like">❤️ Like {likeCount > 0 && <span className="count">({likeCount})</span>}</button>
                              <button type="button" title="Zap (coming soon)" disabled>⚡ Zap</button>
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
                                    <strong>{(profiles[reply.pubkey]?.name ?? `${reply.pubkey.slice(0, 8)}…`)}</strong>
                                    <span className="note-time">{new Date(reply.created_at * 1000).toLocaleString()}</span>
                                  </div>
                                  <div className="note-content">
                                    <p>{contentWithoutImages(reply.content).trim() || reply.content}</p>
                                  </div>
                                  <div className="note-actions">
                                    <button type="button" onClick={() => { setReplyingTo(reply); setReplyContent(""); }} title="Reply">💬 Reply</button>
                                    <button type="button" onClick={() => handleLike(reply)} title="Like">❤️ Like {replyLikeCount > 0 && <span className="count">({replyLikeCount})</span>}</button>
                                    <button type="button" title="Zap (coming soon)" disabled>⚡ Zap</button>
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
                  })}
                </ul>
              </section>
            </>
          )}

          {view === "messages" && (
            <section className="messages-view">
              <h2>Messages</h2>
              <p className="muted">Direct messages (kind 4). {dmEvents.length} events.</p>
              <ul className="event-list">
                {dmEvents.slice(0, 50).map((ev) => {
                  const otherPk = ev.pubkey === pubkey ? (ev.tags.find((t) => t[0] === "p")?.[1]) : ev.pubkey;
                  const otherName = otherPk ? (profiles[otherPk]?.name ?? `${otherPk.slice(0, 8)}…`) : "?";
                  return (
                    <li key={ev.id} className="event">
                      <span className="event-meta">{otherName} · {new Date(ev.created_at * 1000).toLocaleString()}</span>
                      <p className="event-content">{dmDecrypted[ev.id] ?? "[Decrypting…]"}</p>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {view === "followers" && (
            <section className="followers-view">
              <h2>Following</h2>
              <p className="muted">From your Nostr contact list (kind 3).</p>
              <ul className="contact-list">
                {contacts.map((pk) => (
                  <li key={pk}>
                    {profiles[pk]?.picture ? <img src={profiles[pk].picture!} alt="" className="contact-avatar" /> : <span className="contact-avatar placeholder">{pk.slice(0, 2)}</span>}
                    <span>{profiles[pk]?.name ?? `${pk.slice(0, 12)}…`}</span>
                  </li>
                ))}
              </ul>
              {contacts.length === 0 && <p className="muted">No contacts yet.</p>}
            </section>
          )}

          {view === "notifications" && (
            <section className="notifications-view">
              <h2>Notifications</h2>
              <p className="muted">Reactions and replies to your notes.</p>
              <ul className="event-list">
                {notificationEvents.map((ev) => (
                  <li key={ev.id} className="event">
                    <span className="event-meta">
                      {ev.kind === 7 ? "❤️ Like" : "💬 Reply"} from {(profiles[ev.pubkey]?.name ?? `${ev.pubkey.slice(0, 8)}…`)} · {new Date(ev.created_at * 1000).toLocaleString()}
                    </span>
                    {ev.kind === 1 && <p className="event-content">{contentWithoutImages(ev.content).trim() || ev.content}</p>}
                    {ev.kind === 7 && <p className="event-content muted">{ev.content || "❤️"}</p>}
                  </li>
                ))}
              </ul>
              {notificationEvents.length === 0 && <p className="muted">No notifications yet.</p>}
            </section>
          )}

          {view === "profile" && pubkey && (
            <section className="profile-view">
              <h2>Profile</h2>
              <div className="profile-card profile-card-main">
                {myPicture ? (
                  <img src={myPicture} alt="" className="profile-avatar" />
                ) : (
                  <div className="profile-avatar placeholder">{myName.slice(0, 1)}</div>
                )}
                <strong className="profile-name">{myName}</strong>
                <p className="profile-note pubkey-display">npub…{pubkey.slice(-12)}</p>
                {myAbout && <p className="profile-about">{myAbout}</p>}
                <button type="button" className="btn-secondary" onClick={handleEditProfileOpen}>Edit profile</button>
              </div>
            </section>
          )}

          {view === "settings" && (
            <section className="settings-view">
              <h2>Settings</h2>
              <h3 className="settings-section">Relays</h3>
              <ul className="settings-list">
                {["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol"].map((url) => (
                  <li key={url} className="muted">{url}</li>
                ))}
              </ul>
              <h3 className="settings-section">Stego</h3>
              <p className="muted">Detect: load image to extract Nostr state. Embed: save current feed to image. When Network is OFF, use images to pass state P2P. Turn Network ON to sync local changes to relays.</p>
              <p className="muted" style={{ marginTop: "0.5rem" }}>Stegstr 0.1.0</p>
            </section>
          )}
        </div>

        <aside className="sidebar right">
          <div className="widget">
            <h3>Stego</h3>
            <p className="muted">Detect: load image. Embed: save feed to image. Network OFF = stego only.</p>
          </div>
        </aside>
      </div>

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
