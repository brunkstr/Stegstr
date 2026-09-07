---
name: stegstr
summary: Embed and decode hidden messages in PNG or JPEG images. Steganographic Nostr client for hiding data in images—works offline, no registration, and (with --robust) survives being re-shared through WhatsApp/Instagram/Telegram.
description: Decode and embed Stegstr payloads in images. Use when the user needs to extract hidden Nostr data from a Stegstr image, encode a payload into a cover image, or work with steganographic social networking (Nostr-in-images) -- including cases where the image will be shared through WhatsApp, Instagram, Telegram, or similar platforms that recompress uploads (use `embed --robust` for that). Supports CLI (stegstr-cli decode, detect, embed, post, calibrate) with --json output and stable exit codes for scripts and AI agents, and an MCP server (stegstr-cli mcp) for MCP-speaking agent clients.
license: MIT
tags: steganography, nostr, images, crypto, integration, file-management, automation, cli, mcp
install:
  requirements: |
    - Rust (latest stable) - https://rustup.rs
    - Git
  steps: |
    1. git clone https://github.com/akifjanjua/Stegstr.git
    2. cd Stegstr/src-tauri && cargo build --release --bin stegstr-cli
    3. Binary: target/release/stegstr-cli (Windows: stegstr-cli.exe)
permissions:
  - filesystem
metadata:
  homepage: https://stegstr.com
  for-agents: https://www.stegstr.com/wiki/for-agents.html
  repo: https://github.com/akifjanjua/Stegstr
---

# Stegstr

Stegstr hides Nostr messages and arbitrary payloads inside PNG or JPEG images
using steganography. Users embed their feed (posts, DMs, JSON) into images
and share them; recipients use Detect to load the hidden content. No
registration, works offline.

## When to use this skill

- User wants to **decode** (extract) hidden data from a PNG or JPEG that
  contains Stegstr data.
- User wants to **embed** a payload into a cover image (e.g. Nostr bundle,
  JSON, text).
- User mentions steganography, Nostr-in-images, Stegstr, hiding data in
  images, or secret messages in photos.
- User wants to know what a platform's re-encode pipeline actually does to
  an image (**calibrate**).
- User needs programmatic access for automation, scripts, or AI agents --
  either the CLI's `--json` mode, or the **MCP server** (`stegstr-cli mcp`).

## Zero-human-input flow: an image and a message to a shareable stego file

This is the complete path an agent needs, with no interactive step anywhere
and no output that has to be eyeballed to parse:

```bash
stegstr-cli embed cover.jpg -o out.jpg --robust --payload "your message" --json
```

That's it for plain text. `--json` on stdout tells you exactly what happened:

```json
{"ok":true,"encoder":"qim","output_path":"out.jpg","output_bytes":93634,"encrypted":false}
```

`out.jpg` is ready to send through WhatsApp, Instagram, or Telegram (that's
what `--robust` is for -- see "Image format" below). If `ok` is `false`,
check `error.kind` and the process exit code (see "Exit codes"); nothing
in this CLI ever pauses to ask a question, on a TTY or not (see
"No interactive prompts").

For a full Nostr bundle instead of plain text, create it first with `post`,
then embed its `bundle` field (not the whole `post --json` object -- see the
worked example below):

```bash
stegstr-cli post "your message" --json
```

## CLI (headless)

Build the CLI from the Stegstr repo:

```bash
git clone https://github.com/akifjanjua/Stegstr.git
cd Stegstr/src-tauri
cargo build --release --bin stegstr-cli
```

Binary: `target/release/stegstr-cli` (or `stegstr-cli.exe` on Windows).

### `--json` on every command

Every command below accepts `--json`. With it, exactly one JSON object goes
to stdout and nothing else -- no prose, no mixed output. Without it, the
original human-readable behavior is unchanged (raw payload/bundle JSON to
stdout, status lines to stderr). Schemas for every shape are committed at
[`schema/cli/*.schema.json`](../../schema/cli/) and validated against the
real binary in `src-tauri/tests/cli_json_schema.rs` -- if you're generating
a parser from these schemas, they're the source of truth, not this file.

### Exit codes

Stable across all commands; branch on the code, not on stderr text:

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Invalid usage (missing/bad arguments) or an otherwise-unclassified error |
| `2` | Capacity exceeded -- the payload doesn't fit in the cover under the requested encoder |
| `3` | No payload found -- the image was read fine but contains no Stegstr payload |
| `4` | Decryption failure -- `--encrypt`/`--decrypt` failed (wrong format, bad auth tag, corrupted input) |
| `5` | Malformed input -- unreadable/unrecognized image, invalid base64/hex, non-UTF-8 text where UTF-8 was required |

