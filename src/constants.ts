/** Suffix appended to all Nostr kind 1 posts published through Stegstr */
export const STEGSTR_SUFFIX = " Sent by Stegstr.";

/** Max length for published note (common Nostr client limit) */
export const MAX_NOTE_LENGTH = 5000;

/** Max characters the user can type; remainder reserved for STEGSTR_SUFFIX */
export const MAX_NOTE_USER_CONTENT = MAX_NOTE_LENGTH - STEGSTR_SUFFIX.length;

/**
 * Ensures Nostr kind 1 content ends with " Sent by Stegstr.".
 * Appends suffix if missing; truncates to MAX_NOTE_LENGTH if over.
 */
export function ensureStegstrSuffix(content: string): string {
  let result = content;
  if (!result.endsWith(STEGSTR_SUFFIX)) {
    result = result + STEGSTR_SUFFIX;
  }
  if (result.length > MAX_NOTE_LENGTH) {
    result = result.slice(0, MAX_NOTE_LENGTH);
  }
  return result;
}
