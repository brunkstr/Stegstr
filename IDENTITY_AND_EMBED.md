# Identity and embed/decode: how it works

## Fundamental: Local vs Nostr category

Every identity has a **category** that controls where its data goes:

- **Local**: Data is **only** transferred steganographically (in embedded images). Nothing from this identity is ever sent to Nostr relays, even when Network is ON.
- **Nostr**: When Network is ON, posts, profile, likes, DMs, etc. from this identity are published to Nostr relays.

You can **convert** an identity between Local and Nostr at any time (Identity screen → “Convert to Local” / “Convert to Nostr”). The same key stays; only the category (and thus whether network publish is allowed) changes.

---

## Two identity origins (type)

### 1. Local (anonymous) identity — no Nostr login

- When you **don’t** log in with Nostr, the app can create a **local identity**: an anonymous key stored only in your browser (localStorage).
- That key is a normal Nostr key (secp256k1). It has a public key and a private key (used to sign posts, DMs, etc.).
- New local identities start with **category: Local** (steganographic only). You can later **Convert to Nostr** if you want that identity’s data to go to relays when Network is ON.

### 2. Nostr (logged-in) identity

- When you **Add Nostr identity** (nsec or 64-char hex private key), the app uses that key as your identity.
- New Nostr identities start with **category: Nostr** (will sync to relays when Network ON). You can **Convert to Local** if you want that identity’s data to stay steganographic only.

So:

- **Local category**: data only in images; never published to relays.
- **Nostr category**: when Network is ON, data is published to Nostr relays.
- **Convert**: Identity screen → use “Convert to Local” / “Convert to Nostr” on any identity to switch category.

---

## Your example: local category, no network, then share via image

You:

1. Open the app.
2. Create or use a **local** identity (or add Nostr and **Convert to Local**).
3. Leave Network OFF (or ON — it doesn’t matter for Local category; nothing is published).
4. Make a post.
5. Send a message to a Nostr public key (npub/hex).
6. Choose **Embed image**: pick a cover image, save as PNG. The app **encrypts** your current state (feed + DMs + metadata) and hides it in the image.

What’s in the image:

- A **bundle** of Nostr-style **events**: your post (kind 1), your DM (kind 4), and any other events currently in the app (e.g. your profile kind 0).
- That bundle is **encrypted** so that:
  - **“Any Stegstr user”**: only the Stegstr app can decrypt it (app-level key). Any Stegstr user can open it.
  - **“Only these people”**: only the listed recipients (by pubkey) can decrypt it; the app uses NIP-04 style encryption for those recipients.

So the image contains **your** posts and **your** DMs (and whatever else was in the app at embed time), encrypted so only Stegstr (and optionally only selected recipients) can read it.

---

## How the other person sees the post and message

- They **do not** need to be logged into Nostr.
- They **do not** need to turn on Network.

They only need to:

1. Have Stegstr (or an app that understands the same embed format).
2. Use **Detect image** (or equivalent) and select the image you shared.
3. The app decodes the image, decrypts the payload (using the app key for “any Stegstr user”, or their key if they’re in the recipients list), and loads the **bundle** into their app state.

That bundle is a list of **events**. The app then:

- Merges those events into the feed (notes, DMs, etc.).
- Shows your post and your DM in their feed/messages.

So:

- **Seeing the post**: they see it because it was in the bundle you embedded; it appears in their feed after they run Detect image.
- **Seeing the message**: the DM event is in the bundle, but DMs are NIP-04 encrypted (only the sender and the recipient's private key can decrypt). So they see the DM in Messages, but to **read** the content they must be logged in as the Nostr account whose pubkey you sent the message to. Without that key, the app shows "[Decryption failed]".

**Nostr and Network:**

- The data came **from the image**, not from Nostr. No Network is needed. To **see** the post they don’t need to log in; to **read** the DM they need to log in as the Nostr account you sent it to.
- If they **later** turn Network ON and/or log in with Nostr, that doesn’t change how the already-loaded data from the image was loaded; it only affects what they fetch from relays and how their own new actions are published (and only for identities in **Nostr** category).

---

## Short answers to your questions

| Question | Answer |
|----------|--------|
| How are the post and message available to the other person? | They’re inside the image you shared, in an encrypted bundle. The other person uses **Detect image**; Stegstr decodes and decrypts the bundle and merges those events into their app (feed + messages). |
| Does the other person need to log into Nostr? | **For the post: no.** For the **DM**: **yes** (as the account you sent the message to). DMs are NIP-04 encrypted; only that account’s private key can decrypt the message content. |
| Do they need to connect to the network? | **No.** Detect image works offline. Receiving the DM doesn’t use the network; decrypting it uses their Nostr key. |
| What about the image? | The image is the transport. It carries the encrypted bundle. Once they run Detect image, the app has the same events (your post, your DM, etc.) in memory. To *read* the DM they must be logged in as that Nostr account. |
| If my identity is Local, does turning Network ON send my posts to Nostr? | **No.** Local category = data only steganographic. Only identities in **Nostr** category are published to relays when Network is ON. Use “Convert to Nostr” to allow network sync for that identity. |

---

## Summary

- **Local category**: data only in images; never published to relays, even when Network is ON.
- **Nostr category**: when Network is ON, posts and profile (etc.) are published to Nostr relays.
- **Convert**: Identity screen → “Convert to Local” / “Convert to Nostr” to switch category (same key).
- **Embed**: saves your current events (feed + DMs + …) into an image, encrypted so only Stegstr (and optionally selected recipients) can read it.
- **Detect**: reads the image, decrypts the bundle, and loads those events into the app. No Nostr login and no Network needed for that.
