---
name: stegstr
description: Decode and embed Stegstr payloads in PNG images. Use when the user needs to extract hidden Nostr data from a Stegstr image, encode a payload into a cover PNG, or work with steganographic social networking (Nostr-in-images, LSB/DWT). Supports CLI (stegstr-cli decode/embed) and desktop app Detect/Embed.
license: MIT
metadata:
  homepage: https://stegstr.com
  for-agents: https://www.stegstr.com/wiki/for-agents.html
---

# Stegstr

Stegstr hides Nostr messages inside PNG images using LSB/DWT steganography. Users embed their feed (posts, DMs) into images and share them; recipients use Detect to load the hidden content. No registration, works offline.

**Identity category (desktop app):** Identities are **Local** (data only in images; never sent to Nostr relays) or **Nostr** (published to relays when Network ON). Users can convert between Local and Nostr at any time. The CLI has no identity state—it only decode/embeds payloads.

## When to use this skill

- User wants to **decode** (extract) hidden data from a PNG that contains Stegstr data.
- User wants to **embed** a payload into a cover PNG (e.g. Nostr bundle, JSON).
- User mentions steganography, Nostr-in-images, Stegstr, or hiding data in images.
- User needs programmatic access (CLI or payload format) for automation or agents.

## Capabilities

| Capability | Input | Output |
|------------|--------|--------|
| **Decode** | Path to PNG with Stegstr data | Raw payload bytes (UTF-8 JSON when decrypted, or base64 if binary) |
| **Embed** | Cover image path, output path, payload (JSON string or base64) | Path to written PNG |

## CLI (headless)

Build the CLI from the Stegstr repo (same codebase as the desktop app):

```bash
cd stegstr/src-tauri
cargo build --release --bin stegstr-cli
```

Binary: `target/release/stegstr-cli` (or `stegstr-cli.exe` on Windows).

### Decode

```bash
stegstr-cli decode <path_to.png>
```

Writes raw payload to stdout. Valid UTF-8 JSON is printed as text; otherwise `base64:<data>`. Exit 0 on success.

### Embed

```bash
stegstr-cli embed <cover.png> -o <output.png> --payload <json_string>
```

Or from file: `--payload @path/to/bundle.json`. Base64: `--payload-base64 <base64_string>`. Exit 0 on success.

## Payload format

**Raw layer (embedded in image):**

- **Magic:** `STEGSTR` (7 bytes ASCII)
- **Length:** 4 bytes, big-endian
- **Payload:** Actual bytes (desktop app encrypts; CLI embeds raw)

**Decrypted payload (desktop app):** UTF-8 JSON:

```json
{ "version": 1, "events": [ ... ] }
```

`events` are Nostr-style events (kind 1 notes, kind 4 DMs, kind 0 profiles, etc.). JSON Schema: [bundle.schema.json](https://github.com/brunkstr/Stegstr/blob/main/schema/bundle.schema.json).

## Image format

PNG only (lossless). JPEG or other lossy formats will corrupt the hidden data.

## Discovery and links

- **agents.txt:** https://www.stegstr.com/agents.txt (capabilities, download URLs, key pages)
- **For agents:** https://www.stegstr.com/wiki/for-agents.html
- **Downloads:** https://github.com/brunkstr/Stegstr/releases/latest (Stegstr-macOS.dmg, Stegstr-Windows.exe, Stegstr-Linux.deb, Stegstr-Linux.AppImage)
- **GitHub:** https://github.com/brunkstr/Stegstr