In `--json` mode the exit code always matches `error.kind` in the emitted
JSON (`capacity_exceeded`, `no_payload_found`, `decryption_failure`,
`malformed_input`, or `generic_error` for exit 1) -- check either one.

### No interactive prompts

Nothing in this CLI reads stdin interactively or blocks on a question, with
or without a TTY attached. `--yes` is accepted on every command as a no-op,
for scripts that want to pass it defensively.

### Decode (extract payload)

```bash
stegstr-cli decode image.png --json
stegstr-cli decode image.jpg --json
```

```json
{"ok":true,"encoder":"qim","decrypted":false,"payload":"base64:aGVsbG8=","payload_encoding":"base64"}
```

`payload_encoding` is `"utf8"` when the raw payload is JSON-shaped text
(printed as-is), `"base64"` otherwise (printed as `base64:<data>`).
`encoder` reports which of the two formats actually matched (`"dwt"` for
the default PNG encoder, `"qim"` for `--robust`'s JPEG encoder) -- both are
tried automatically, so you don't need to know in advance which one
produced an image you were handed. Exit 0 on success, `3` if the image has
no Stegstr payload at all, `5` if the file isn't a readable image.

### Detect (decode + decrypt app bundle)

```bash
stegstr-cli detect image.png --json
```

```json
{"ok":true,"encoder":"dwt","bundle":{"version":1,"events":[{"id":"...","pubkey":"...","created_at":1700000000,"kind":1,"tags":[],"content":"...","sig":"..."}]}}
```

Decodes and decrypts in one step; `bundle` is the parsed Nostr bundle object
(see [`schema/bundle.schema.json`](../../schema/bundle.schema.json)), not a
JSON-encoded string. Exit `4` if the payload isn't app-encrypted or
decryption fails, `3` if there's no payload at all.

### Embed (hide payload in image)

```bash
# Default (PNG, DWT): does NOT survive being re-uploaded to WhatsApp, Instagram, Telegram, or
# similar platforms -- they all re-encode images as JPEG, which destroys spatial-domain LSBs.
# Use this only when you know the image will never be re-compressed (e.g. local/offline use).
stegstr-cli embed cover.png -o out.png --payload "text or JSON" --json
stegstr-cli embed cover.png -o out.png --payload @bundle.json --json
stegstr-cli embed cover.png -o out.png --payload @bundle.json --encrypt --json

# Robust (JPEG, QIM): survives WhatsApp/Instagram/Telegram recompression. Use this whenever the
# image might be shared through a platform that re-compresses it -- i.e. almost always. Output
# must be a .jpg path.
stegstr-cli embed cover.jpg -o out.jpg --payload @bundle.json --robust --json
stegstr-cli embed cover.jpg -o out.jpg --payload @bundle.json --robust --robustness max --json
```

```json
{"ok":true,"encoder":"qim","output_path":"out.jpg","output_bytes":93634,"encrypted":false}
```

Use `--payload @file` to load from file (also the only way to pass a payload
too large for a single command-line argument -- Windows caps this well
under 50KB). Use `--encrypt` so any Stegstr user can detect. Use
`--payload-base64 <base64>` for binary payloads. `--robustness standard`
targets WhatsApp/Instagram/Telegram at higher output resolution;
`--robustness max` (implied default when `--robust` is set) also survives
Twitter/X-style aggressive downscaling. Exit `2` if the payload doesn't fit
the cover, `5` if the cover can't be read.

### Post (create kind 1 note bundle)

```bash
stegstr-cli post "Your message here" --json
stegstr-cli post "Message" --privkey-hex <64-char-hex> --json
```

```json
{"ok":true,"bundle":{"version":1,"events":[{"id":"...","pubkey":"...","created_at":1700000000,"kind":1,"tags":[],"content":"Your message here Sent by Stegstr.","sig":"..."}]},"output_path":null}
```

Creates a Nostr bundle. **Embed `bundle`, not the whole `post --json`
object** -- `ok`/`output_path` are envelope fields, not part of the payload.
With `--output bundle.json`, the same JSON is also written to that path and
`output_path` reflects it.

### Calibrate (channel fingerprinting)

Compares a file you sent through a real platform against what came back,
and infers that platform's actual re-encode pipeline -- useful for an agent
deciding how aggressively to embed, or for building up ground truth about a
platform whose behavior isn't already known:

```bash
stegstr-cli calibrate --sent original.jpg --received roundtripped.jpg --json
```

```json
{"ok":true,"profile_name":"roundtripped","profiles_out":"channel_profiles.toml","sent":{"path":"original.jpg","width":576,"height":360},"received":{"path":"roundtripped.jpg","width":576,"height":360},"resize_rule":"none (dimensions unchanged)","jpeg_quality":80,"jpeg_quality_exact":true,"jpeg_quality_match_error":0.0,"chroma_subsampling":"4:4:4","progressive":false,"metadata_stripped":"measured","metadata_exif_stripped":false,"metadata_icc_stripped":false}
```

`jpeg_quality_exact: true` means the recovered quantization table is a
byte-exact match to the standard scaling curve at that quality -- genuinely
exact, not a guess; `false` means best-fit (reported with
`jpeg_quality_match_error`), since a platform's own encoder isn't guaranteed
to use unmodified standard scaling. `jpeg_quality`/`chroma_subsampling`/
`progressive` are `null` when `--received` isn't a JPEG (nothing to
measure), and `metadata_stripped` is `"not_applicable..."` (with the exif/
icc fields `null`) unless both `--sent` and `--received` are JPEG. Writes/
updates a named profile in `channel_profiles.toml` (`--name`,
`--profiles-out` to change either); this is a single-sample forensic
inference, not a certified platform database -- see `resize_rule`'s value
for exactly how conservatively unrecognized geometry changes are labeled.

