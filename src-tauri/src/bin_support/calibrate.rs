//! `stegstr-cli calibrate`: channel fingerprinting. Compares a sent
//! original against the file received back after a real platform round
//! trip, and infers that platform's re-encode pipeline -- resize rule,
//! JPEG quality, chroma subsampling, progressive/baseline, whether
//! metadata was stripped -- writing the result to channel_profiles.toml.
//!
//! New feature, not a refactor of anything that existed before this: see
//! STEGSTR_BRIEF.md section 5.2 for the original spec this implements.
//! Every inferred field is reported alongside how confident the inference
//! is (exact vs. best-fit, or "not_applicable" when the input doesn't
//! support the measurement) rather than asserted as fact -- this is a
//! single-sample forensic tool, not a certified platform database.

use super::{CliError, ExitCode};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct ProfilesFile {
    #[serde(default)]
    profiles: BTreeMap<String, ChannelProfile>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ChannelProfile {
    sent_path: String,
    received_path: String,
    sent_width: u32,
    sent_height: u32,
    received_width: u32,
    received_height: u32,
    resize_rule: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    jpeg_quality: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    jpeg_quality_exact: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    jpeg_quality_match_error: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chroma_subsampling: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progressive: Option<bool>,
    metadata_stripped: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata_exif_stripped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata_icc_stripped: Option<bool>,
    inferred_at_unix: u64,
}

/// Classify how sent's dimensions became received's, from a single sample.
/// Deliberately conservative: only names a rule when the evidence actually
/// supports it, falls back to an explicitly-labeled "non_uniform_or_unknown"
/// otherwise rather than guessing. See STEGSTR_BRIEF.md 5.1's warning
/// against hardcoding guessed platform parameters as fact.
fn infer_resize_rule(sent_w: u32, sent_h: u32, recv_w: u32, recv_h: u32) -> String {
    if sent_w == recv_w && sent_h == recv_h {
        return "none (dimensions unchanged)".to_string();
    }
    let wr = recv_w as f64 / sent_w as f64;
    let hr = recv_h as f64 / sent_h as f64;
    let ratio_diff = (wr - hr).abs() / wr.max(hr);
    let shrunk = recv_w <= sent_w && recv_h <= sent_h;
    if ratio_diff < 0.02 && shrunk {
        let sent_max = sent_w.max(sent_h);
        let recv_max = recv_w.max(recv_h);
        return format!("uniform_downscale (max side {sent_max} -> {recv_max}, aspect ratio preserved)");
    }
    if sent_w == recv_w && sent_h != recv_h {
        return format!("fixed_width (width unchanged at {sent_w}, height {sent_h} -> {recv_h})");
    }
    if sent_h == recv_h && sent_w != recv_w {
        return format!("fixed_height (height unchanged at {sent_h}, width {sent_w} -> {recv_w})");
    }
    format!(
        "non_uniform_or_unknown ({sent_w}x{sent_h} -> {recv_w}x{recv_h}, not a uniform-aspect-ratio downscale or a fixed-dimension resize)"
    )
}

struct Args<'a> {
    sent: &'a str,
    received: &'a str,
    name: Option<&'a str>,
    profiles_out: &'a str,
}

fn parse_args(args: &[String]) -> Result<Args<'_>, CliError> {
    let mut sent = None;
    let mut received = None;
    let mut name = None;
    let mut profiles_out = "channel_profiles.toml";
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--sent" => {
                i += 1;
                sent = Some(args.get(i).ok_or_else(|| CliError::generic("missing value for --sent"))?.as_str());
            }
            "--received" => {
                i += 1;
                received = Some(args.get(i).ok_or_else(|| CliError::generic("missing value for --received"))?.as_str());
            }
            "--name" => {
                i += 1;
                name = Some(args.get(i).ok_or_else(|| CliError::generic("missing value for --name"))?.as_str());
            }
            "--profiles-out" => {
                i += 1;
                profiles_out = args.get(i).ok_or_else(|| CliError::generic("missing value for --profiles-out"))?.as_str();
            }
            other => return Err(CliError::generic(format!("unknown calibrate argument: {other}"))),
        }
        i += 1;
    }
    Ok(Args {
        sent: sent.ok_or_else(|| CliError::generic("calibrate requires --sent <original>"))?,
        received: received.ok_or_else(|| CliError::generic("calibrate requires --received <roundtripped>"))?,
        name,
        profiles_out,
    })
}

