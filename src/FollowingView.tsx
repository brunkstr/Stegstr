import type { ProfileData, View } from "./types";
import type { ConnectRelaysResult } from "./relay";

export interface FollowingViewProps {
  followingSearchInput: string;
  setFollowingSearchInput: React.Dispatch<React.SetStateAction<string>>;
  contactsSet: Set<string>;
  profiles: Record<string, ProfileData>;
  pubkey: string | null;
  resolvePubkeyFromInput: (input: string) => string | null;
  handleFollow: (pk: string) => void;
  handleUnfollow: (pk: string) => void;
  relayRef: React.RefObject<ConnectRelaysResult | null>;
  onStatus: (msg: string) => void;
  onNavigateProfile: (pk: string) => void;
  setView: React.Dispatch<React.SetStateAction<View>>;
}

export function FollowingView({
  followingSearchInput, setFollowingSearchInput, contactsSet, profiles, pubkey,
  resolvePubkeyFromInput, handleFollow, handleUnfollow, relayRef, onStatus,
  onNavigateProfile, setView,
}: FollowingViewProps) {
  const handleAdd = () => {
    const pk = resolvePubkeyFromInput(followingSearchInput);
    if (pk) { handleFollow(pk); setFollowingSearchInput(""); relayRef.current?.requestProfiles([pk]); }
    else if (followingSearchInput.trim()) {
      const matches = Object.entries(profiles).filter(
        ([pk, p]) => pk !== pubkey && !contactsSet.has(pk) &&
          (p?.name?.toLowerCase().includes(followingSearchInput.trim().toLowerCase()) ||
            (typeof p?.nip05 === "string" && p.nip05.toLowerCase().includes(followingSearchInput.trim().toLowerCase())))
      );
      if (matches.length === 0) onStatus("No match. Enter npub, hex pubkey, or try a name from your feed.");
    }
  };

  const searchQ = followingSearchInput.trim().toLowerCase();
  const showSearchResults = followingSearchInput.trim() && !resolvePubkeyFromInput(followingSearchInput);
  const searchMatches = showSearchResults
    ? Object.entries(profiles).filter(
        ([pk, p]) => pk !== pubkey && !contactsSet.has(pk) &&
          (p?.name?.toLowerCase().includes(searchQ) ||
            (typeof p?.nip05 === "string" && p.nip05.toLowerCase().includes(searchQ)))
      )
    : [];

  return (
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
          onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
        />
        <button type="button" className="btn-primary" onClick={handleAdd}>Add</button>
      </div>
      {showSearchResults && searchMatches.length > 0 && (
        <div className="search-results profiles-search">
          <p className="muted">Profiles matching &quot;{followingSearchInput.trim()}&quot;</p>
          <ul className="contact-list">
            {searchMatches.map(([pk, p]) => (
              <li key={pk} className="contact-list-item">
                {p?.picture ? <img src={p.picture} alt="" className="contact-avatar" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span className="contact-avatar placeholder">{(p?.name ?? pk).slice(0, 2)}</span>}
                <button type="button" className="link-like" onClick={() => { onNavigateProfile(pk); setView("profile"); }}>
                  {p?.name ?? `${pk.slice(0, 12)}…`}
                </button>
                <button type="button" className="btn-primary" onClick={() => { handleFollow(pk); setFollowingSearchInput(""); relayRef.current?.requestProfiles([pk]); onStatus("Following"); }}>Add</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="contact-list">
        {[...contactsSet].map((pk) => (
          <li key={pk} className="contact-list-item">
            {profiles[pk]?.picture ? <img src={profiles[pk].picture!} alt="" className="contact-avatar" /> : <span className="contact-avatar placeholder">{pk.slice(0, 2)}</span>}
            <button type="button" className="link-like" onClick={() => { onNavigateProfile(pk); setView("profile"); }}>
              {profiles[pk]?.name ?? `${pk.slice(0, 12)}…`}
            </button>
            <button type="button" className="btn-unfollow btn-secondary" onClick={() => handleUnfollow(pk)} title="Unfollow">Unfollow</button>
          </li>
        ))}
      </ul>
      {contactsSet.size === 0 && <p className="muted">No one yet. Use the search above to add people.</p>}
    </section>
  );
}
