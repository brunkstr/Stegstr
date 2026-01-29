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
