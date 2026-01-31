import { exchangeImagePath } from "./shared-dir.mjs";

/** @type {Record<string, string[]>} */
export const EMBED_FLOWS = {
  post: ["Create note in feed", "Click Embed image", "Select cover", "Save to exchange path"],
  reply: ["Reply to a note", "Click Embed image", "Select cover", "Save to exchange path"],
  like: ["Like a note", "Click Embed image", "Select cover", "Save to exchange path"],
  follow: ["Follow a pubkey", "Click Embed image", "Select cover", "Save to exchange path"],
  dm: ["Send DM", "Click Embed image", "Select cover", "Save to exchange path"],
  follower_list: ["View followers", "Click Embed image", "Select cover", "Save to exchange path"],
  profile: ["Edit profile", "Click Embed image", "Select cover", "Save to exchange path"],
  bookmarks: ["Add bookmark", "Click Embed image", "Select cover", "Save to exchange path"],
  recipients_envelope: ["Select recipients", "Click Embed image", "Select cover", "Save to exchange path"],
};

export const DETECT_FLOW = [
  "Click Detect image or drag-drop",
  "Select or drop exchange.png",
  "Verify events merged into feed",
];

export function getExchangePath() {
  return exchangeImagePath();
}