/// Runs calibrate and returns the same JSON object `--json` mode prints,
/// regardless of whether `--json` was actually passed in `args`. Shared by
/// the CLI's `run` (below) and the MCP `calibrate` tool (mcp.rs), so both
/// interfaces run the exact same computation instead of one shelling out to
/// the other or duplicating the logic.
pub fn compute(args: &[String]) -> Result<serde_json::Value, CliError> {
    let parsed = parse_args(args)?;

    let sent_bytes = std::fs::read(parsed.sent).map_err(|e| CliError::malformed(format!("can't read --sent: {e}")))?;
    let received_bytes =
        std::fs::read(parsed.received).map_err(|e| CliError::malformed(format!("can't read --received: {e}")))?;

    let (sent_w, sent_h) = image::ImageReader::new(std::io::Cursor::new(&sent_bytes))
        .with_guessed_format()
        .map_err(|e| CliError::malformed(format!("--sent: {e}")))?
        .into_dimensions()
        .map_err(|e| CliError::malformed(format!("--sent: unrecognized image format: {e}")))?;
    let (recv_w, recv_h) = image::ImageReader::new(std::io::Cursor::new(&received_bytes))
        .with_guessed_format()
        .map_err(|e| CliError::malformed(format!("--received: {e}")))?
        .into_dimensions()
        .map_err(|e| CliError::malformed(format!("--received: unrecognized image format: {e}")))?;

    let sent_jpeg = stegstr_lib::jpeg_probe::probe(&sent_bytes).ok();
    let received_jpeg = stegstr_lib::jpeg_probe::probe(&received_bytes).ok();

    let resize_rule = infer_resize_rule(sent_w, sent_h, recv_w, recv_h);

    let (jpeg_quality, jpeg_quality_exact, jpeg_quality_match_error) = match &received_jpeg {
        Some(p) => match p.estimate_jpeg_quality() {
            Some((q, err)) => (Some(q), Some(err == 0.0), Some(err)),
            None => (None, None, None),
        },
        None => (None, None, None),
    };
    let chroma_subsampling = received_jpeg.as_ref().map(|p| p.chroma_subsampling().to_string());
    let progressive = received_jpeg.as_ref().map(|p| p.progressive);

    let (metadata_stripped, exif_stripped, icc_stripped) = match (&sent_jpeg, &received_jpeg) {
        (Some(s), Some(r)) => {
            let exif = s.has_exif && !r.has_exif;
            let icc = s.has_icc && !r.has_icc;
            ("measured".to_string(), Some(exif), Some(icc))
        }
        _ => ("not_applicable (both --sent and --received must be JPEG to compare metadata)".to_string(), None, None),
    };

    let inferred_at_unix = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);

    let profile_name = parsed
        .name
        .map(str::to_string)
        .unwrap_or_else(|| Path::new(parsed.received).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "profile".to_string()));

    let profile = ChannelProfile {
        sent_path: parsed.sent.to_string(),
        received_path: parsed.received.to_string(),
        sent_width: sent_w,
        sent_height: sent_h,
        received_width: recv_w,
        received_height: recv_h,
        resize_rule: resize_rule.clone(),
        jpeg_quality,
        jpeg_quality_exact,
        jpeg_quality_match_error,
        chroma_subsampling: chroma_subsampling.clone(),
        progressive,
        metadata_stripped: metadata_stripped.clone(),
        metadata_exif_stripped: exif_stripped,
        metadata_icc_stripped: icc_stripped,
        inferred_at_unix,
    };

    let mut profiles_file: ProfilesFile = if Path::new(parsed.profiles_out).exists() {
        let text = std::fs::read_to_string(parsed.profiles_out)
            .map_err(|e| CliError { code: ExitCode::GenericError, message: format!("can't read {}: {e}", parsed.profiles_out) })?;
        toml::from_str(&text)
            .map_err(|e| CliError { code: ExitCode::GenericError, message: format!("{} is not valid TOML: {e}", parsed.profiles_out) })?
    } else {
        ProfilesFile::default()
    };
    profiles_file.profiles.insert(profile_name.clone(), profile.clone());
    let toml_text = toml::to_string_pretty(&profiles_file)
        .map_err(|e| CliError { code: ExitCode::GenericError, message: e.to_string() })?;
    std::fs::write(parsed.profiles_out, toml_text)
        .map_err(|e| CliError { code: ExitCode::GenericError, message: format!("can't write {}: {e}", parsed.profiles_out) })?;

    Ok(serde_json::json!({
        "ok": true,
        "profile_name": profile_name,
        "profiles_out": parsed.profiles_out,
        "sent": { "path": parsed.sent, "width": sent_w, "height": sent_h },
        "received": { "path": parsed.received, "width": recv_w, "height": recv_h },
        "resize_rule": resize_rule,
        "jpeg_quality": jpeg_quality,
        "jpeg_quality_exact": jpeg_quality_exact,
        "jpeg_quality_match_error": jpeg_quality_match_error,
        "chroma_subsampling": chroma_subsampling,
        "progressive": progressive,
        "metadata_stripped": metadata_stripped,
        "metadata_exif_stripped": exif_stripped,
        "metadata_icc_stripped": icc_stripped,
    }))
}

pub fn run(args: &[String], json: bool) -> Result<(), CliError> {
    let obj = compute(args)?;
    if json {
        println!("{}", obj);
    } else {
        eprintln!("Profile '{}' written to {}", obj["profile_name"].as_str().unwrap_or(""), obj["profiles_out"].as_str().unwrap_or(""));
        eprintln!("  resize rule: {}", obj["resize_rule"].as_str().unwrap_or(""));
        if let Some(q) = obj["jpeg_quality"].as_u64() {
            let exactness = if obj["jpeg_quality_exact"].as_bool() == Some(true) { "exact" } else { "best-fit estimate" };
            eprintln!("  JPEG quality: {q} ({exactness})");
        }
        if let Some(cs) = obj["chroma_subsampling"].as_str() {
            eprintln!("  chroma subsampling: {cs}");
        }
        if let Some(p) = obj["progressive"].as_bool() {
            eprintln!("  progressive: {p}");
        }
        eprintln!("  metadata: {}", obj["metadata_stripped"].as_str().unwrap_or(""));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_rule_unchanged() {
        assert_eq!(infer_resize_rule(1000, 800, 1000, 800), "none (dimensions unchanged)");
    }

    #[test]
    fn resize_rule_uniform_downscale() {
        let rule = infer_resize_rule(2000, 1000, 1600, 800);
        assert!(rule.starts_with("uniform_downscale"), "got: {rule}");
    }

    #[test]
    fn resize_rule_fixed_width() {
        let rule = infer_resize_rule(1000, 2000, 1000, 1500);
        assert!(rule.starts_with("fixed_width"), "got: {rule}");
    }

    #[test]
    fn resize_rule_non_uniform_flagged_honestly() {
        let rule = infer_resize_rule(1000, 1000, 900, 400);
        assert!(rule.starts_with("non_uniform_or_unknown"), "got: {rule}");
    }
}