### MCP server

```bash
stegstr-cli mcp
```

Runs an MCP server over stdio exposing `embed`, `decode`, `detect`, and
`calibrate` as tools -- point an MCP-speaking client (e.g. Claude Code's
`claude mcp add`) at this command. Each tool's input schema and description
are generated from the same request types the CLI itself validates against;
each tool's result is the identical JSON shape as the matching CLI command's
`--json` output (wrapped in MCP's `content`/`isError` envelope -- a failed
tool call sets `isError: true` with the same `{"ok":false,"error":{...}}`
body, not a protocol-level failure). There's no `post` or `mcp` tool exposed
(create a bundle with the `post` command/skill workflow above, then pass its
`bundle` field to the `embed` tool's `payload`).

If you're driving this server by hand over a raw pipe rather than through a
real MCP client: keep stdin open until you've read every response you're
waiting for. A real client holds the connection open for the server's whole
lifetime; closing stdin the instant you're done writing can race the
server's still-in-flight response.

## Example workflow

```bash
# Create a post bundle
stegstr-cli post "Hello from OpenClaw" --json
# -> {"ok":true,"bundle":{...},"output_path":null} -- extract the "bundle" field

# Embed the bundle into a cover image, robust to being re-shared through WhatsApp/Instagram/Telegram
# (encrypted for any Stegstr user)
stegstr-cli embed cover.jpg -o stego.jpg --payload '{"version":1,"events":[...]}' --encrypt --robust --json

# Recipient detects and extracts -- works whether they send you a .jpg or .png,
# and whether it went through a platform's recompression or not
stegstr-cli detect stego.jpg --json
```

## Image format

Two encoders, selected by the `--robust` flag on `embed` (decode/detect auto-detect which was used):

- **Default (PNG, DWT):** lossless only. JPEG or other lossy re-encoding -- including what WhatsApp,
  Instagram, Telegram, and similar platforms do automatically on upload -- will corrupt the hidden data.
  Only safe if the image will never be re-compressed after embedding.
- **`--robust` (JPEG, QIM):** embeds in the JPEG DCT domain specifically so it survives being
  re-compressed by those platforms. This is what almost every real sharing scenario needs; see
  [`ROBUSTNESS_PORT_NOTES.md`](../../ROBUSTNESS_PORT_NOTES.md) in the repo root for validation details
  (45/45 across 9 realistic cover types x WhatsApp/Instagram/Telegram/Facebook/Twitter, confirmed with
  real WhatsApp and Instagram sends, not just simulation).

## Payload format

- **Magic:** `STEGSTR` (7 bytes ASCII)
- **Length:** 4 bytes, big-endian
- **Payload:** UTF-8 JSON or raw bytes (desktop app encrypts; CLI can embed raw or `--encrypt`)

Decrypted bundle: `{ "version": 1, "events": [ ... Nostr events ... ] }`. Schema: [bundle.schema.json](https://raw.githubusercontent.com/akifjanjua/Stegstr/main/schema/bundle.schema.json).

## Links

- **This fork:** https://github.com/akifjanjua/Stegstr
- **What changed and why:** [`ROBUSTNESS_PORT_NOTES.md`](../../ROBUSTNESS_PORT_NOTES.md) in the repo root
- **CLI JSON schemas:** [`schema/cli/`](../../schema/cli/) in the repo root
- **agents.txt:** https://www.stegstr.com/agents.txt (upstream project's site, describes the original,
  non-robust behavior -- prefer this file and `ROBUSTNESS_PORT_NOTES.md` for this fork)
- **For agents:** https://www.stegstr.com/wiki/for-agents.html
- **CLI docs:** https://www.stegstr.com/wiki/cli.html
