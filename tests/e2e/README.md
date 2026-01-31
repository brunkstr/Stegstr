# Stegstr E2E Testing

Two-instance steganographic testing: embed → save → detect flow across network and Nostr state permutations.

## Quick Start (Minimal Clicks)

When running with a test profile (`npm run launch:both`), each instance shows **Detect from exchange** and **Embed to exchange** buttons.

**Quick test (3 clicks total):**
1. Build: `npm run build:mac`
2. Launch: `npm run launch:both`
3. **Instance A**: Post something → click **Embed to exchange** → pick a cover image
4. **Instance B**: Click **Detect from exchange**
5. Verify B sees the post.

No file dialogs for save/detect—exchange path is `/tmp/stegstr-test-exchange/exchange.png`.

## Permutation Matrix

| # | Instance A | Instance B | Focus |
|---|------------|------------|-------|
| 1 | No Nostr, Network OFF | No Nostr, Network OFF | 100% local both |
| 2 | No Nostr, Network ON | No Nostr, Network OFF | One has network |
| 3 | No Nostr, Network OFF | No Nostr, Network ON | Reverse |
| 4 | No Nostr, Network ON | No Nostr, Network ON | Both network, no Nostr |
| 5 | Nostr, Network OFF | Nostr, Network OFF | Both Nostr, no sync |
| 6 | Nostr, Network ON | Nostr, Network OFF | One syncs |
| 7 | Nostr, Network OFF | Nostr, Network ON | Reverse |
| 8 | Nostr, Network ON | Nostr, Network ON | Full sync both |
| 9 | Nostr, Network ON | No Nostr, Network OFF | Mixed identities |
| 10 | No Nostr, Network OFF | Nostr, Network ON | Reverse mixed |

## Actions to Test

For each permutation: post, reply, like, follow, DM, follower_list, profile, bookmarks, recipients_envelope.

## WebDriver (Linux/Windows)

- Install `tauri-driver`: `cargo install tauri-driver --locked`
- Linux: `webkit2gtk-driver` or `WebKitWebDriver`
- Windows: `msedgedriver` matching your Edge version
- Run: `npx wdio run tests/e2e/wdio.conf.ts`

## macOS WebDriver

Tauri's built-in WebDriver does **not** support macOS. For automated E2E on macOS, CrabNebula's `tauri-plugin-automation` is required. Until that plugin is added, use the semi-manual flow above.

## Shared Exchange Path

Images are exchanged via `/tmp/stegstr-test-exchange/exchange.png`. Ensure both instances can read/write this path.

## Logging

**App logs** (Stegstr desktop): Written to `~/Library/Application Support/Stegstr/stegstr.log` (macOS) or equivalent data dir on Windows/Linux. JSONL format; includes actions (detect, embed, post, reply, follow, DM, etc.) and errors. Use for debugging and applying fixes to other platform versions.

**Test harness logs**: `tests/e2e/test-run.log` — JSONL with platform, timestamps, and pass/fail. Run `npm run test:e2e` to generate.
