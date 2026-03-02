import type { ProfileData } from "./types";

export interface NewMessageModalProps {
  onClose: () => void;
  input: string;
  onInputChange: (value: string) => void;
  profiles: Record<string, ProfileData>;
  selfPubkeys: string[];
  resolvePubkey: (input: string) => string | null;
  onSelectPeer: (pubkey: string) => void;
  onStatus: (msg: string) => void;
}

export function NewMessageModal({
  onClose,
  input,
  onInputChange,
  profiles,
  selfPubkeys,
  resolvePubkey,
  onSelectPeer,
  onStatus,
}: NewMessageModalProps) {
  const trimmed = input.trim();
  const q = trimmed.toLowerCase();
  const resolved = trimmed ? resolvePubkey(input) : null;

  const matches = trimmed && !resolved
    ? Object.entries(profiles).filter(
        ([pk, p]) => !selfPubkeys.includes(pk) &&
          (p?.name?.toLowerCase().includes(q) || (typeof p?.nip05 === "string" && p.nip05.toLowerCase().includes(q)) || pk.toLowerCase().includes(q))
      )
    : [];

  const handleOpen = () => {
    const pk = resolvePubkey(input);
    if (pk) {
      onSelectPeer(pk);
      onInputChange("");
      onClose();
    } else {
      const nameMatches = Object.entries(profiles).filter(
        ([p, pr]) => !selfPubkeys.includes(p) &&
          (pr?.name?.toLowerCase().includes(q) || (typeof pr?.nip05 === "string" && pr.nip05.toLowerCase().includes(q)))
      );
      if (nameMatches.length === 1) {
        onSelectPeer(nameMatches[0][0]);
        onInputChange("");
        onClose();
      } else if (nameMatches.length > 1) {
        onStatus("Several matches—click one above or enter npub");
      } else {
        onStatus("No match. Enter a name (from your feed) or npub/hex pubkey.");
      }
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>New message</h3>
        <p className="muted">Type their name or public key (npub/hex). Search finds people from your feed and relays.</p>
        <label>
          Name or npub/hex pubkey
          <input type="text" value={input} onChange={(e) => onInputChange(e.target.value)} placeholder="e.g. Alice or npub1…" className="wide" autoComplete="off" />
        </label>
        {trimmed && !resolved && matches.length === 0 && (
          <p className="muted">No matches. Try a different name or enter npub/hex pubkey.</p>
        )}
        {trimmed && !resolved && matches.length > 0 && (
          <div className="search-results profiles-search">
            <p className="muted">Matching profiles—click to open conversation:</p>
            <ul className="contact-list">
              {matches.slice(0, 12).map(([pk, p]) => (
                <li key={pk} className="contact-list-item">
                  {p?.picture ? <img src={p.picture} alt="" className="contact-avatar" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span className="contact-avatar placeholder">{(p?.name ?? pk).slice(0, 2)}</span>}
                  <button type="button" className="link-like" onClick={() => { onSelectPeer(pk); onInputChange(""); onClose(); }}>
                    {p?.name ?? `${pk.slice(0, 12)}…`}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="row modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={handleOpen}>
            Open conversation
          </button>
        </div>
      </div>
    </div>
  );
}
