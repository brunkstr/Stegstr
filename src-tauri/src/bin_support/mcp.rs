//! `stegstr-cli mcp`: an MCP server over stdio exposing embed, decode,
//! detect, and calibrate as tools for MCP-speaking agent clients. Uses the
//! official `rmcp` SDK (modelcontextprotocol/rust-sdk) rather than a
//! hand-rolled JSON-RPC loop -- see README.md's "MCP server" section for
//! why. Each tool returns the exact same JSON shape as the matching CLI
//! command's `--json` output (see schema/cli/*.schema.json), so a client
//! that already understands the CLI's output understands these tools too.
//! Tool-level failures (bad payload, capacity exceeded, etc.) are reported
//! via MCP's `isError` on the tool result, not a protocol-level error --
//! the JSON-RPC layer only fails for things like a malformed request.

use rmcp::handler::server::tool::{Parameters, ToolRouter};
use rmcp::model::{CallToolResult, Content, Implementation, ProtocolVersion, ServerCapabilities, ServerInfo};
use rmcp::transport::stdio;
use rmcp::{tool, tool_handler, tool_router, ServerHandler, ServiceExt};
use serde::Deserialize;
use std::future::Future;
use std::path::Path;

use super::{classify_crypto_error, classify_decode_error, classify_encode_error, decode_any_verbose, payload_to_text, CliError};

fn ok_result(value: serde_json::Value) -> CallToolResult {
    CallToolResult::success(vec![Content::text(value.to_string())])
}

