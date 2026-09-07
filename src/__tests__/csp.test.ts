import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The content security policy is declared twice on purpose: in tauri.conf.json
 * for the desktop webview and as a <meta> tag in index.html for the web build
 * (and for the browser smoke test, which would surface any violation as a
 * console error). This test keeps the two copies identical.
 */
describe("content security policy", () => {
  const conf = JSON.parse(readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"));
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
  const meta = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];

  it("is set for the desktop app", () => {
    expect(typeof conf.app.security.csp).toBe("string");
    expect(conf.app.security.csp.length).toBeGreaterThan(50);
  });
  it("matches the web build's meta tag", () => {
    expect(meta).toBe(conf.app.security.csp);
  });
  it("blocks the dangerous sources", () => {
    const csp: string = conf.app.security.csp;
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/frame-src 'none'/);
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(csp).toMatch(/script-src 'self';/);
  });
});
