/** Extracted verbatim from App.tsx (merge plan step 2). Outer state arrives via `deps`; nothing else changed. */
import { type Dispatch, type SetStateAction, useCallback, useState } from "react";
import * as Nostr from "../nostr-stub";
import { uploadMedia } from "../upload";
import { withReferralTag } from "./referral";
import * as logger from "../logger";
import type { IdentityEntry, NostrEvent, ProfileData } from "../types";

export interface ProfileAndMediaDeps {
  actingIdentity: IdentityEntry | undefined;
  canPublishToNetwork: boolean;
  effectivePrivKey: string;
  myAbout: string;
  myBanner: string | null;
  myName: string;
  myPicture: string | null;
  networkEnabled: boolean;
  pubkey: string;
  publishViaRelay: (ev: NostrEvent) => void;
  setEvents: Dispatch<SetStateAction<NostrEvent[]>>;
  setProfiles: Dispatch<SetStateAction<Record<string, ProfileData>>>;
  setStatus: Dispatch<SetStateAction<string>>;
}

export function useProfileAndMedia(deps: ProfileAndMediaDeps) {
  const { actingIdentity, canPublishToNetwork, effectivePrivKey, myAbout, myBanner, myName, myPicture, networkEnabled, pubkey, publishViaRelay, setEvents, setProfiles, setStatus } = deps;

  const [postMediaUrls, setPostMediaUrls] = useState<string[]>([]);

  const [uploadingMedia, setUploadingMedia] = useState(false);

  const [editProfileOpen, setEditProfileOpen] = useState(false);

  const [editName, setEditName] = useState("");

  const [editAbout, setEditAbout] = useState("");

  const [editPicture, setEditPicture] = useState("");

  const [editBanner, setEditBanner] = useState("");

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
        tags: withReferralTag([]),
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
    if (networkEnabled && canPublishToNetwork && !isNostr) publishViaRelay(ev as NostrEvent);
    setStatus(isNostr ? "Profile updated (local only)" : "Profile updated");
    logger.logAction("profile_edit", isNostr ? "Profile updated (local only)" : "Profile updated", { networkEnabled, isNostr });
  }, [effectivePrivKey, pubkey, editName, editAbout, editPicture, editBanner, networkEnabled, canPublishToNetwork, actingIdentity?.type]);

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
          const url = await uploadMedia(file, effectivePrivKey);
          urls.push(url);
        }
      }
      setPostMediaUrls((prev) => [...prev, ...urls]);
      setStatus(urls.length ? `Uploaded ${urls.length} file(s) to nostr.build — stored unencrypted, readable by anyone with the URL` : "Select image or video files");
    } catch (err) {
      setStatus("Upload failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setUploadingMedia(false);
    }
  }, []);

  return { editAbout, editBanner, editName, editPicture, editProfileOpen, handleEditProfileOpen, handleEditProfileSave, handlePostMediaUpload, postMediaUrls, setEditAbout, setEditBanner, setEditName, setEditPicture, setEditProfileOpen, setPostMediaUrls, setUploadingMedia, uploadingMedia };
}
