export interface LoginModalProps {
  onClose: () => void;
  nsec: string;
  onNsecChange: (value: string) => void;
  onLogin: () => void;
  onGenerate: () => void;
}

export function LoginModal({ onClose, nsec, onNsecChange, onLogin, onGenerate }: LoginModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Log in with Nostr</h3>
        <p className="muted">Enter your nsec or 64-char hex private key to use your Nostr account. Your local posts will be re-signed and published.</p>
        <label>
          nsec or hex key
          <input type="password" value={nsec} onChange={(e) => onNsecChange(e.target.value)} placeholder="nsec1… or hex" className="wide" autoComplete="off" />
        </label>
        <div className="row modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" onClick={onGenerate}>Generate new key</button>
          <button type="button" onClick={onLogin} className="btn-primary">Log in</button>
        </div>
      </div>
    </div>
  );
}
