//! Validates `stegstr-cli`'s `--json` output against the committed schemas
//! under `schema/cli/` -- this is the "validated in tests" half of the
//! AI Agent Operability work (the schemas themselves are the "committed
//! under schema/" half). Runs the real compiled binary end-to-end against
//! real fixtures for both success and error paths of every command, so a
//! schema and the binary's actual output can never silently drift apart.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is src-tauri/; schema/ lives at the repo root.
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn schema_path(name: &str) -> PathBuf {
    repo_root().join("schema").join("cli").join(name)
}

fn load_schema(name: &str) -> serde_json::Value {
    let text = std::fs::read_to_string(schema_path(name)).unwrap_or_else(|e| panic!("reading {name}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parsing {name}: {e}"))
}

/// Builds a validator for `schema_name`, with `error.schema.json` (the only
/// cross-file $ref every other schema uses) pre-registered under its $id so
/// validation never needs network access.
fn validator_for(schema_name: &str) -> jsonschema::Validator {
    let error_schema = load_schema("error.schema.json");
    let error_id = error_schema["$id"].as_str().expect("error.schema.json must declare $id").to_string();
    let error_resource = jsonschema::Resource::from_contents(error_schema).expect("error.schema.json has an unrecognized $schema draft");
    let schema = load_schema(schema_name);
    jsonschema::options()
        .with_resource(error_id, error_resource)
        .build(&schema)
        .unwrap_or_else(|e| panic!("compiling {schema_name}: {e}"))
}

fn assert_valid(schema_name: &str, instance: &serde_json::Value) {
    let validator = validator_for(schema_name);
    let errors: Vec<String> = validator.iter_errors(instance).map(|e| e.to_string()).collect();
    assert!(errors.is_empty(), "{schema_name} rejected {instance}: {errors:?}");
}

fn cli() -> Command {
    Command::new(env!("CARGO_BIN_EXE_stegstr-cli"))
}

fn run(args: &[&str]) -> Output {
    cli().args(args).output().expect("failed to run stegstr-cli")
}

fn stdout_json(output: &Output) -> serde_json::Value {
    let text = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("stdout wasn't valid JSON ({e}): {text}"))
}

struct Fixtures {
    dir: PathBuf,
    cover_png: PathBuf,
    cover_jpg: PathBuf,
}

/// `cargo test` runs each `#[test]` fn as a separate thread within the same
/// process, so `std::process::id()` alone is identical for every test in
/// this file -- two tests calling this without a per-call discriminator
/// raced on the same directory (one test's cleanup deleting files the
/// other was still using mid-flight). This counter makes each call unique.
static FIXTURE_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn make_fixtures() -> Fixtures {
    let n = FIXTURE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("stegstr_cli_json_schema_test_{}_{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    let cover_png = dir.join("cover.png");
    let img = image::RgbImage::from_fn(300, 300, |x, y| {
        image::Rgb([((x * 3) % 256) as u8, ((y * 5) % 256) as u8, ((x + y) % 256) as u8])
    });
    img.save(&cover_png).unwrap();

    let cover_jpg = dir.join("cover.jpg");
    let mut f = std::fs::File::create(&cover_jpg).unwrap();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, 90);
    enc.encode(&img, img.width(), img.height(), image::ExtendedColorType::Rgb8).unwrap();
    drop(f);

    Fixtures { dir, cover_png, cover_jpg }
}

