#!/bin/bash
# Launch Stegstr with test profile 2 (separate localStorage)
# Build first: npm run build:mac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_PATH="${SCRIPT_DIR}/../src-tauri/target/release/bundle/macos/Stegstr.app/Contents/MacOS/stegstr"
if [[ ! -x "$APP_PATH" ]]; then
  echo "App not built. Run: npm run build:mac"
  exit 1
fi
export STEGSTR_TEST_PROFILE=2
exec "$APP_PATH"
