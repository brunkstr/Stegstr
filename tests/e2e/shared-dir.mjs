import fs from "fs";
import path from "path";
import os from "os";

export const EXCHANGE_DIR = path.join(os.tmpdir(), "stegstr-test-exchange");

export function ensureExchangeDir() {
  if (!fs.existsSync(EXCHANGE_DIR)) {
    fs.mkdirSync(EXCHANGE_DIR, { recursive: true });
  }
  return EXCHANGE_DIR;
}

export function exchangeImagePath(name = "exchange.png") {
  ensureExchangeDir();
  return path.join(EXCHANGE_DIR, name);
}

export function clearExchangeDir() {
  if (fs.existsSync(EXCHANGE_DIR)) {
    fs.readdirSync(EXCHANGE_DIR).forEach((f) => {
      fs.unlinkSync(path.join(EXCHANGE_DIR, f));
    });
  }
}
