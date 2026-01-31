/**
 * WebdriverIO config for Stegstr E2E.
 * Run: npx wdio run tests/e2e/wdio.conf.ts
 * Prerequisites: tauri-driver + platform WebDriver (Linux: WebKitWebDriver, Windows: msedgedriver)
 * macOS: Requires CrabNebula tauri-plugin-automation
 *
 * See tests/e2e/README.md for setup.
 */

import path from "path";

export const config = {
  runner: "local",
  specs: ["./embed-detect.spec.ts"],
  port: 4444,
  path: "/",
  capabilities: [
    {
      maxInstances: 1,
      browserName: "chrome", // tauri-driver uses chromelike protocol
      "tauri:options": {
        applicationPath: path.join(process.cwd(), "src-tauri/target/release/stegstr"),
      },
    },
  ],
  logLevel: "info",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    timeout: 60000,
  },
};
