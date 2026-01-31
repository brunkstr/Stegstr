# Stegstr

Nostr client with steganographic transport for **macOS, Windows, and Linux**. Use your Nostr account locally, load/save feed state from images (detect/embed), and optionally connect to relays when the network toggle is ON.

**Nostr branding**: All posts (kind 1 notes and replies) published through Stegstr automatically end with ` Stegster` so they are identifiable as coming from this app. The compose UI enforces a character limit (4991 user chars) to reserve space for the suffix.

## What it does

- **Log in** to your existing Nostr account (nsec or 64-char hex secret key). No internet required for login.
- **Feed**: View posts (Kind 1 events). Events come from decoded stego images or from your local posts.
- **Network toggle** (top-right): OFF = 100% local (no relay). ON = connect to Nostr relays (future).
- **Detect**: Load from image — pick a PNG that contains Stegstr data; the app extracts a Nostr state bundle and shows the feed.
- **Embed**: Save to image — serialize current feed (events + your actions) into a PNG; share that image. Others can load it with Detect.

## Supported platforms

| Platform | Build command | Output |
|----------|---------------|--------|
| **macOS** | `npm run build:mac` (run on Mac) | `.app`, `.dmg` |
| **Windows** | `npm run build:win` (run on Windows) | `.exe`, `.msi` |
| **Linux** | `npm run build:linux` (run on Linux) | `.deb`, `.AppImage` |

Tauri builds for the host OS. To produce installers for all three platforms, use the included GitHub Actions workflow (`.github/workflows/build.yml`), which runs on push to `main` or `release` and uploads build artifacts for each OS.

## Prerequisites

- Node.js 18+
- Rust (latest stable). If `cargo build` fails with `edition2024` required, run: `rustup update`
- **macOS**: Xcode Command Line Tools (or Xcode)
- **Windows**: Visual Studio Build Tools (or Visual Studio) with C++ workload
- **Linux**: `libwebkit2gtk-4.1-dev`, `libssl-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`

## Commands

```bash
# Install frontend deps
npm install

# Development (Vite dev server + Tauri window)
npm run tauri dev

# Production build (creates native bundle for current OS)
npm run tauri build
# Or use platform-specific scripts: build:mac, build:win, build:linux
```

After `npm run tauri build`, the app is in `src-tauri/target/release/bundle/` (e.g. `.app` on macOS, `.exe` on Windows, `.AppImage` on Linux).

## Payload format (stego)

- **Magic**: `STEGSTR` (7 bytes)
- **Length**: 4 bytes big-endian
- **Payload**: UTF-8 JSON — `{ "version": 1, "events": [ ... ] }` (array of Nostr events)

Embedded in PNG via LSB (1 bit per R/G/B channel, 3 bits per pixel).

## Mobile (Android)

A mobile Android app is available in `mobile-android/`, forked from [Primal Android](https://github.com/PrimalHQ/primal-android-app). It includes Stegstr's steganographic Detect/Embed, " Stegster" post branding, and character limit. See [mobile-android/STEGSTR_MOBILE_README.md](mobile-android/STEGSTR_MOBILE_README.md) for build and status.

## Nostr signing (current)

The app uses a **stub** signer in `src/nostr-stub.ts` so it runs without the `nostr-tools` npm package (which can hit registry issues). Events are created with placeholder IDs/sigs suitable for local use and for embedding in images. For full NIP-01-compliant signing (secp256k1 + Schnorr), install `nostr-tools` and switch the app to use it instead of `./nostr-stub`.

## License

MIT
