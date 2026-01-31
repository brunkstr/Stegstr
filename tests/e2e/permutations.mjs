/** @typedef {{ network: boolean; nostr: boolean }} InstanceState */
/** @typedef {{ id: number; a: InstanceState; b: InstanceState; description: string }} Permutation */
/** @typedef {'post'|'reply'|'like'|'follow'|'dm'|'follower_list'|'profile'|'bookmarks'|'recipients_envelope'} Action */

/** @type {Permutation[]} */
export const PERMUTATIONS = [
  { id: 1, a: { network: false, nostr: false }, b: { network: false, nostr: false }, description: "100% local both" },
  { id: 2, a: { network: true, nostr: false }, b: { network: false, nostr: false }, description: "A has network, B local" },
  { id: 3, a: { network: false, nostr: false }, b: { network: true, nostr: false }, description: "B has network, A local" },
  { id: 4, a: { network: true, nostr: false }, b: { network: true, nostr: false }, description: "Both network, no Nostr" },
  { id: 5, a: { network: false, nostr: true }, b: { network: false, nostr: true }, description: "Both Nostr, no sync" },
  { id: 6, a: { network: true, nostr: true }, b: { network: false, nostr: true }, description: "A syncs, B Nostr offline" },
  { id: 7, a: { network: false, nostr: true }, b: { network: true, nostr: true }, description: "B syncs, A Nostr offline" },
  { id: 8, a: { network: true, nostr: true }, b: { network: true, nostr: true }, description: "Full sync both" },
  { id: 9, a: { network: true, nostr: true }, b: { network: false, nostr: false }, description: "Mixed: A Nostr+net, B local" },
  { id: 10, a: { network: false, nostr: false }, b: { network: true, nostr: true }, description: "Mixed: B Nostr+net, A local" },
];

/** @type {Action[]} */
export const ACTIONS = [
  "post", "reply", "like", "follow", "dm",
  "follower_list", "profile", "bookmarks", "recipients_envelope",
];
