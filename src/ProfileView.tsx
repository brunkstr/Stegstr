import * as Nostr from "./nostr-stub";
import { NoteCard, NoteThread } from "./NoteCard";
import type { NoteCardActions, NoteCardState } from "./NoteCard";
import type { NostrEvent, ProfileData, View } from "./types";

export interface ProfileViewProps {
  viewingProfilePubkey: string | null;
  setViewingProfilePubkey: React.Dispatch<React.SetStateAction<string | null>>;
  profileViewPubkey: string;
  profileDisplayKey: string;
  profiles: Record<string, ProfileData>;
  myName: string;
  myPicture: string | null;
  myAbout: string;
  myBanner: string | null;
  myProfile: ProfileData | null;
  isNostrLoggedIn: boolean;
  contactsSet: Set<string>;
  profileRootNotes: NostrEvent[];
  profileReplies: NostrEvent[];
  profileFollowing: string[];
  profileFollowers: string[];
  profileTab: "notes" | "replies";
  setProfileTab: React.Dispatch<React.SetStateAction<"notes" | "replies">>;
  getRepliesTo: (noteId: string) => NostrEvent[];
  getParentNote: (noteId: string) => NostrEvent | null;
  noteCardState: NoteCardState;
  noteCardActionsRedirectReply: NoteCardActions;
  navigateToProfile: (pk: string) => void;
  handleFollow: (pk: string) => void;
  handleUnfollow: (pk: string) => void;
  handleEditProfileOpen: () => void;
  onStatus: (msg: string) => void;
  setView: React.Dispatch<React.SetStateAction<View>>;
}

export function ProfileView({
  viewingProfilePubkey, setViewingProfilePubkey,
  profileViewPubkey, profileDisplayKey, profiles,
  myName, myPicture, myAbout, myBanner, myProfile,
  isNostrLoggedIn, contactsSet,
  profileRootNotes, profileReplies, profileFollowing, profileFollowers,
  profileTab, setProfileTab,
  getRepliesTo, getParentNote,
  noteCardState, noteCardActionsRedirectReply,
  navigateToProfile, handleFollow, handleUnfollow, handleEditProfileOpen,
  onStatus, setView,
}: ProfileViewProps) {
  return (
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
              onStatus("Copied!");
              setTimeout(() => onStatus(""), 1500);
            }}
          >
            {(() => { const npub = Nostr.nip19.npubEncode(profileViewPubkey); return npub.length > 20 ? `${npub.slice(0, 12)}…${npub.slice(-8)}` : npub; })()}
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
      {/* Profile Tabs: Notes / Replies */}
      <div className="profile-tabs">
        <button type="button" className={`profile-tab ${profileTab === "notes" ? "active" : ""}`} onClick={() => setProfileTab("notes")}>
          Notes ({profileRootNotes.length})
        </button>
        <button type="button" className={`profile-tab ${profileTab === "replies" ? "active" : ""}`} onClick={() => setProfileTab("replies")}>
          Replies ({profileReplies.length})
        </button>
      </div>

      {/* Notes Tab */}
      {profileTab === "notes" && (
        <ul className="note-list">
          {profileRootNotes.length === 0 && <p className="muted">No posts yet.</p>}
          {profileRootNotes.map((ev) => {
            const replies = getRepliesTo(ev.id).sort((a, b) => a.created_at - b.created_at);
            return (
              <NoteThread
                key={ev.id}
                event={ev}
                state={noteCardState}
                actions={{ ...noteCardActionsRedirectReply, onRepost: undefined }}
                replies={replies}
                showReplyActions={false}
              />
            );
          })}
        </ul>
      )}

      {/* Replies Tab */}
      {profileTab === "replies" && (
        <ul className="note-list">
          {profileReplies.length === 0 && <p className="muted">No replies yet.</p>}
          {profileReplies.map((reply) => {
            const eTag = reply.tags.find((t) => t[0] === "e");
            const parentId = eTag?.[1];
            const parentNote = parentId ? getParentNote(parentId) : null;
            return (
              <li key={reply.id} className="note-thread reply-thread">
                {parentNote ? (
                  <NoteCard
                    event={parentNote}
                    state={noteCardState}
                    actions={{ onNavigateProfile: navigateToProfile }}
                    showActions={false}
                    className="note-parent"
                    onClick={() => navigateToProfile(parentNote.pubkey)}
                    style={{ cursor: "pointer" }}
                    contentMaxChars={200}
                  />
                ) : (
                  <div className="note-card note-parent note-parent-missing">
                    <p className="muted">Replying to a note not loaded</p>
                  </div>
                )}
                <div className="thread-connector" />
                <NoteCard
                  event={reply}
                  state={noteCardState}
                  actions={{ ...noteCardActionsRedirectReply, onRepost: undefined }}
                />
              </li>
            );
          })}
        </ul>
      )}
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
  );
}
