// Stegstr app-layer encryption: AES-GCM with app-derived key.
// Matches stego-crypto.ts: STEGSTR1 + version + iv + ciphertext (tag 128 bits).

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm,
};
use aead::generic_array::GenericArray;
use rand::RngCore;
use sha2::{Digest, Sha256};

const STEGSTR_MAGIC: &[u8] = b"STEGSTR1";
const VERSION: u8 = 1;
const APP_KEY_SALT: &[u8] = b"stegstr-decrypt-v1";
const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;

fn app_key() -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(APP_KEY_SALT);
    hasher.finalize().into()
}

/// Encrypt plaintext so only Stegstr can decrypt. Returns binary: magic + version + iv + ciphertext.
pub fn encrypt_app(plaintext: &str) -> Result<Vec<u8>, String> {
    let key = app_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let mut iv = [0u8; IV_LEN];
    rand::thread_rng().fill_bytes(&mut iv);
    let nonce = GenericArray::from_slice(&iv);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(STEGSTR_MAGIC.len() + 1 + IV_LEN + ciphertext.len());
    out.extend_from_slice(STEGSTR_MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt app-encrypted payload. Returns inner plaintext string.
pub fn decrypt_app(encrypted: &[u8]) -> Result<String, String> {
    if encrypted.len() < STEGSTR_MAGIC.len() + 1 + IV_LEN + TAG_LEN {
        return Err("Payload too short".to_string());
    }
    if encrypted[..STEGSTR_MAGIC.len()] != STEGSTR_MAGIC[..] {
        return Err("Invalid Stegstr encrypted payload".to_string());
    }
    if encrypted[STEGSTR_MAGIC.len()] != VERSION {
        return Err("Unsupported encryption version".to_string());
    }
    let iv_start = STEGSTR_MAGIC.len() + 1;
    let iv = &encrypted[iv_start..iv_start + IV_LEN];
    let ciphertext = &encrypted[iv_start + IV_LEN..];
    let key = app_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce = GenericArray::from_slice(iv);
    let dec = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| e.to_string())?;
    String::from_utf8(dec).map_err(|e| e.to_string())
}

/// True if bytes look like Stegstr encrypted (magic).
pub fn is_encrypted_payload(bytes: &[u8]) -> bool {
    bytes.len() >= STEGSTR_MAGIC.len() && bytes[..STEGSTR_MAGIC.len()] == STEGSTR_MAGIC[..]
}
