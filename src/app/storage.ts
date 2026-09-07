/** Persisted-state helpers and storage keys, moved verbatim out of App.tsx (step 2 of the merge plan). */
import * as Nostr from "../nostr-stub";
import type { IdentityEntry, NostrEvent } from "../types";

export const STEGSTR_BUNDLE_VERSION = 1;
export const BASE_ANON_KEY = "stegstr_anon_key";
export const BASE_IDENTITIES = "stegstr_identities";
export const BASE_ACTING = "stegstr_acting_identity";
export const BASE_VIEWING = "stegstr_viewing_identities";
export const BASE_MUTE_PUBKEYS = "stegstr_mute_pubkeys";
export const BASE_MUTE_WORDS = "stegstr_mute_words";
export const BASE_RELAYS = "stegstr_relays";
export const BASE_ZAP_QUEUE = "stegstr_zap_queue";
export const BASE_DM_READ = "stegstr_dm_read_timestamps";
export const BASE_NOTIF_READ = "stegstr_notification_read_at";

/** Default follows for new local identities so the feed shows posts when network is on. */
export const DEFAULT_FOLLOW_NPUBS = [
  "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m", // jack
  "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6", // fiatjaf
  "npub1rs787tkd6mle8jxvqr07zngzf8h6qu5fc8g3jfdtj8xux9a6aumqkdgtgf",
  "npub1c3lf9hdmghe4l7xcy8phlhepr66hz7wp5dnkpwxjvw8x7hzh0pesc9mpv4",
  "npub1gcxzte5zlknqx26dzuyuzhhnz5q4fvnvcyn0x0cpqvjq0s8qfjds0x2df2",
];
export function getDefaultFollowPubkeys(): string[] {
  const out: string[] = [];
  for (const npub of DEFAULT_FOLLOW_NPUBS) {
    try {
      const d = Nostr.nip19.decode(npub);
      if (d.type === "npub" && d.data.length === 32) out.push(Nostr.bytesToHex(d.data));
    } catch (_) {}
  }
  return out;
}

export function getStorageProfileSync(): string | null {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search).get("profile");
  if (p) return p;
  try {
    return localStorage.getItem("stegstr_test_profile");
  } catch { return null; }
}
export function getStorageKey(base: string, profile: string | null | undefined): string {
  const prefix = profile ? `stegstr_test_${profile}_` : "";
  return prefix + base;
}

export function getOrCreateAnonKey(profile?: string | null): string {
  const key = getStorageKey(BASE_ANON_KEY, profile);
  try {
    const stored = localStorage.getItem(key);
    if (stored && /^[a-fA-F0-9]{64}$/.test(stored)) return stored;
  } catch (_) {}
  const sk = Nostr.generateSecretKey();
  const hex = Nostr.bytesToHex(sk);
  try {
    localStorage.setItem(getStorageKey(BASE_ANON_KEY, profile), hex);
  } catch (_) {}
  return hex;
}

export type QueuedZap = {
  id: string;
  noteId: string;
  event: NostrEvent;
  createdAt: number;
  zapStreamUrl: string;
};

export function loadQueuedZaps(profile: string | null): QueuedZap[] {
  try {
    const raw = localStorage.getItem(getStorageKey(BASE_ZAP_QUEUE, profile));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is QueuedZap => {
      if (typeof x !== "object" || x === null) return false;
      const z = x as QueuedZap;
      return (
        typeof z.id === "string" &&
        typeof z.noteId === "string" &&
        typeof z.zapStreamUrl === "string" &&
        typeof z.createdAt === "number" &&
        typeof z.event === "object" &&
        z.event !== null &&
        typeof (z.event as NostrEvent).id === "string"
      );
    });
  } catch (_) {
    return [];
  }
}

export function loadIdentities(profile: string | null): IdentityEntry[] {
  try {
    const raw = localStorage.getItem(getStorageKey(BASE_IDENTITIES, profile));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (x): x is IdentityEntry =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as IdentityEntry).id === "string" &&
          typeof (x as IdentityEntry).privKeyHex === "string" &&
          /^[a-fA-F0-9]{64}$/.test((x as IdentityEntry).privKeyHex)
      )
      .map((x) => {
        const ent = x as IdentityEntry;
        if (ent.category !== "local" && ent.category !== "nostr") {
          return { ...ent, category: ent.type === "nostr" ? "nostr" as const : "local" as const };
        }
        return ent;
      });
  } catch (_) {}
  return [];
}

export function migrateToIdentities(profile: string | null): IdentityEntry[] {
  const existing = loadIdentities(profile);
  if (existing.length > 0) return existing;
  const migrated: IdentityEntry[] = [];
  try {
    const anonKey = localStorage.getItem(getStorageKey(BASE_ANON_KEY, profile));
    if (anonKey && /^[a-fA-F0-9]{64}$/.test(anonKey)) {
      const pubkey = Nostr.getPublicKey(Nostr.hexToBytes(anonKey));
      migrated.push({
        id: "anon-" + pubkey.slice(0, 12),
        privKeyHex: anonKey,
        label: "Local",
        type: "local",
        category: "local",
      });
    }
  } catch (_) {}
  if (migrated.length > 0) {
    try {
      localStorage.setItem(getStorageKey(BASE_IDENTITIES, profile), JSON.stringify(migrated));
    } catch (_) {}
  }
  return migrated;
}