#[test]
fn embed_decode_detect_post_calibrate_json_matches_schema() {
    let fx = make_fixtures();

    // --- embed (dwt), success ---
    let out_png = fx.dir.join("out_dwt.png");
    let embed_out = run(&["embed", fx.cover_png.to_str().unwrap(), "-o", out_png.to_str().unwrap(), "--payload", "hello schema test", "--json"]);
    assert!(embed_out.status.success(), "{:?}", embed_out);
    let v = stdout_json(&embed_out);
    assert_valid("embed.schema.json", &v);
    assert_eq!(v["encoder"], "dwt");

    // --- decode (dwt), success ---
    // Plain text (not JSON-shaped) is reported base64-encoded, same as the
    // CLI's non-json mode -- only JSON-shaped payloads round-trip as plain
    // utf8 text. See payload_to_text in main.rs.
    let decode_out = run(&["decode", out_png.to_str().unwrap(), "--json"]);
    assert!(decode_out.status.success());
    let v = stdout_json(&decode_out);
    assert_valid("decode.schema.json", &v);
    assert_eq!(v["payload_encoding"], "base64");
    let b64 = v["payload"].as_str().unwrap().strip_prefix("base64:").unwrap();
    let decoded = String::from_utf8(base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64).unwrap()).unwrap();
    assert_eq!(decoded, "hello schema test");

    // --- embed (qim/--robust), success ---
    let out_jpg = fx.dir.join("out_qim.jpg");
    let embed_out = run(&["embed", fx.cover_jpg.to_str().unwrap(), "-o", out_jpg.to_str().unwrap(), "--robust", "--payload", "{\"version\":1,\"events\":[]}", "--encrypt", "--json"]);
    assert!(embed_out.status.success(), "{:?}", embed_out);
    let v = stdout_json(&embed_out);
    assert_valid("embed.schema.json", &v);
    assert_eq!(v["encoder"], "qim");
    assert_eq!(v["encrypted"], true);

    // --- detect (qim, encrypted), success ---
    let detect_out = run(&["detect", out_jpg.to_str().unwrap(), "--json"]);
    assert!(detect_out.status.success(), "{:?}", detect_out);
    let v = stdout_json(&detect_out);
    assert_valid("detect.schema.json", &v);
    assert_eq!(v["bundle"]["version"], 1);

    // --- post, success ---
    let post_out = run(&["post", "hello from schema test", "--json"]);
    assert!(post_out.status.success());
    let v = stdout_json(&post_out);
    assert_valid("post.schema.json", &v);
    assert_eq!(v["output_path"], serde_json::Value::Null);

    // --- calibrate, success (comparing the two covers as a stand-in sent/received pair) ---
    let profiles_out = fx.dir.join("channel_profiles.toml");
    let calibrate_out = run(&[
        "calibrate",
        "--sent", fx.cover_jpg.to_str().unwrap(),
        "--received", out_jpg.to_str().unwrap(),
        "--profiles-out", profiles_out.to_str().unwrap(),
        "--json",
    ]);
    assert!(calibrate_out.status.success(), "{:?}", calibrate_out);
    let v = stdout_json(&calibrate_out);
    assert_valid("calibrate.schema.json", &v);
    assert!(profiles_out.exists());

    let _ = std::fs::remove_dir_all(&fx.dir);
}

#[test]
fn error_paths_match_schema_and_documented_exit_codes() {
    let fx = make_fixtures();

    // capacity_exceeded (exit 2): a payload far larger than a tiny cover can hold.
    let tiny = fx.dir.join("tiny.jpg");
    {
        let img = image::RgbImage::from_pixel(32, 32, image::Rgb([100, 100, 100]));
        let mut f = std::fs::File::create(&tiny).unwrap();
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, 90);
        enc.encode(&img, img.width(), img.height(), image::ExtendedColorType::Rgb8).unwrap();
    }
    // Written to a file and loaded via --payload @file rather than passed
    // inline: Windows caps a single command-line argument at well under
    // 50,000 bytes (see BUGS.md's "no @file form for --payload-base64"
    // entry), so passing this much text inline would fail for an unrelated
    // reason before ever reaching the capacity check this test is for.
    let huge_payload_path = fx.dir.join("huge_payload.txt");
    std::fs::write(&huge_payload_path, "x".repeat(50_000)).unwrap();
    let payload_arg = format!("@{}", huge_payload_path.to_str().unwrap());
    let out = run(&["embed", tiny.to_str().unwrap(), "-o", fx.dir.join("tiny_out.jpg").to_str().unwrap(), "--robust", "--payload", &payload_arg, "--json"]);
    assert_eq!(out.status.code(), Some(2), "{:?}", out);
    let v = stdout_json(&out);
    assert_valid("embed.schema.json", &v);
    assert_eq!(v["error"]["kind"], "capacity_exceeded");

    // no_payload_found (exit 3): a cover with nothing embedded in it.
    let out = run(&["decode", fx.cover_png.to_str().unwrap(), "--json"]);
    assert_eq!(out.status.code(), Some(3), "{:?}", out);
    let v = stdout_json(&out);
    assert_valid("decode.schema.json", &v);
    assert_eq!(v["error"]["kind"], "no_payload_found");

    // malformed_input (exit 5): not an image at all.
    let garbage = fx.dir.join("garbage.png");
    std::fs::write(&garbage, b"not a png").unwrap();
    let out = run(&["decode", garbage.to_str().unwrap(), "--json"]);
    assert_eq!(out.status.code(), Some(5), "{:?}", out);
    let v = stdout_json(&out);
    assert_valid("decode.schema.json", &v);
    assert_eq!(v["error"]["kind"], "malformed_input");

    // decryption_failure (exit 4): a real payload, but not app-encrypted.
    let out_png = fx.dir.join("plain.png");
    let embed = run(&["embed", fx.cover_png.to_str().unwrap(), "-o", out_png.to_str().unwrap(), "--payload", "not encrypted", "--json"]);
    assert!(embed.status.success());
    let out = run(&["decode", out_png.to_str().unwrap(), "--decrypt", "--json"]);
    assert_eq!(out.status.code(), Some(4), "{:?}", out);
    let v = stdout_json(&out);
    assert_valid("decode.schema.json", &v);
    assert_eq!(v["error"]["kind"], "decryption_failure");

    // generic_error (exit 1): missing required argument.
    let out = run(&["embed", "--json"]);
    assert_eq!(out.status.code(), Some(1), "{:?}", out);

    let _ = std::fs::remove_dir_all(&fx.dir);
}
