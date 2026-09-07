/**
 * Publicity-contest referral codes.
 *
 * A participant hands out https://stegstr.com/r/CODE. When someone arrives
 * through that link (web) or types the code into Settings (desktop), the code
 * is stored locally and, for REF_TTL_DAYS, every profile (kind 0) and note
 * (kind 1) this app publishes carries an indexed `r` tag pointing at the
 * referral URL. The nightly scan on relay.stegstr.com attributes each new
 * pubkey to the first code it carried. See contest/PUBLICITY_CONTEST.md.
 *
 * The code is never sent anywhere else and can be cleared in Settings.
 */

export const REF_STORAGE_KEY = "stegstr_ref";
export const REF_URL_PREFIX = "https://stegstr.com/r/";
export const REF_TTL_DAYS = 30;
/** Unambiguous alphabet: no 0/O, 1/I/L. 4-8 chars. */
const CODE_RE = /^[A-HJ-KM-NP-Z2-9]{4,8}$/;

export interface StoredReferral {
  code: string;
  /** Unix ms when the code was stored. */
  at: number;
}

/**
 * Accepts a bare code, a referral URL, or a string with whitespace around it.
 * Returns the canonical upper-case code, or null if it is not a valid code.
 */
export function normalizeReferralCode(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim();
  const m = s.match(/\/r\/([^/?#\s]+)/i);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/[\s-]/g, "");
  return CODE_RE.test(s) ? s : null;
}

export function referralUrl(code: string): string {
  return REF_URL_PREFIX + code;
}

function readStored(): StoredReferral | null {
  try {
    const raw = localStorage.getItem(REF_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredReferral>;
    const code = normalizeReferralCode(parsed.code);
    if (!code || typeof parsed.at !== "number") return null;
    return { code, at: parsed.at };
  } catch {
    return null;
  }
}

/** The stored code whether or not it has expired; null if none. */
export function getStoredReferral(): StoredReferral | null {
  return readStored();
}

/** The code if one is stored and still within REF_TTL_DAYS, else null. */
export function getActiveReferralCode(now: number = Date.now()): string | null {
  const r = readStored();
  if (!r) return null;
  if (now - r.at > REF_TTL_DAYS * 24 * 60 * 60 * 1000) return null;
  return r.code;
}

/** Store a code (restarting the TTL) or clear it with null. Returns the canonical code or null. */
export function setReferralCode(input: string | null, now: number = Date.now()): string | null {
  const code = normalizeReferralCode(input);
  try {
    if (!code) localStorage.removeItem(REF_STORAGE_KEY);
    else localStorage.setItem(REF_STORAGE_KEY, JSON.stringify({ code, at: now } satisfies StoredReferral));
  } catch {
    /* storage unavailable: the tag is simply not added */
  }
  return code;
}

/**
 * On the web build, `/app/?ref=CODE` (set by the referral landing page) stores
 * the code. An existing, unexpired code is never overwritten by a URL, so a
 * person who already came through one link keeps that attribution.
 */
export function captureReferralFromUrl(search: string = typeof window !== "undefined" ? window.location.search : ""): string | null {
  if (!search) return null;
  const code = normalizeReferralCode(new URLSearchParams(search).get("ref"));
  if (!code) return null;
  if (getActiveReferralCode()) return getActiveReferralCode();
  return setReferralCode(code);
}

/** Appends the referral `r` tag to a tag list when a code is active. Never duplicates it. */
export function withReferralTag(tags: string[][], now: number = Date.now()): string[][] {
  const code = getActiveReferralCode(now);
  if (!code) return tags;
  const url = referralUrl(code);
  if (tags.some((t) => t[0] === "r" && t[1] === url)) return tags;
  return [...tags, ["r", url]];
}

/** The code carried by an event's tags, if any. Used by the scoreboard and tests. */
export function referralCodeFromTags(tags: string[][]): string | null {
  for (const t of tags) {
    if (t[0] === "r" && typeof t[1] === "string" && t[1].startsWith(REF_URL_PREFIX)) {
      const code = normalizeReferralCode(t[1].slice(REF_URL_PREFIX.length));
      if (code) return code;
    }
  }
  return null;
}
