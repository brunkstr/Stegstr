/**
 * Adversarial input pass.
 *
 * Mirrors section 5A of the contest's evaluator instructions: "Try wrong inputs
 * on purpose (huge image, tiny image, empty message, weird characters, cancel
 * mid-operation). Graceful errors or crashes?"
 *
 * The bar is not that every case succeeds. It is that no case crashes and no
 * case silently produces a wrong result: either a correct answer, or a clear
 * error that says what to do instead.
 *
 *   npm run build:cli && node tests/hostile-inputs.mjs
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = "dist-cli/stegstr.mjs";
const dir = mkdtempSync(join(tmpdir(), "hostile-"));
const cover = "testkit/out/landscape-locator.jpg";

function run(args) {
  try {
    const out = execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? -1, out: (e.stdout || "") + (e.stderr || "") };
  }
}

const results = [];
function check(name, r, expect) {
  // expect: "ok" = exit 0, "clean-error" = exit 1 or 2 with a readable message
  let verdict;
  if (expect === "ok") verdict = r.code === 0 ? "PASS" : "FAIL";
  else {
    const crashed = /Traceback|at Object\.|at Module\.|RangeError|TypeError|Cannot read|undefined is not/.test(r.out);
    verdict = (r.code === 1 || r.code === 2) && !crashed ? "PASS" : "FAIL";
  }
  results.push([verdict, name, r.code, r.out.replace(/\s+/g, " ").slice(0, 95)]);
}

// --- payload edge cases
check("empty payload", run(["embed", cover, "-o", join(dir, "a.png"), "--payload", ""]), "clean-error");
check("1-byte payload", run(["embed", cover, "-o", join(dir, "b.png"), "--payload", "x"]), "ok");
check("payload over capacity", run(["embed", cover, "-o", join(dir, "c.png"), "--payload", "z".repeat(5000)]), "clean-error");
check("unicode payload", run(["embed", cover, "-o", join(dir, "d.png"), "--payload", "মেসেজ 🔐 café"]), "ok");
check("newlines and quotes", run(["embed", cover, "-o", join(dir, "e.png"), "--payload", 'a\n"b"\t<c>']), "ok");

// --- image edge cases
const tiny = join(dir, "tiny.png");
writeFileSync(tiny, readFileSync("public/vite.svg")); // not even a PNG
check("non-image file as cover", run(["embed", tiny, "-o", join(dir, "f.png"), "--payload", "hi"]), "clean-error");
check("missing cover file", run(["embed", join(dir, "nope.jpg"), "-o", join(dir, "g.png"), "--payload", "hi"]), "clean-error");
check("detect on non-image", run(["detect", tiny]), "clean-error");
check("detect on clean cover", run(["detect", "robust_lab/covers/landscape_1600x1200.png"]), "clean-error");

// --- usage errors
check("no payload flag", run(["embed", cover, "-o", join(dir, "h.png")]), "clean-error");
check("missing output", run(["embed", cover, "--payload", "hi"]), "clean-error");
check("unknown mode", run(["embed", cover, "-o", join(dir, "i.png"), "--payload", "hi", "--mode", "banana"]), "clean-error");
check("unknown command", run(["frobnicate"]), "clean-error");
check("bad quality", run(["embed", cover, "-o", join(dir, "j.png"), "--payload", "hi", "--quality", "999"]), "clean-error");

// --- round trip of the odd ones
for (const [f, want] of [["d.png", "মেসেজ 🔐 café"], ["e.png", 'a\n"b"\t<c>'], ["b.png", "x"]]) {
  const r = run(["detect", join(dir, f), "--json"]);
  let got = null;
  try { const j = JSON.parse(r.out); got = j.encoding === "base64" ? Buffer.from(j.payload, "base64").toString() : j.payload; } catch {}
  results.push([got === want ? "PASS" : "FAIL", `round trip ${f}`, r.code, JSON.stringify(got)?.slice(0, 60) ?? "null"]);
}

console.log("verdict  case                          exit  detail");
console.log("-".repeat(100));
for (const [v, n, c, d] of results) console.log(`${v.padEnd(8)} ${n.padEnd(29)} ${String(c).padEnd(5)} ${d}`);
const failed = results.filter(r => r[0] === "FAIL").length;
console.log("-".repeat(100));
console.log(failed === 0 ? "\nAll hostile-input cases handled." : `\n${failed} case(s) need attention.`);
