//! Stegstr CLI: headless decode, embed, detect, post, and calibrate for
//! scripts and AI agents. Build with: cargo build --release --bin stegstr-cli
//!
//! Agent-operability contract (see README.md "AI agent operability" and
//! schema/cli/*.schema.json for the exact shapes):
//! - `--json` on every command: exactly one JSON object on stdout, nothing
//!   else. Human-readable prose only ever goes to stderr, and only when
//!   `--json` is absent.
//! - Exit codes are stable and documented (see `ExitCode` below and
//!   README.md's "Exit codes" table) -- callers should branch on the code,
//!   not parse stderr text.
//! - Never reads stdin interactively. There is nothing in this binary that
//!   prompts today; `--yes` is accepted (and is a no-op) so scripts that
//!   pass it defensively against future prompts don't break, and this file
//!   is the enforcement point if an interactive prompt is ever proposed.

use base64::Engine;
use secp256k1::Secp256k1;
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

// `#[path]`, not the usual src/bin/stegstr_cli/{calibrate,mcp}.rs directory
// form: Tauri's bundler (deb/msi at least) has a known issue discovering the
// right binary output path when a package has multiple [[bin]] targets,
// and switching this binary to the directory-module layout was enough to
// trigger it in CI (see BUGS.md's AI-agent-operability entry) even though
// nothing in Cargo.toml's declared bin *name* changed. Keeping this file
// flat at src/bin/stegstr_cli.rs -- exactly the layout that built cleanly
// before this feature existed -- and pulling the submodules in from
// src/bin_support/ (deliberately outside src/bin/, so cargo's default
// binary auto-discovery never sees them as their own targets) avoids it.
#[path = "../bin_support/calibrate.rs"]
mod calibrate;
#[path = "../bin_support/mcp.rs"]
mod mcp;

const STEGSTR_SUFFIX: &str = " Sent by Stegstr.";
const MAX_NOTE_LENGTH: usize = 5000;

/// Stable process exit codes. Documented in README.md's "Exit codes" table --
/// treat this enum and that table as one contract; change them together.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
enum ExitCode {
    /// Never explicitly constructed -- a successful command just returns
    /// `Ok(())` from `main`, which is exit code 0 already. Kept as a named
    /// variant purely so the documented 0-5 table has one enum backing all
    /// six values, not five named plus a bare 0 nobody defines in code.
    #[allow(dead_code)]
    Success = 0,
    /// Invalid CLI usage (missing/bad args) or any error that doesn't fit
    /// one of the more specific codes below.
    GenericError = 1,
    /// The payload does not fit in the cover under the requested encoder.
    CapacityExceeded = 2,
    /// The image was read successfully but contains no Stegstr payload.
    NoPayloadFound = 3,
    /// A payload was found but --encrypt/--decrypt (AES-GCM app-layer
    /// encryption) failed: wrong format, bad auth tag, or corrupted input.
    DecryptionFailure = 4,
    /// The input itself is malformed: unreadable/unrecognized image,
    /// invalid base64/hex, non-UTF-8 text where UTF-8 was required.
    MalformedInput = 5,
}

impl ExitCode {
    fn kind_str(self) -> &'static str {
        match self {
            ExitCode::Success => "ok",
            ExitCode::GenericError => "generic_error",
            ExitCode::CapacityExceeded => "capacity_exceeded",
            ExitCode::NoPayloadFound => "no_payload_found",
            ExitCode::DecryptionFailure => "decryption_failure",
            ExitCode::MalformedInput => "malformed_input",
        }
    }
}

/// A classified CLI error: an exit code plus the underlying message.
/// Constructed only at call sites that know *which* operation failed (see
/// the `classify_*` helpers below) -- never by sniffing an arbitrary error
/// string for keywords. Each classification here is tied to an exact,
/// source-verified error literal from stego.rs / stego_qim.rs /
/// stego_crypto.rs, cited in the comment next to it.
struct CliError {
    code: ExitCode,
    message: String,
}

impl CliError {
    fn generic(message: impl Into<String>) -> Self {
        CliError { code: ExitCode::GenericError, message: message.into() }
    }
    fn malformed(message: impl Into<String>) -> Self {
        CliError { code: ExitCode::MalformedInput, message: message.into() }
    }
}

