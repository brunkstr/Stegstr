/**
 * Shared directory for steganographic image exchange between two instances.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const EXCHANGE_DIR = path.join(os.tmpdir(), "stegstr-test-exchange");

export function ensureExchangeDir(): string {
  if (!fs.existsSync(EXCHANGE_DIR)) {
    fs.mkdirSync(EXCHANGE_DIR, { recursive: true });
  }
  return EXCHANGE_DIR;
}

export function exchangeImagePath(name = "exchange.png"): string {
  ensureExchangeDir();
  return path.join(EXCHANGE_DIR, name);
}

export function clearExchangeDir(): void {
  if (fs.existsSync(EXCHANGE_DIR)) {
    fs.readdirSync(EXCHANGE_DIR).forEach((f) => {
      fs.unlinkSync(path.join(EXCHANGE_DIR, f));
    });
  }
}
