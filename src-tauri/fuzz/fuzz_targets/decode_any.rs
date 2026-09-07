//! Fuzz decode_any() -- lib.rs's entry point that tries the QIM/JPEG decoder
//! then falls back to the DWT/PNG decoder against arbitrary bytes. This is
//! the exact code path exercised whenever a user opens ANY image file,
//! regardless of extension (decode_any doesn't trust the extension), so any
//! panic or OOM here is a real bug against untrusted input.
#![no_main]

use libfuzzer_sys::fuzz_target;
use std::io::Write;

fuzz_target!(|data: &[u8]| {
    // decode_any() takes a Path (stego_qim's libjpeg FFI needs a real fopen()
    // handle, not an in-memory reader), so write each fuzz case to a temp
    // file. Use the fuzzer-provided data as part of the filename's uniqueness
    // isn't needed -- libFuzzer runs single-threaded per worker, and
    // process::id() plus a thread-local counter avoids collisions across
    // worker processes.
    thread_local! {
        static COUNTER: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    }
    let n = COUNTER.with(|c| {
        let v = c.get();
        c.set(v + 1);
        v
    });
    let path = std::env::temp_dir().join(format!(
        "stegstr_fuzz_decode_any_{}_{}.bin",
        std::process::id(),
        n
    ));
    if std::fs::File::create(&path)
        .and_then(|mut f| f.write_all(data))
        .is_err()
    {
        return;
    }

    let _ = stegstr_lib::decode_any(&path);
    let _ = std::fs::remove_file(&path);
});
