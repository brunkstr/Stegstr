#!/bin/bash
# Launch two Stegstr instances with different profiles
# Build first: npm run build:mac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/launch-profile-1.sh" &
"$SCRIPT_DIR/launch-profile-2.sh" &
