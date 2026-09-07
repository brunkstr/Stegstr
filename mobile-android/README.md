# Android

**Not yet buildable.** This directory used to be a broken git submodule
reference (a gitlink pointing at commit `2c7c6211a0e98d7943b97551cfe3ac9434616226`
with no corresponding entry in a `.gitmodules` file -- present in pristine
upstream too, so this predates this fork). It resolved to an empty directory
on every checkout and printed a `fatal: No url found for submodule path
'mobile-android'` warning during `git checkout`/CI on every platform, every
run. Removed the broken gitlink; there was no way to recover whatever content
the referenced commit pointed to without a registered submodule URL.

`src-tauri/src/lib.rs` already has `#[cfg_attr(mobile, tauri::mobile_entry_point)]`
on `run()`, so the Rust side is mobile-capable in principle, but the actual
Android Studio/Gradle project scaffold has never been generated in this
repo -- `tauri android init` has never been run, there's no
`src-tauri/gen/android/`, and this environment (and, per the broken
submodule above, likely no prior session either) has the Android SDK/NDK
available to actually build or test it.

To scaffold and build:

```bash
# Prerequisites: Android SDK + NDK, ANDROID_HOME / NDK_HOME set, JDK 17+
cargo install tauri-cli --version "^2"
cd src-tauri
cargo tauri android init
cargo tauri android build
```

This has not been attempted or verified in this repo. Treat it as a real gap,
not a working-but-untested path.
