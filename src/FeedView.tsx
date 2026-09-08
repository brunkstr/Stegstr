import type React from "react";
import { NoteThread } from "./NoteCard";
import type { NoteCardActions, NoteCardState } from "./NoteCard";
import type { NostrEvent, ProfileData, View } from "./types";
import { MAX_NOTE_USER_CONTENT } from "./constants";

export type FeedItem = { type: "note"; note: NostrEvent; sortAt: number } | { type: "repost"; repost: NostrEvent; note: NostrEvent; sortAt: number };

import { useState } from "react";
import type { PaymentAttachment } from "./wallet/attachments";
import { decodeInvoice, formatSats } from "./wallet/bolt11";
import { decodeToken, looksLikeCashuToken } from "./wallet/cashu";

export interface FeedViewProps {
  // Compose
  myPicture: string | null;
  myName: string;
  newPost: string;
  setNewPost: React.Dispatch<React.SetStateAction<string>>;
  postMediaUrls: string[];
  setPostMediaUrls: React.Dispatch<React.SetStateAction<string[]>>;
  uploadingMedia: boolean;
  postMediaInputRef: React.RefObject<HTMLInputElement | null>;
  handlePostMediaUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handlePost: () => void;
  /** Payment attachments queued for the next post, and the wallet used to create invoices. */
  postPayments: PaymentAttachment[];
  setPostPayments: React.Dispatch<React.SetStateAction<PaymentAttachment[]>>;
  walletConnected: boolean;
  makeInvoice: (sats: number, memo: string) => Promise<string | null>;
  // Feed filter
  feedFilter: "global" | "following";
  setFeedFilter: React.Dispatch<React.SetStateAction<"global" | "following">>;
  // Notes
  notesEmpty: boolean;
  feedItems: FeedItem[];
  // Search
  searchTrim: string;
  searchLower: string;
  searchNoSpaces: string;
  searchPubkeyHex: string | null;
  npubStr: string | null;
  networkEnabled: boolean;
  profiles: Record<string, ProfileData>;
  pubkey: string | null;
  // Focus
  focusedNoteId: string | null;
  notes: NostrEvent[];
  // Note rendering
  getRepliesTo: (noteId: string) => NostrEvent[];
  noteCardState: NoteCardState;
  noteCardActions: NoteCardActions;
  replyingTo: NostrEvent | null;
  replyContent: string;
  onReplyContentChange: React.Dispatch<React.SetStateAction<string>>;
  handleReply: () => void;
  handleReplyCancel: () => void;
  // Infinite scroll
  loadingMore: boolean;
  loadMoreSentinelRef: React.RefObject<HTMLDivElement | null>;
  // Navigation
  setViewingProfilePubkey: React.Dispatch<React.SetStateAction<string | null>>;
  setView: React.Dispatch<React.SetStateAction<View>>;
}

