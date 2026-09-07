# Stegstr (ClawHub Skill)

Embed and decode hidden messages in PNG or JPEG images. Steganographic Nostr client—works offline, no
registration, and (with `--robust`) survives being re-shared through WhatsApp/Instagram/Telegram, which
the original PNG-only encoder does not.

## Quick install

Requires [Rust](https://rustup.rs) and git.

```bash
git clone https://github.com/akifjanjua/Stegstr.git
cd Stegstr/src-tauri && cargo build --release --bin stegstr-cli
```

Binary: `target/release/stegstr-cli` (Windows: `stegstr-cli.exe`)

Or use the optional `install.sh` script for a one-step install to `~/.local/bin`.

## Usage

Every command below accepts `--json` (one JSON object on stdout, schemas at
[`schema/cli/`](../../schema/cli/)) and exits with a stable, documented code
(`0` success; `2` capacity exceeded; `3` no payload found; `4` decryption
failure; `5` malformed input; `1` otherwise) -- see SKILL.md for the full
table. Nothing here ever prompts interactively.

| Command | Description |
|---------|-------------|
| `stegstr-cli decode image.png --json` | Extract raw payload from image (auto-detects PNG/DWT or JPEG/QIM) |
| `stegstr-cli detect image.png --json` | Decode + decrypt, print bundle JSON |
| `stegstr-cli embed cover.png -o out.png --payload @bundle.json --encrypt --json` | Hide payload in image (default: PNG, does not survive recompression) |
| `stegstr-cli embed cover.jpg -o out.jpg --payload @bundle.json --encrypt --robust --json` | Hide payload, robust to WhatsApp/Instagram/Telegram recompression |
| `stegstr-cli post "message" --output bundle.json --json` | Create Nostr note bundle |
| `stegstr-cli calibrate --sent original.jpg --received roundtripped.jpg --json` | Fingerprint a platform's re-encode pipeline from a real sent/received pair |
| `stegstr-cli mcp` | Run an MCP server over stdio exposing embed/decode/detect/calibrate as tools |

See [SKILL.md](./SKILL.md) for full documentation, JSON examples, and the
zero-human-input agent workflow, and
[`ROBUSTNESS_PORT_NOTES.md`](../../ROBUSTNESS_PORT_NOTES.md) in the repo root for what `--robust` changes
and why.

## Links

- [This fork](https://github.com/akifjanjua/Stegstr)
- [stegstr.com](https://stegstr.com) (upstream project's site; describes the original, non-robust default)
- [CLI docs](https://www.stegstr.com/wiki/cli.html)
- [For AI agents](https://www.stegstr.com/wiki/for-agents.html)
