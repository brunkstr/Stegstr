/**
 * E2E test setup: launch two Stegstr instances with different profiles.
 *
 * Prerequisites:
 * - npm run build:mac (or build for your platform)
 * - On macOS: WebDriver requires CrabNebula tauri-plugin-automation (not in standard Tauri)
 * - On Linux: tauri-driver + WebKitWebDriver
 * - On Windows: tauri-driver + msedgedriver
 *
 * For macOS without automation plugin: use semi-manual flow:
 * 1. Run ./scripts/launch-both-profiles.sh
 * 2. Instance A: create content, Embed → save to /tmp/stegstr-test-exchange/exchange.png
 * 3. Instance B: Detect → select file from that path (or drag-drop)
 * 4. Assert B sees the content
 */

import { spawn } from "child_process";
import * as path from "path";

const SCRIPT_DIR = path.join(process.cwd(), "scripts");
const APP_PATH = path.join(process.cwd(), "src-tauri/target/release/bundle/macos/Stegstr.app/Contents/MacOS/stegstr");

export async function launchInstance(profile: 1 | 2): Promise<ReturnType<typeof spawn> | null> {
  const env = { ...process.env, STEGSTR_TEST_PROFILE: String(profile) };
  const child = spawn(APP_PATH, [], { env, stdio: "inherit" });
  return child;
}

export async function launchBoth(): Promise<{ a: ReturnType<typeof spawn>; b: ReturnType<typeof spawn> }> {
  const a = await launchInstance(1);
  const b = await launchInstance(2);
  return { a: a!, b: b! };
}
