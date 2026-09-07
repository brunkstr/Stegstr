pub mod jpeg_probe;
pub mod stego;
pub mod stego_crypto;
pub mod stego_dot;
pub mod stego_qim;

use base64::Engine;
use serde::{Deserialize, Serialize};

/// Normalize path: strip file:// prefix if present (e.g. from some dialogs)
fn normalize_path(s: &str) -> &str {
    s.trim_start_matches("file://")
}

/// Try both encoders: QIM (JPEG, DCT-domain -- survives WhatsApp/Instagram/
/// Telegram recompression) first since it's cheap to rule out on a non-JPEG
/// file, then fall back to DWT (PNG, spatial-domain -- does not survive
/// recompression but is lossless if the image really was never re-encoded).
/// A recipient doesn't know which encoder produced an image they were sent, so
/// decode/detect must handle either transparently.
pub fn decode_any(path: &std::path::Path) -> Result<Vec<u8>, String> {
    if let Ok(Some(payload)) = stego_qim::decode(path) {
        return Ok(payload);
    }
    stego::decode(path)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StegoDecodeResult {
    pub ok: bool,
    pub payload: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StegoEncodeResult {
    pub ok: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
fn decode_stego_image(path: String) -> Result<StegoDecodeResult, String> {
    let p = normalize_path(&path);
    match stego::decode(std::path::Path::new(p)) {
        Ok(payload) => {
            let payload_str = match String::from_utf8(payload.clone()) {
                Ok(s) if s.trim_start().starts_with('{') => s,
                _ => format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(&payload)),
            };
            Ok(StegoDecodeResult {
                ok: true,
                payload: Some(payload_str),
                error: None,
            })
        }
        Err(e) => Ok(StegoDecodeResult {
            ok: false,
            payload: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
fn decode_stego_dot(path: String) -> Result<StegoDecodeResult, String> {
    let p = normalize_path(&path);
    match stego_dot::decode(std::path::Path::new(p)) {
        Ok(payload) => {
            let payload_str = match String::from_utf8(payload.clone()) {
                Ok(s) if s.trim_start().starts_with('{') => s,
                _ => format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(&payload)),
            };
            Ok(StegoDecodeResult {
                ok: true,
                payload: Some(payload_str),
                error: None,
            })
        }
        Err(e) => Ok(StegoDecodeResult {
            ok: false,
            payload: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
fn encode_stego_image(cover_path: String, output_path: String, payload: String) -> Result<StegoEncodeResult, String> {
    let cover = normalize_path(&cover_path);
    let output = normalize_path(&output_path);
    let payload_bytes: Vec<u8> = if payload.starts_with("base64:") {
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim_start_matches("base64:").as_bytes())
            .map_err(|e| e.to_string())?
    } else {
        payload.into_bytes()
    };
    let encode_result = stego::encode(std::path::Path::new(cover), &payload_bytes);
    match encode_result {
        Ok(png_bytes) => {
            std::fs::write(output, png_bytes).map_err(|e| e.to_string())?;
            Ok(StegoEncodeResult {
                ok: true,
                path: Some(output.to_string()),
                error: None,
            })
        }
        Err(e) => Ok(StegoEncodeResult {
            ok: false,
            path: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
fn encode_stego_dot(cover_path: String, output_path: String, payload: String) -> Result<StegoEncodeResult, String> {
    let cover = normalize_path(&cover_path);
    let output_raw = normalize_path(&output_path);
    let output_path_buf = std::path::Path::new(output_raw).with_extension("png");
    let output = output_path_buf.to_string_lossy().to_string();
    let payload_bytes: Vec<u8> = if payload.starts_with("base64:") {
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim_start_matches("base64:").as_bytes())
            .map_err(|e| e.to_string())?
    } else {
        payload.into_bytes()
    };
    let encode_result = stego_dot::encode(std::path::Path::new(cover), &payload_bytes);
    match encode_result {
        Ok(png_bytes) => {
            std::fs::write(output.clone(), png_bytes).map_err(|e| e.to_string())?;
            let sig = std::fs::read(&output).map_err(|e| e.to_string())?;
            if sig.len() < 8 || sig[..8] != [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
                return Ok(StegoEncodeResult {
                    ok: false,
                    path: None,
                    error: Some("Dot encoder output is not PNG".to_string()),
                });
            }
            Ok(StegoEncodeResult {
                ok: true,
                path: Some(output.to_string()),
                error: None,
            })
        }
        Err(e) => Ok(StegoEncodeResult {
            ok: false,
            path: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
fn check_png_signature(path: String) -> Result<bool, String> {
    let p = normalize_path(&path);
    let sig = std::fs::read(p).map_err(|e| e.to_string())?;
    Ok(sig.len() >= 8 && sig[..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

#[tauri::command]
fn get_dot_capacity(path: String) -> Result<usize, String> {
    let p = normalize_path(&path);
    stego_dot::max_payload_bytes(std::path::Path::new(p))
}

#[tauri::command]
fn get_qim_capacity(path: String) -> Result<usize, String> {
    let p = normalize_path(&path);
    stego_qim::capacity_bytes(std::path::Path::new(p), &stego_qim::Robustness::default())
}

#[tauri::command]
fn stegstr_log(
    level: String,
    action: String,
    message: String,
    details: Option<String>,
    error: Option<String>,
    stack: Option<String>,
) -> Result<(), String> {
    use std::io::Write;
    let log_dir = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .ok_or("no log dir")?
        .join("Stegstr");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("stegstr.log");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let line = serde_json::json!({
        "ts": ts,
        "level": level,
        "action": action,
        "message": message,
        "details": details,
        "error": error,
        "stack": stack,
    });
    writeln!(file, "{}", line).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_exchange_path() -> Result<String, String> {
    let dir = std::env::temp_dir().join("stegstr-test-exchange");
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.join("exchange.png").to_string_lossy().to_string())
}

#[tauri::command]
fn get_exchange_path_qim() -> Result<String, String> {
    let dir = std::env::temp_dir().join("stegstr-test-exchange");
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.join("exchange.jpg").to_string_lossy().to_string())
}

#[tauri::command]
fn get_test_profile() -> Option<String> {
    std::env::var("STEGSTR_TEST_PROFILE").ok().filter(|s| !s.is_empty())
}

#[tauri::command]
fn get_desktop_path() -> Result<String, String> {
    dirs::desktop_dir()
        .and_then(|p| p.into_os_string().into_string().ok())
        .ok_or_else(|| "Could not get Desktop path".to_string())
}

#[tauri::command]
fn encode_stego_qim(cover_path: String, output_path: String, payload: String) -> Result<StegoEncodeResult, String> {
    // Native Rust QIM encoder (stego_qim.rs) -- the JPEG-domain scheme that
    // survives WhatsApp/Instagram/Telegram recompression (validated: see
    // ROBUSTNESS_PORT_NOTES.md) and, unlike the dot-offset scheme, doesn't
    // paint visible pixel artifacts into the image. Previously this command
    // shelled out to a `python3` script, requiring end users to have Python
    // plus specific pip packages installed just to use the app's main Embed
    // feature -- not viable for a one-click-install desktop app.
    let cover = normalize_path(&cover_path);
    let output_raw = normalize_path(&output_path);
    let output_path_buf = std::path::Path::new(output_raw).with_extension("jpg");
    let output = output_path_buf.to_string_lossy().to_string();
    let payload_bytes: Vec<u8> = if payload.starts_with("base64:") {
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim_start_matches("base64:").as_bytes())
            .map_err(|e| e.to_string())?
    } else {
        payload.into_bytes()
    };
    match stego_qim::encode(std::path::Path::new(cover), &payload_bytes, stego_qim::Robustness::default()) {
        Ok(jpeg_bytes) => {
            std::fs::write(&output, jpeg_bytes).map_err(|e| e.to_string())?;
            Ok(StegoEncodeResult {
                ok: true,
                path: Some(output),
                error: None,
            })
        }
        Err(e) => Ok(StegoEncodeResult {
            ok: false,
            path: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
fn decode_stego_qim(path: String) -> Result<StegoDecodeResult, String> {
    let p = normalize_path(&path);
    let payload_bytes = match stego_qim::decode(std::path::Path::new(p)) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => {
            return Ok(StegoDecodeResult {
                ok: false,
                payload: None,
                error: Some("Not a Stegstr QIM image".to_string()),
            });
        }
        Err(e) => {
            return Ok(StegoDecodeResult {
                ok: false,
                payload: None,
                error: Some(e),
            });
        }
    };
    let payload_str = format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(&payload_bytes));
    Ok(StegoDecodeResult {
        ok: true,
        payload: Some(payload_str),
        error: None,
    })
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").args(["-R", &path]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = path;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            decode_stego_image,
            encode_stego_image,
            decode_stego_dot,
            encode_stego_dot,
            get_dot_capacity,
            get_qim_capacity,
            check_png_signature,
            decode_stego_qim,
            encode_stego_qim,
            get_desktop_path,
            get_test_profile,
            get_exchange_path,
            get_exchange_path_qim,
            reveal_in_finder,
            stegstr_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