fn err_result(err: CliError) -> CallToolResult {
    let value = serde_json::json!({ "ok": false, "error": { "kind": err.code.kind_str(), "message": err.message } });
    CallToolResult::error(vec![Content::text(value.to_string())])
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct EmbedRequest {
    #[schemars(description = "Path to the cover image to embed into. .png for the default encoder, .jpg for --robust.")]
    pub cover_path: String,
    #[schemars(description = "Path to write the output image to. Must be .png for the default encoder, .jpg when robust is true.")]
    pub output_path: String,
    #[schemars(description = "Payload as UTF-8 text (e.g. a message, or bundle JSON from the post tool/command).")]
    pub payload: String,
    #[schemars(description = "Encrypt the payload with Stegstr's app-layer key before embedding, so any Stegstr client can detect it. Default false.")]
    #[serde(default)]
    pub encrypt: bool,
    #[schemars(description = "Use the JPEG/QIM encoder, which survives WhatsApp/Instagram/Telegram recompression. Without this, the PNG/DWT encoder is used, which does NOT survive re-upload to those platforms. Default false.")]
    #[serde(default)]
    pub robust: bool,
    #[schemars(description = "Robustness tier when robust is true: 'standard' (WhatsApp/Instagram/Telegram) or 'max' (also survives Twitter/X-style downscaling). Default 'max'.")]
    pub robustness: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DecodeRequest {
    #[schemars(description = "Path to a PNG or JPEG image that may contain a Stegstr payload. Both encoders are tried automatically.")]
    pub image_path: String,
    #[schemars(description = "Decrypt the payload with Stegstr's app-layer key after extracting it. Default false.")]
    #[serde(default)]
    pub decrypt: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DetectRequest {
    #[schemars(description = "Path to a PNG or JPEG image containing an encrypted Stegstr bundle. Decodes and decrypts in one step, returning the parsed Nostr bundle.")]
    pub image_path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CalibrateRequest {
    #[schemars(description = "Path to the original file, before it was sent through the platform.")]
    pub sent_path: String,
    #[schemars(description = "Path to the file downloaded back after the platform round trip.")]
    pub received_path: String,
    #[schemars(description = "Profile name to write the inferred channel fingerprint under. Defaults to the received file's name.")]
    pub name: Option<String>,
    #[schemars(description = "Path to the TOML file to write/update the profile in. Defaults to ./channel_profiles.toml.")]
    pub profiles_out: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StegstrMcp {
    tool_router: ToolRouter<StegstrMcp>,
}

#[tool_router]
impl StegstrMcp {
    fn new() -> Self {
        Self { tool_router: Self::tool_router() }
    }

    #[tool(description = "Hide a payload (text, or bundle JSON from the post tool) inside a cover image, producing a shareable stego image. Use robust=true whenever the result will be sent through WhatsApp, Instagram, or Telegram.")]
    async fn embed(&self, Parameters(req): Parameters<EmbedRequest>) -> Result<CallToolResult, rmcp::ErrorData> {
        Ok(match run_embed(req) {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        })
    }

    #[tool(description = "Extract the raw payload from a PNG or JPEG image, auto-detecting which encoder (default or robust) produced it.")]
    async fn decode(&self, Parameters(req): Parameters<DecodeRequest>) -> Result<CallToolResult, rmcp::ErrorData> {
        Ok(match run_decode(req) {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        })
    }

    #[tool(description = "Decode and decrypt an image's Stegstr payload in one step, returning the parsed Nostr bundle (posts, DMs, etc.).")]
    async fn detect(&self, Parameters(req): Parameters<DetectRequest>) -> Result<CallToolResult, rmcp::ErrorData> {
        Ok(match run_detect(req) {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        })
    }

    #[tool(description = "Compare a sent original against the file received back after a real platform round trip, and infer that platform's re-encode pipeline: resize rule, JPEG quality, chroma subsampling, progressive/baseline, whether metadata was stripped. Writes the result to a channel_profiles.toml file.")]
    async fn calibrate(&self, Parameters(req): Parameters<CalibrateRequest>) -> Result<CallToolResult, rmcp::ErrorData> {
        Ok(match run_calibrate(req) {
            Ok(v) => ok_result(v),
            Err(e) => err_result(e),
        })
    }
}

#[tool_handler]
impl ServerHandler for StegstrMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::V_2024_11_05,
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation::from_build_env(),
            instructions: Some(
                "Stegstr: hide Nostr-style payloads in images and extract them back. \
                 Use robust=true on embed for anything headed through WhatsApp, Instagram, \
                 or Telegram -- the default encoder does not survive their recompression. \
                 Use calibrate after a real platform round trip to learn that platform's \
                 actual re-encode parameters."
                    .to_string(),
            ),
        }
    }
}

fn run_embed(req: EmbedRequest) -> Result<serde_json::Value, CliError> {
    let robustness = match req.robustness.as_deref() {
        Some("standard") => stegstr_lib::stego_qim::Robustness::Standard,
        Some("max") | None => stegstr_lib::stego_qim::Robustness::Max,
        Some(other) => return Err(CliError::generic(format!("unknown robustness value: {other} (expected standard|max)"))),
    };
    let mut payload_bytes = req.payload.into_bytes();
    if req.encrypt {
        let plaintext = String::from_utf8(payload_bytes)
            .map_err(|e| CliError::malformed(format!("encrypt requires UTF-8 payload text: {e}")))?;
        payload_bytes = stegstr_lib::stego_crypto::encrypt_app(&plaintext).map_err(classify_crypto_error)?;
    }
    let (out_bytes, encoder) = if req.robust {
        (
            stegstr_lib::stego_qim::encode(Path::new(&req.cover_path), &payload_bytes, robustness).map_err(classify_encode_error)?,
            "qim",
        )
    } else {
        (
            stegstr_lib::stego::encode(Path::new(&req.cover_path), &payload_bytes).map_err(classify_encode_error)?,
            "dwt",
        )
    };
    let out_len = out_bytes.len();
    std::fs::write(&req.output_path, out_bytes).map_err(|e| CliError::generic(e.to_string()))?;
    Ok(serde_json::json!({
        "ok": true, "encoder": encoder, "output_path": req.output_path,
        "output_bytes": out_len, "encrypted": req.encrypt
    }))
}

fn run_decode(req: DecodeRequest) -> Result<serde_json::Value, CliError> {
    let path = Path::new(&req.image_path);
    let (payload, encoder) = decode_any_verbose(path).map_err(classify_decode_error)?;
    if req.decrypt {
        if !stegstr_lib::stego_crypto::is_encrypted_payload(&payload) {
            return Err(CliError {
                code: super::ExitCode::DecryptionFailure,
                message: "Payload is not Stegstr app-encrypted (use decrypt=false for raw)".to_string(),
            });
        }
        let decrypted = stegstr_lib::stego_crypto::decrypt_app(&payload).map_err(classify_crypto_error)?;
        return Ok(serde_json::json!({
            "ok": true, "encoder": encoder, "decrypted": true,
            "payload": decrypted, "payload_encoding": "utf8"
        }));
    }
    let (text, encoding) = payload_to_text(&payload);
    Ok(serde_json::json!({
        "ok": true, "encoder": encoder, "decrypted": false,
        "payload": text, "payload_encoding": encoding
    }))
}

fn run_detect(req: DetectRequest) -> Result<serde_json::Value, CliError> {
    let path = Path::new(&req.image_path);
    let (payload, encoder) = decode_any_verbose(path).map_err(classify_decode_error)?;
    let bundle_text = if stegstr_lib::stego_crypto::is_encrypted_payload(&payload) {
        stegstr_lib::stego_crypto::decrypt_app(&payload).map_err(classify_crypto_error)?
    } else {
        String::from_utf8(payload).map_err(|e| CliError::malformed(e.to_string()))?
    };
    let bundle: serde_json::Value =
        serde_json::from_str(&bundle_text).map_err(|e| CliError::malformed(format!("bundle is not valid JSON: {e}")))?;
    Ok(serde_json::json!({ "ok": true, "encoder": encoder, "bundle": bundle }))
}

fn run_calibrate(req: CalibrateRequest) -> Result<serde_json::Value, CliError> {
    let mut args: Vec<String> = vec!["--sent".to_string(), req.sent_path, "--received".to_string(), req.received_path];
    if let Some(name) = req.name {
        args.push("--name".to_string());
        args.push(name);
    }
    if let Some(profiles_out) = req.profiles_out {
        args.push("--profiles-out".to_string());
        args.push(profiles_out);
    }
    super::calibrate::compute(&args)
}

pub fn run() -> Result<(), String> {
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let service = StegstrMcp::new().serve(stdio()).await.map_err(|e| e.to_string())?;
        service.waiting().await.map_err(|e| e.to_string())?;
        Ok(())
    })
}
