// Nostr event (minimal for feed)
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrStateBundle {
  version: number;
  events: NostrEvent[];
}

export type View = "feed" | "messages" | "followers" | "notifications" | "profile" | "settings" | "bookmarks" | "explore" | "identity";

export type IdentityEntry = {
  id: string;
  privKeyHex: string;
  label: string;
  type: "local" | "nostr";
  /** local = data only steganographic (images); nostr = published to relays when Network ON. Convertible both ways. */
  category: "local" | "nostr";
  isPrivate?: boolean;
};

export type ProfileData = {
  name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  nip05?: string;
};
