pub mod stego;
pub mod stego_crypto;

use base64::Engine;
use serde::{Deserialize, Serialize};

/// Normalize path: strip file:// prefix if present (e.g. from some dialogs)
fn normalize_path(s: &str) -> &str {
    s.trim_start_matches("file://")
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
        .invoke_handler(tauri::generate_handler![decode_stego_image, encode_stego_image, get_desktop_path, get_test_profile, get_exchange_path, reveal_in_finder, stegstr_log])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