/// Classify a `decode_any`-style failure. `stego::decode`'s only two failure
/// shapes (see stego.rs) are: the literal "Not a Stegstr image (magic not
/// found)" once every tile-aligned and whole-image search has failed (no
/// payload embedded at all -- NoPayloadFound), or an error propagated from
/// `load_image_with_orientation` / dimension checks when the file can't be
/// read as an image in the first place (MalformedInput). QIM decode failures
/// are swallowed by decode_any/decode_any_verbose before this is ever
/// called (an unreadable-as-QIM file falls through to the DWT decoder, same
/// as decode_any in lib.rs), so this only ever sees stego::decode's error.
fn classify_decode_error(message: String) -> CliError {
    if message == "Not a Stegstr image (magic not found)" {
        CliError { code: ExitCode::NoPayloadFound, message }
    } else {
        CliError { code: ExitCode::MalformedInput, message }
    }
}

/// Classify an `encode` failure. Both encoders' only capacity-related error
/// starts with the literal prefix "Payload too large" (stego.rs's
/// "Payload too large: need {} bits, image has {} (no tile had capacity)"
/// and stego_qim.rs's "Payload too large: need {} coefficients
/// (header+codeword x redundancy), have {}") -- everything else an encoder
/// can fail with (can't read cover image, dimensions too small, not a JPEG
/// for the QIM path) is a malformed/unusable cover, not a capacity problem.
fn classify_encode_error(message: String) -> CliError {
    if message.starts_with("Payload too large") {
        CliError { code: ExitCode::CapacityExceeded, message }
    } else {
        CliError { code: ExitCode::MalformedInput, message }
    }
}

/// Classify a `stego_crypto::encrypt_app` / `decrypt_app` failure. The call
/// site is unambiguous (only ever invoked for the app-layer AES-GCM step),
/// so unlike decode/encode this needs no message inspection at all.
fn classify_crypto_error(message: String) -> CliError {
    CliError { code: ExitCode::DecryptionFailure, message }
}

fn usage() -> &'static str {
    r#"stegstr-cli — Stegstr command-line interface

Usage:
  stegstr-cli decode <image.png|.jpg> [--decrypt] [--json]
  stegstr-cli detect <image.png|.jpg> [--json]
  stegstr-cli embed <cover> -o <out> --payload <string|@file> [--encrypt] [--payload-base64] [--robust|--robustness standard|max] [--json]
  stegstr-cli post "content" [--privkey-hex HEX] [--output bundle.json] [--json]
  stegstr-cli calibrate --sent <original> --received <roundtripped> [--name <profile>] [--profiles-out <path>] [--json]
  stegstr-cli mcp

