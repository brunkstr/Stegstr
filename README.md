# Stegstr

Nostr client with steganographic transport for Mac (and desktop). Use your Nostr account locally, load/save feed state from images (detect/embed), and optionally connect to relays when the network toggle is ON.

## What it does

- **Log in** to your existing Nostr account (nsec or 64-char hex secret key). No internet required for login.
- **Feed**: View posts (Kind 1 events). Events come from decoded stego images or from your local posts.
- **Network toggle** (top-right): OFF = 100% local (no relay). ON = connect to Nostr relays (future).
- **Detect**: Load from image — pick a PNG that contains Stegstr data; the app extracts a Nostr state bundle and shows the feed.
- **Embed**: Save to image — serialize current feed (events + your actions) into a PNG; share that image. Others can load it with Detect.

## Run on your Mac

### Prerequisites

- Node.js 18+
- Rust (latest stable). If `cargo build` fails with `edition2024` required, run: `rustup update`
- macOS: Xcode Command Line Tools (or Xcode)

### Commands

```bash
# Install frontend deps
npm install

# Development (Vite dev server + Tauri window)
npm run tauri dev

# Production build (creates .app bundle)
npm run tauri build
```

After `npm run tauri build`, the app is in `src-tauri/target/release/bundle/` (e.g. `.app` for macOS).

## Payload format (stego)

- **Magic**: `STEGSTR` (7 bytes)
- **Length**: 4 bytes big-endian
- **Payload**: UTF-8 JSON — `{ "version": 1, "events": [ ... ] }` (array of Nostr events)

Embedded in PNG via LSB (1 bit per R/G/B channel, 3 bits per pixel).

## Nostr signing (current)

The app uses a **stub** signer in `src/nostr-stub.ts` so it runs without the `nostr-tools` npm package (which can hit registry issues). Events are created with placeholder IDs/sigs suitable for local use and for embedding in images. For full NIP-01-compliant signing (secp256k1 + Schnorr), install `nostr-tools` and switch the app to use it instead of `./nostr-stub`.

## License

MIT
