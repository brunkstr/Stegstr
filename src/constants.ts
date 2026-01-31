/** Suffix appended to all Nostr kind 1 posts published through Stegstr */
export const STEGSTER_SUFFIX = " Sent by Stegstr.";

/** Max length for published note (common Nostr client limit) */
export const MAX_NOTE_LENGTH = 5000;

/** Max characters the user can type; remainder reserved for STEGSTER_SUFFIX */
export const MAX_NOTE_USER_CONTENT = MAX_NOTE_LENGTH - STEGSTER_SUFFIX.length;

/**
 * Ensures Nostr kind 1 content ends with " Sent by Stegstr.".
 * Appends suffix if missing; truncates to MAX_NOTE_LENGTH if over.
 */
export function ensureStegsterSuffix(content: string): string {
  let result = content;
  if (!result.endsWith(STEGSTER_SUFFIX)) {
    result = result + STEGSTER_SUFFIX;
  }
  if (result.length > MAX_NOTE_LENGTH) {
    result = result.slice(0, MAX_NOTE_LENGTH);
  }
  return result;
}