Global flags (accepted by every subcommand):
  --json    Emit exactly one JSON object to stdout, nothing else. See
            schema/cli/*.schema.json for exact shapes. Errors also emit a
            JSON object (to stdout, not stderr) with a stable "kind" field;
            the process exit code always reflects the failure kind
            regardless of --json (see README.md's "Exit codes" table).
  --yes     Accepted, currently a no-op: this CLI never prompts
            interactively, on a TTY or not. Pass it defensively in scripts
            if you like; it costs nothing and protects against a future
            prompt being added without this flag to suppress it.

Decode:
  Writes payload to stdout. With --decrypt: decrypts Stegstr app-layer and prints bundle JSON.
  Without --decrypt: raw payload (JSON text or base64:<data>). Exit 0 on success.
  Tries both encoders automatically (robust JPEG/QIM, then PNG/DWT) -- you don't
  need to know which one produced an image you were sent.

Detect:
  Decodes image and decrypts; prints Nostr bundle JSON { "version": 1, "events": [...] }.

Embed:
  --payload <string>     Payload as UTF-8 string (bundle JSON for full feed)
  --payload @<path>      Payload from file (e.g. --payload @bundle.json)
  --payload-base64 <b64> Payload as base64 string
  --encrypt              Encrypt with app key before embedding (any Stegstr user can detect)
  -o, --output <path>    Output image path (required for embed; .png for default, .jpg for --robust)
  --robust                Use the JPEG/QIM encoder: survives WhatsApp, Instagram, and Telegram
                           recompression (validated in channel_simulator/). Output is a .jpg.
                           Without this flag, embed uses the original PNG/DWT encoder, which does
                           NOT survive being re-uploaded to any of those platforms.
  --robustness <standard|max>
                           Implies --robust. "standard" targets WhatsApp/Instagram/Telegram at
                           higher output resolution; "max" (default when --robust is set) also
                           survives Twitter/X-style aggressive downscaling.

Post:
  Creates a kind 1 Nostr note with Stegstr suffix. Outputs bundle JSON to stdout or --output file.
  --privkey-hex <hex>    Nostr secret key (64-char hex). If omitted, a new key is generated for this run.

Calibrate:
  Compares a sent original against the file received back after a platform
  round trip, and infers that platform's re-encode pipeline: resize rule,
  JPEG quality (exact, recovered from quantization tables), chroma
  subsampling, progressive/baseline, whether metadata was stripped. Writes
  the inferred profile to channel_profiles.toml (--profiles-out to change
  the path). See BUGS.md and README.md for what's inferred vs. exact.
  --sent <path>          The original file, before sending through the platform.
  --received <path>      The file downloaded back after the platform round trip.
  --name <profile>       Profile name to write under (default: <received>'s file stem).
  --profiles-out <path>  Where to write/update the TOML profile (default: ./channel_profiles.toml).

Mcp:
  Runs an MCP server over stdio, exposing embed/decode/detect/calibrate as
  tools for MCP-speaking agent clients. See README.md's "MCP server" section.
"#
}

/// True if `--json` is present anywhere in argv (checked before per-command
/// parsing so usage/parse errors can also be reported as JSON).
fn wants_json(args: &[String]) -> bool {
    args.iter().any(|a| a == "--json")
}

/// Strip global flags (--json, --yes) that every subcommand accepts, so
/// per-command parsers don't need to special-case them.
fn strip_global_flags(args: &[String]) -> Vec<String> {
    args.iter().filter(|a| a.as_str() != "--json" && a.as_str() != "--yes").cloned().collect()
}

fn emit_error_and_exit(err: CliError, json: bool) -> ! {
    if json {
        let obj = serde_json::json!({
            "ok": false,
            "error": { "kind": err.code.kind_str(), "message": err.message }
        });
        println!("{}", obj);
    } else {
        eprintln!("error: {}", err.message);
    }
    std::process::exit(err.code as i32);
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let json = wants_json(&args[1..]);
    if args.len() < 2 {
        eprintln!("{}", usage());
        std::process::exit(ExitCode::GenericError as i32);
    }
    let sub = args[1].clone();
    let rest = strip_global_flags(&args[2..]);

    let result = match sub.as_str() {
        "decode" => run_decode(&rest, json),
        "detect" => run_detect(&rest, json),
        "embed" => run_embed(&rest, json),
        "post" => run_post(&rest, json),
        "calibrate" => calibrate::run(&rest, json),
        "mcp" => {
            if let Err(e) = mcp::run() {
                eprintln!("mcp error: {}", e);
                std::process::exit(ExitCode::GenericError as i32);
            }
            return;
        }
        _ => {
            eprintln!("{}", usage());
            std::process::exit(ExitCode::GenericError as i32);
        }
    };

    if let Err(e) = result {
        emit_error_and_exit(e, json);
    }
}

/// Try QIM (JPEG/DCT) first, then DWT (PNG), same order and fallback
/// behavior as `stegstr_lib::decode_any` -- but also reports which encoder
/// actually produced the payload, for --json output. Does not modify or
/// call `decode_any` itself, so its existing behavior/callers (the desktop
/// app doesn't use it at all; this CLI is decode_any's only caller) are
/// untouched.
fn decode_any_verbose(path: &Path) -> Result<(Vec<u8>, &'static str), String> {
    if let Ok(Some(payload)) = stegstr_lib::stego_qim::decode(path) {
        return Ok((payload, "qim"));
    }
    stegstr_lib::stego::decode(path).map(|p| (p, "dwt"))
}

fn payload_to_text(payload: &[u8]) -> (String, &'static str) {
    match String::from_utf8(payload.to_vec()) {
        Ok(s) if s.trim_start().starts_with('{') => (s, "utf8"),
        _ => (
            format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(payload)),
            "base64",
        ),
    }
}

fn run_decode(args: &[String], json: bool) -> Result<(), CliError> {
    let mut decrypt = false;
    let mut image_path: Option<&str> = None;
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "--decrypt" {
            decrypt = true;
        } else if !a.starts_with('-') && image_path.is_none() {
            image_path = Some(a);
        }
        i += 1;
    }
    let path_str = image_path.ok_or_else(|| CliError::generic("decode requires <image.png>"))?;
    let path = Path::new(path_str);

    let (payload, encoder) = decode_any_verbose(path).map_err(classify_decode_error)?;

    if decrypt {
        if !stegstr_lib::stego_crypto::is_encrypted_payload(&payload) {
            return Err(CliError {
                code: ExitCode::DecryptionFailure,
                message: "Payload is not Stegstr app-encrypted (use without --decrypt for raw)".to_string(),
            });
        }
        let decrypted = stegstr_lib::stego_crypto::decrypt_app(&payload).map_err(classify_crypto_error)?;
        if json {
            let obj = serde_json::json!({
                "ok": true, "encoder": encoder, "decrypted": true,
                "payload": decrypted, "payload_encoding": "utf8"
            });
            println!("{}", obj);
        } else {
            io::stdout().write_all(decrypted.as_bytes()).map_err(|e| CliError::generic(e.to_string()))?;
        }
        return Ok(());
    }

    let (text, encoding) = payload_to_text(&payload);
    if json {
        let obj = serde_json::json!({
            "ok": true, "encoder": encoder, "decrypted": false,
            "payload": text, "payload_encoding": encoding
        });
        println!("{}", obj);
    } else {
        io::stdout().write_all(text.as_bytes()).map_err(|e| CliError::generic(e.to_string()))?;
    }
    Ok(())
}

fn run_detect(args: &[String], json: bool) -> Result<(), CliError> {
    let image_path = args
        .iter()
        .find(|a| !a.starts_with('-'))
        .ok_or_else(|| CliError::generic("detect requires <image.png>"))?;
    let path = Path::new(image_path);

    let (payload, encoder) = decode_any_verbose(path).map_err(classify_decode_error)?;
    let bundle_text = if stegstr_lib::stego_crypto::is_encrypted_payload(&payload) {
        stegstr_lib::stego_crypto::decrypt_app(&payload).map_err(classify_crypto_error)?
    } else {
        String::from_utf8(payload).map_err(|e| CliError::malformed(e.to_string()))?
    };

    if json {
        let bundle: serde_json::Value =
            serde_json::from_str(&bundle_text).map_err(|e| CliError::malformed(format!("bundle is not valid JSON: {e}")))?;
        let obj = serde_json::json!({ "ok": true, "encoder": encoder, "bundle": bundle });
        println!("{}", obj);
    } else {
        io::stdout().write_all(bundle_text.as_bytes()).map_err(|e| CliError::generic(e.to_string()))?;
    }
    Ok(())
}

fn run_embed(args: &[String], json: bool) -> Result<(), CliError> {
    let mut cover: Option<&str> = None;
    let mut output: Option<&str> = None;
    let mut payload_str: Option<String> = None;
    let mut payload_base64: Option<String> = None;
    let mut encrypt = false;
    let mut robust = false;
    let mut robustness = stegstr_lib::stego_qim::Robustness::default();

    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "-o" || a == "--output" {
            i += 1;
            output = Some(args.get(i).ok_or_else(|| CliError::generic("missing value for -o/--output"))?);
        } else if a == "--payload" {
            i += 1;
            let v = args.get(i).ok_or_else(|| CliError::generic("missing value for --payload"))?;
            if let Some(path) = v.strip_prefix('@') {
                payload_str = Some(fs::read_to_string(path).map_err(|e| CliError::malformed(e.to_string()))?);
            } else {
                payload_str = Some(v.clone());
            }
        } else if a == "--payload-base64" {
            i += 1;
            payload_base64 = Some(args.get(i).ok_or_else(|| CliError::generic("missing value for --payload-base64"))?.clone());
        } else if a == "--encrypt" {
            encrypt = true;
        } else if a == "--robust" {
            robust = true;
        } else if a == "--robustness" {
            i += 1;
            let v = args.get(i).ok_or_else(|| CliError::generic("missing value for --robustness (standard|max)"))?;
            robust = true;
            robustness = match v.as_str() {
                "standard" => stegstr_lib::stego_qim::Robustness::Standard,
                "max" => stegstr_lib::stego_qim::Robustness::Max,
                other => return Err(CliError::generic(format!("unknown --robustness value: {other} (expected standard|max)"))),
            };
        } else if !a.starts_with('-') && cover.is_none() {
            cover = Some(a);
        }
        i += 1;
    }

    let cover_path = cover.ok_or_else(|| CliError::generic("embed requires <cover.png>"))?;
    let output_path = output.ok_or_else(|| CliError::generic("embed requires -o/--output <out.png|out.jpg>"))?;

    let mut payload_bytes: Vec<u8> = if let Some(b64) = payload_base64 {
        base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|e| CliError::malformed(format!("invalid --payload-base64: {e}")))?
    } else if let Some(s) = payload_str {
        s.into_bytes()
    } else {
        return Err(CliError::generic("embed requires --payload <string|@file> or --payload-base64 <b64>"));
    };

    if encrypt {
        let plaintext = String::from_utf8(payload_bytes)
            .map_err(|e| CliError::malformed(format!("--encrypt requires UTF-8 payload text: {e}")))?;
        payload_bytes = stegstr_lib::stego_crypto::encrypt_app(&plaintext).map_err(classify_crypto_error)?;
    }

    let (out_bytes, encoder) = if robust {
        (
            stegstr_lib::stego_qim::encode(Path::new(cover_path), &payload_bytes, robustness).map_err(classify_encode_error)?,
            "qim",
        )
    } else {
        (
            stegstr_lib::stego::encode(Path::new(cover_path), &payload_bytes).map_err(classify_encode_error)?,
            "dwt",
        )
    };
    let out_len = out_bytes.len();
    fs::write(output_path, out_bytes).map_err(|e| CliError::generic(e.to_string()))?;

    if json {
        let obj = serde_json::json!({
            "ok": true, "encoder": encoder, "output_path": output_path,
            "output_bytes": out_len, "encrypted": encrypt
        });
        println!("{}", obj);
    } else {
        eprintln!("Wrote {}", output_path);
    }
    Ok(())
}

fn ensure_stegstr_suffix(content: &str) -> String {
    let mut s = content.to_string();
    if !s.ends_with(STEGSTR_SUFFIX) {
        s.push_str(STEGSTR_SUFFIX);
    }
    if s.len() > MAX_NOTE_LENGTH {
        s.truncate(MAX_NOTE_LENGTH);
    }
    s
}

/// Create a NIP-01 kind 1 event and return (id_hex, pubkey_hex, created_at, sig_hex) for bundle JSON.
fn create_kind1_event(content: &str, sk: &secp256k1::SecretKey) -> Result<(String, String, u64, String), String> {
    let secp = Secp256k1::new();
    let pk = secp256k1::Keypair::from_secret_key(&secp, sk);
    let (xonly, _parity) = pk.x_only_public_key();
    let pubkey_hex = hex::encode(xonly.serialize());
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let tags: Vec<Vec<String>> = vec![];
    let serialized = serde_json::to_string(&serde_json::json!([0, pubkey_hex, created_at, 1, tags, content]))
        .map_err(|e| e.to_string())?;
    let id_hash = Sha256::digest(serialized.as_bytes());
    let id_hex = hex::encode(id_hash);
    let msg = secp256k1::Message::from_digest_slice(id_hash.as_ref()).map_err(|e| e.to_string())?;
    let keypair = secp256k1::Keypair::from_secret_key(&secp, sk);
    let sig = secp.sign_schnorr_no_aux_rand(&msg, &keypair);
    let sig_hex = hex::encode(sig.serialize());
    Ok((id_hex, pubkey_hex, created_at, sig_hex))
}

fn run_post(args: &[String], json: bool) -> Result<(), CliError> {
    let mut content: Option<String> = None;
    let mut privkey_hex: Option<String> = None;
    let mut output_path: Option<&str> = None;
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "--privkey-hex" {
            i += 1;
            privkey_hex = Some(args.get(i).ok_or_else(|| CliError::generic("missing value for --privkey-hex"))?.clone());
        } else if a == "--output" {
            i += 1;
            output_path = Some(args.get(i).ok_or_else(|| CliError::generic("missing value for --output"))?);
        } else if !a.starts_with('-') && content.is_none() {
            content = Some(a.clone());
        }
        i += 1;
    }
    let content = content.ok_or_else(|| CliError::generic("post requires content (e.g. post \"Hello world\")"))?;
    let content_with_suffix = ensure_stegstr_suffix(&content);
    let sk = if let Some(hex) = privkey_hex {
        let bytes = hex::decode(hex.trim()).map_err(|e| CliError::malformed(format!("invalid --privkey-hex: {e}")))?;
        secp256k1::SecretKey::from_slice(&bytes).map_err(|e| CliError::malformed(format!("invalid --privkey-hex: {e}")))?
    } else {
        secp256k1::SecretKey::new(&mut rand::thread_rng())
    };
    let (id_hex, pubkey_hex, created_at, sig_hex) =
        create_kind1_event(&content_with_suffix, &sk).map_err(CliError::generic)?;
    let event = serde_json::json!({
        "id": id_hex,
        "pubkey": pubkey_hex,
        "created_at": created_at,
        "kind": 1,
        "tags": [],
        "content": content_with_suffix,
        "sig": sig_hex
    });
    let bundle = serde_json::json!({
        "version": 1,
        "events": [event]
    });
    let bundle_json = serde_json::to_string_pretty(&bundle).map_err(|e| CliError::generic(e.to_string()))?;

    if let Some(path) = output_path {
        fs::write(path, &bundle_json).map_err(|e| CliError::generic(e.to_string()))?;
    }

    if json {
        let obj = serde_json::json!({ "ok": true, "bundle": bundle, "output_path": output_path });
        println!("{}", obj);
    } else if let Some(path) = output_path {
        eprintln!("Wrote {}", path);
    } else {
        io::stdout().write_all(bundle_json.as_bytes()).map_err(|e| CliError::generic(e.to_string()))?;
    }
    Ok(())
}

/// True if this process should behave as fully non-interactive: stdin isn't
/// a TTY, or `--yes` was passed. Nothing in this binary currently prompts,
/// so this has no callers yet -- it exists as the documented, tested
/// enforcement point for the "never prompts" contract (README.md's
/// "No interactive prompts" section), so a future prompt can't be added
/// without going through this check.
#[allow(dead_code)]
fn is_noninteractive(args: &[String]) -> bool {
    !io::stdin().is_terminal() || args.iter().any(|a| a == "--yes")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_decode_error_no_payload() {
        let e = classify_decode_error("Not a Stegstr image (magic not found)".to_string());
        assert_eq!(e.code, ExitCode::NoPayloadFound);
    }

    #[test]
    fn classify_decode_error_malformed() {
        let e = classify_decode_error("Image too small or dimensions not even".to_string());
        assert_eq!(e.code, ExitCode::MalformedInput);
    }

    #[test]
    fn classify_encode_error_capacity_dwt() {
        let e = classify_encode_error("Payload too large: need 9001 bits, image has 100 (no tile had capacity)".to_string());
        assert_eq!(e.code, ExitCode::CapacityExceeded);
    }

    #[test]
    fn classify_encode_error_capacity_qim() {
        let e = classify_encode_error(
            "Payload too large: need 9001 coefficients (header+codeword x redundancy), have 100".to_string(),
        );
        assert_eq!(e.code, ExitCode::CapacityExceeded);
    }

    #[test]
    fn classify_encode_error_malformed() {
        let e = classify_encode_error("Not a JPEG file".to_string());
        assert_eq!(e.code, ExitCode::MalformedInput);
    }

    #[test]
    fn classify_crypto_error_is_decryption_failure() {
        let e = classify_crypto_error("Invalid Stegstr encrypted payload".to_string());
        assert_eq!(e.code, ExitCode::DecryptionFailure);
    }

    #[test]
    fn is_noninteractive_true_with_yes_flag() {
        assert!(is_noninteractive(&["--yes".to_string()]));
    }

    #[test]
    fn strip_global_flags_removes_json_and_yes() {
        let args = vec!["cover.png".to_string(), "--json".to_string(), "-o".to_string(), "out.png".to_string(), "--yes".to_string()];
        let stripped = strip_global_flags(&args);
        assert_eq!(stripped, vec!["cover.png".to_string(), "-o".to_string(), "out.png".to_string()]);
    }
}
