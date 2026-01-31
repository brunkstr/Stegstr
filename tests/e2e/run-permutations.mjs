#!/usr/bin/env node
/**
 * Run permutation matrix validation (no WebDriver).
 * Validates that the permutation and action matrices are defined.
 * For full E2E, use semi-manual flow: npm run launch:both
 * Logs all results to tests/e2e/test-run.log for cross-platform reference.
 */

import fs from "fs";
import path from "path";
import os from "os";

const LOG_PATH = path.join(process.cwd(), "tests", "e2e", "test-run.log");

function log(level, message, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    platform: process.platform,
    ...details,
  };
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(LOG_PATH, line);
  if (level === "error") console.error(`[Stegstr E2E] ${message}`, details);
  else if (level === "action") console.log(`[Stegstr E2E] ${message}`);
}

try {
  const { PERMUTATIONS, ACTIONS } = await import("./permutations.mjs");
  const { ensureExchangeDir, clearExchangeDir } = await import("./shared-dir.mjs");
  const { EMBED_FLOWS } = await import("./actions.mjs");

  log("info", "Test run started", { platform: process.platform, node: process.version });
  ensureExchangeDir();

  let passed = 0;
  let failed = 0;
  const errors = [];

  for (const perm of PERMUTATIONS) {
    for (const action of ACTIONS) {
      const embedFlow = EMBED_FLOWS[action];
      if (!Array.isArray(embedFlow)) {
        log("error", `EMBED_FLOWS[${action}] missing`, { perm: perm.id, action });
        errors.push({ perm: perm.id, action, error: "EMBED_FLOWS missing" });
        failed++;
      } else {
        log("action", `Check passed: perm ${perm.id} action ${action}`);
        passed++;
      }
    }
  }

  clearExchangeDir();

  const summary = {
    passed,
    failed,
    total: passed + failed,
    permutations: PERMUTATIONS.length,
    actions: ACTIONS.length,
    errors: errors.length,
  };
  log("info", `Test run completed: ${passed} passed, ${failed} failed`, summary);

  if (errors.length) {
    log("error", "Errors recorded", { errors });
  }

  console.log(`Permutation matrix: ${passed} checks passed, ${failed} failed`);
  console.log(`Total permutations: ${PERMUTATIONS.length}, actions: ${ACTIONS.length}`);
  console.log(`Log written to ${LOG_PATH}`);
  console.log("For full E2E: npm run launch:both, then manually test embed → detect per permutation");

  process.exit(failed > 0 ? 1 : 0);
} catch (e) {
  log("error", "Test run crashed", { error: String(e), stack: e?.stack });
  console.error(e);
  process.exit(1);
}
