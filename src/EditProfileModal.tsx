import { useRef } from "react";
import { uploadMedia } from "./upload";

export interface EditProfileModalProps {
  onClose: () => void;
  onSave: () => void;
  editName: string;
  onEditNameChange: (value: string) => void;
  editAbout: string;
  onEditAboutChange: (value: string) => void;
  editPicture: string;
  onEditPictureChange: (value: string) => void;
  /** Hex private key of the acting identity; uploads are NIP-98 signed with it. */
  privKeyHex: string;
  /** Called with a human-readable message when an upload fails. Without it, failures would be silent. */
  onError?: (message: string) => void;
  editBanner: string;
  onEditBannerChange: (value: string) => void;
}

/** One clear sentence about why an upload failed and what to do instead. */
export function uploadFailureMessage(what: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const hint = /401|nip-98|unauthori[sz]ed/i.test(detail)
    ? "The image host rejected the signed (NIP-98) request; make sure an identity is selected and try again."
    : "Check your connection and try again.";
  return `${what} upload failed. ${hint} You can paste an image URL instead. (${detail.slice(0, 160)})`;
}

export function EditProfileModal({
  onClose,
  onSave,
  editName,
  onEditNameChange,
  editAbout,
  onEditAboutChange,
  editPicture,
  onEditPictureChange,
  privKeyHex,
  onError,
  editBanner,
  onEditBannerChange,
}: EditProfileModalProps) {
  const editPfpInputRef = useRef<HTMLInputElement>(null);
  const editCoverInputRef = useRef<HTMLInputElement>(null);

  const handlePfpUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await uploadMedia(file, privKeyHex);
      if (url) onEditPictureChange(url);
    } catch (err) {
      onError?.(uploadFailureMessage("Profile picture", err));
    } finally {
      e.target.value = "";
    }
  };

  const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await uploadMedia(file, privKeyHex);
      if (url) onEditBannerChange(url);
    } catch (err) {
      onError?.(uploadFailureMessage("Banner", err));
    } finally {
      e.target.value = "";
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Edit profile</h3>
        <label>
          Name
          <input type="text" value={editName} onChange={(e) => onEditNameChange(e.target.value)} placeholder="Display name" className="wide" />
        </label>
        <label>
          About
          <textarea value={editAbout} onChange={(e) => onEditAboutChange(e.target.value)} placeholder="Bio" rows={3} className="wide" />
        </label>
        <label>
          Picture
          <div className="edit-media-row">
            <input type="url" value={editPicture} onChange={(e) => onEditPictureChange(e.target.value)} placeholder="https://… or upload" className="wide" />
            <input ref={editPfpInputRef} type="file" accept="image/*" className="hidden-input" onChange={handlePfpUpload} />
            <button type="button" className="btn-secondary" onClick={() => editPfpInputRef.current?.click()}>Choose file</button>
          </div>
        </label>
        <label>
          Cover / banner
          <div className="edit-media-row">
            <input type="url" value={editBanner} onChange={(e) => onEditBannerChange(e.target.value)} placeholder="https://… or upload" className="wide" />
            <input ref={editCoverInputRef} type="file" accept="image/*" className="hidden-input" onChange={handleCoverUpload} />
            <button type="button" className="btn-secondary" onClick={() => editCoverInputRef.current?.click()}>Choose file</button>
            <p className="muted" style={{ fontSize: "12px", marginTop: "6px" }}>Uploads go to nostr.build, signed by your identity, and are stored unencrypted — anyone with the URL can view them. Paste a URL to use an image hosted elsewhere.</p>
          </div>
        </label>
        <div className="row modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" onClick={onSave} className="btn-primary">Save</button>
        </div>
      </div>
    </div>
  );
}
