# Identity and embed/decode: how it works

## Two identity modes

### 1. Local (anonymous) identity — no Nostr login

- When you **don’t** log in with Nostr, the app creates or reuses an **anonymous key** stored only in your browser (localStorage: `stegstr_anon_key`).
- That key is a normal Nostr key (secp256k1). It has a public key (your “local” identity) and a private key (used to sign posts, DMs, etc.).
- **Nothing** is sent to relays until you turn **Network** ON. All posts and DMs stay in the app and in any image you embed.

### 2. Nostr (logged-in) identity

- When you **Log in with Nostr** (nsec or hex private key), the app uses that key as your identity.
- Your **existing local posts** (from the anonymous key) are **re-signed** with the Nostr key and **published to relays** once when you first turn Network ON after login (so they appear on Nostr under your account).
- From then on, all new posts, likes, DMs, etc. are signed with the Nostr key and, if Network is ON, published to relays.

So:

- **Local only**: anonymous key, everything stays on device (and in images you share).
- **Nostr login**: your Nostr key; local-only content can be “synced up” once when you turn Network ON; after that, everything can go to relays when Network is ON.

---

## Your example: no login, no network, then share via image

You:

1. Open the app.
2. Do **not** log in with Nostr.
3. Do **not** turn on Network.
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
- If they **later** turn Network ON and/or log in with Nostr, that doesn’t change how the already-loaded data from the image was loaded; it only affects what they fetch from relays and how their own new actions are published.

---

## Short answers to your questions

| Question | Answer |
|----------|--------|
| How are the post and message available to the other person? | They’re inside the image you shared, in an encrypted bundle. The other person uses **Detect image**; Stegstr decodes and decrypts the bundle and merges those events into their app (feed + messages). |
| Does the other person need to log into Nostr? | **For the post: no.** For the **DM**: **yes** (as the account you sent the message to). DMs are NIP-04 encrypted; only that account’s private key can decrypt the message content. |
| Do they need to connect to the network? | **No.** Detect image works offline. Receiving the DM doesn’t use the network; decrypting it uses their Nostr key. |
| What about the image? | The image is the transport. It carries the encrypted bundle. Once they run Detect image, the app has the same events (your post, your DM, etc.) in memory. To *read* the DM they must be logged in as that Nostr account. |

---

## Summary

- **Local (no Nostr login)**: anonymous key, everything local; you can still embed that state into an image and share it.
- **Embed**: saves your current events (feed + DMs + …) into an image, encrypted so only Stegstr (and optionally selected recipients) can read it.
- **Detect**: reads the image, decrypts the bundle, and loads those events into the app. No Nostr login and no Network needed for that.
- **Two identities**: (1) local anonymous key, or (2) Nostr key after login; “sync to Nostr” happens when you turn Network ON after logging in (re-sign and publish your previous local-only events once).
