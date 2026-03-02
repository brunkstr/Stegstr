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
  editBanner: string;
  onEditBannerChange: (value: string) => void;
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
  editBanner,
  onEditBannerChange,
}: EditProfileModalProps) {
  const editPfpInputRef = useRef<HTMLInputElement>(null);
  const editCoverInputRef = useRef<HTMLInputElement>(null);

  const handlePfpUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await uploadMedia(file);
      if (url) onEditPictureChange(url);
    } catch (_) {}
  };

  const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await uploadMedia(file);
      if (url) onEditBannerChange(url);
    } catch (_) {}
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