export function FeedView({
  myPicture, myName, newPost, setNewPost, postMediaUrls, setPostMediaUrls,
  uploadingMedia, postMediaInputRef, handlePostMediaUpload, handlePost,
  postPayments, setPostPayments, walletConnected, makeInvoice,
  feedFilter, setFeedFilter,
  notesEmpty, feedItems,
  searchTrim, searchLower, searchNoSpaces, searchPubkeyHex, npubStr, networkEnabled,
  profiles, pubkey,
  focusedNoteId, notes,
  getRepliesTo, noteCardState, noteCardActions,
  replyingTo, replyContent, onReplyContentChange, handleReply, handleReplyCancel,
  loadingMore, loadMoreSentinelRef,
  setViewingProfilePubkey, setView,
}: FeedViewProps) {
  const [payForm, setPayForm] = useState<"none" | "invoice" | "cashu">("none");
  const [reqSats, setReqSats] = useState("");
  const [reqMemo, setReqMemo] = useState("");
  const [cashuInput, setCashuInput] = useState("");
  const [payError, setPayError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const addInvoice = async () => {
    const sats = Number(reqSats);
    if (!Number.isInteger(sats) || sats <= 0) { setPayError("Enter a whole number of sats."); return; }
    setMaking(true); setPayError(null);
    const inv = await makeInvoice(sats, reqMemo.trim());
    setMaking(false);
    if (!inv) { setPayError("The wallet did not return an invoice."); return; }
    setPostPayments((p) => [...p, { type: "bolt11", value: inv }]);
    setReqSats(""); setReqMemo(""); setPayForm("none");
  };
  const addCashu = () => {
    const raw = cashuInput.trim().replace(/^cashu:/i, "");
    if (!looksLikeCashuToken(raw)) { setPayError("That does not look like a Cashu token (cashuA… or cashuB…)."); return; }
    try { decodeToken(raw); } catch (e) { setPayError("Token could not be read: " + (e instanceof Error ? e.message : String(e))); return; }
    setPostPayments((p) => [...p, { type: "cashu", value: raw }]);
    setCashuInput(""); setPayError(null); setPayForm("none");
  };
  const chipLabel = (a: PaymentAttachment) => {
    try {
      if (a.type === "bolt11") { const d = decodeInvoice(a.value); return `Lightning ${formatSats(d.amountSat)}${d.description ? " · " + d.description : ""}`; }
      const t = decodeToken(a.value); return `Ecash ${t.amount} ${t.unit}`;
    } catch { return a.type === "bolt11" ? "Lightning invoice" : "Ecash"; }
  };
  return (
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
          {postPayments.length > 0 && (
            <div className="post-media-preview">
              {postPayments.map((a, i) => (
                <span key={i} className="post-payment-chip">
                  {chipLabel(a)}
                  <button type="button" className="btn-remove muted" onClick={() => setPostPayments((p) => p.filter((_, j) => j !== i))} title="Remove">×</button>
                </span>
              ))}
            </div>
          )}
          {payForm === "invoice" && (
            <div className="compose-payment-form">
              <input type="number" min={1} step={1} placeholder="sats" value={reqSats} onChange={(e) => setReqSats(e.target.value)} style={{ width: "7rem" }} aria-label="Amount in sats" />
              <input type="text" placeholder="what for (optional)" value={reqMemo} onChange={(e) => setReqMemo(e.target.value)} maxLength={80} aria-label="Invoice memo" />
              <button type="button" className="btn-secondary" onClick={addInvoice} disabled={making}>{making ? "Creating…" : "Add invoice"}</button>
              <button type="button" className="btn-secondary" onClick={() => { setPayForm("none"); setPayError(null); }}>Cancel</button>
            </div>
          )}
          {payForm === "cashu" && (
            <div className="compose-payment-form">
              <p className="muted" style={{ width: "100%", margin: 0 }}>Ecash on a post is first come, first served: anyone who sees the post, or detects the image it is hidden in, can take it, and only the first one gets it. To pay one particular person, use Request sats or send them a Lightning invoice instead.</p>
              <textarea placeholder="Paste a Cashu token (cashuA… or cashuB…) from your ecash wallet" value={cashuInput} onChange={(e) => setCashuInput(e.target.value)} aria-label="Cashu token" />
              <button type="button" className="btn-secondary" onClick={addCashu}>Add ecash</button>
              <button type="button" className="btn-secondary" onClick={() => { setPayForm("none"); setPayError(null); }}>Cancel</button>
            </div>
          )}
          {payError && <p className="muted" style={{ color: "#c33" }}>{payError}</p>}
          <div className="compose-actions">
            <input ref={postMediaInputRef} type="file" accept="image/*,video/*" multiple className="hidden-input" onChange={handlePostMediaUpload} />
            <button type="button" className="btn-secondary" onClick={() => postMediaInputRef.current?.click()} disabled={uploadingMedia} title="Add photo or video">
              {uploadingMedia ? "Uploading…" : "Attach"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setPayForm(payForm === "invoice" ? "none" : "invoice")} disabled={!walletConnected} title={walletConnected ? "Add a Lightning invoice readers can pay" : "Connect a Lightning wallet in Settings first"}>Request sats</button>
            <button type="button" className="btn-secondary" onClick={() => setPayForm(payForm === "cashu" ? "none" : "cashu")} title="Attach a Cashu ecash token: first to redeem keeps it">Attach ecash</button>
            <button type="button" onClick={handlePost} className="btn-primary" disabled={(!newPost.trim() && postMediaUrls.length === 0 && postPayments.length === 0) || uploadingMedia}>Post</button>
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
        {notesEmpty && (
          <p className="muted">No notes yet. Turn Network ON for relay feed, or load from image.</p>
        )}
        {searchTrim && (
          <>
            {(() => {
              const profileMatches = Object.entries(profiles).filter(
                ([pk, p]) => pk !== pubkey &&
                  ((searchPubkeyHex && pk === searchPubkeyHex) ||
                    p?.name?.toLowerCase().includes(searchLower) ||
                    (typeof p?.nip05 === "string" && p.nip05.toLowerCase().includes(searchLower)) ||
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
                        : "Turn Network ON to fetch this pubkey's notes from relays, or load an image that contains their posts."
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
              const isFocused = !!(rootIdForFocus && ev.id === rootIdForFocus);
              return (
                <NoteThread
                  key={item.type === "repost" ? item.repost.id : ev.id}
                  event={ev}
                  state={noteCardState}
                  actions={noteCardActions}
                  replies={replies}
                  repostEvent={item.type === "repost" ? item.repost : undefined}
                  isFocused={isFocused}
                  showReplyActions={true}
                  replyingTo={replyingTo}
                  replyContent={replyContent}
                  onReplyContentChange={onReplyContentChange}
                  onReplySend={handleReply}
                  onReplyCancel={handleReplyCancel}
                />
              );
            });
          })()}
          {loadingMore && (
            <li key="loading-more" className="loading-more-indicator">
              <p className="muted">Loading more…</p>
            </li>
          )}
          <li key="load-more-sentinel" aria-hidden="true">
            <div ref={loadMoreSentinelRef} style={{ height: 1, visibility: "hidden" }} />
          </li>
        </ul>
      </section>
    </>
  );
}
