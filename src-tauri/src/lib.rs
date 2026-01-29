mod stego;

use serde::{Deserialize, Serialize};

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
    match stego::decode_lsb(std::path::Path::new(&path)) {
        Ok(payload) => {
            let s = String::from_utf8(payload).map_err(|e| e.to_string())?;
            Ok(StegoDecodeResult {
                ok: true,
                payload: Some(s),
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
    match stego::encode_lsb(std::path::Path::new(&cover_path), payload.as_bytes()) {
        Ok(png_bytes) => {
            std::fs::write(&output_path, png_bytes).map_err(|e| e.to_string())?;
            Ok(StegoEncodeResult {
                ok: true,
                path: Some(output_path),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![decode_stego_image, encode_stego_image])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
