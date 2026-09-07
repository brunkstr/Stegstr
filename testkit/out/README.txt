Stegstr real-device test kit
============================

Each .jpg here carries a hidden message. manifest.json says what.

To check whether the payload survives a real platform:

  1. Send these images to yourself through WhatsApp, Telegram or Instagram
     (normal photo send, NOT 'send as file' - the point is to be recompressed).
  2. Save what arrives into a folder, e.g. returned/
  3. Run:  node testkit/verify.mjs returned/

The verifier matches each file back to its expected text and prints a
pass/fail table. It matches on payload content, so renamed files are fine.

Note: 'locator' is the high-robustness mode and is the one to judge on.
'standard' carries more data and gives up some margin for it.