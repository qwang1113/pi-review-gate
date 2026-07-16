#!/usr/bin/env node
/**
 * Standalone fingerprint computation (CJS, no Pi dependency).
 * Used by git hooks and other external consumers that can't import TypeScript.
 *
 * Mirrors lib/fingerprint.ts — keep them in sync.
 * Output: { digest, head, unavailable } as JSON on stdout.
 */

const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const { join, basename } = require("node:path");

const CODE_DOC_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "pyw", "ipynb",
  "go", "rs",
  "java", "kt", "kts", "scala",
  "rb", "php", "swift",
  "c", "cpp", "cc", "h", "hpp", "cs",
  "ex", "exs",
  "sh", "bash", "zsh",
  "md", "mdx",
]);

function gitOrNull(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function extOf(filePath) {
  const base = basename(filePath);
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx + 1).toLowerCase() : "";
}

function compute(cwd) {
  const head = gitOrNull(cwd, ["rev-parse", "HEAD"]) ?? "NO_HEAD";

  const stagedDiff = gitOrNull(cwd, ["diff", "--cached"]);
  if (stagedDiff === null) {
    return { digest: "__UNAVAILABLE__", head: "__UNAVAILABLE__", unavailable: true };
  }

  const trackedDiff =
    head === "NO_HEAD"
      ? stagedDiff
      : gitOrNull(cwd, ["diff", "HEAD"]);
  if (trackedDiff === null) {
    return { digest: "__UNAVAILABLE__", head: "__UNAVAILABLE__", unavailable: true };
  }

  const porcelain = gitOrNull(cwd, ["status", "--porcelain", "-uall", "-z"]);
  if (porcelain === null) {
    return { digest: "__UNAVAILABLE__", head: "__UNAVAILABLE__", unavailable: true };
  }

  const entries = porcelain.split("\0").filter(Boolean);
  const untrackedMeta = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].slice(0, 2) !== "??") continue;
    const name = entries[i].slice(3);
    if (!name) continue;
    const ext = extOf(name);
    if (CODE_DOC_EXT.has(ext)) {
      try {
        const content = readFileSync(join(cwd, name), "utf8");
        untrackedMeta.push(`${name}:sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`);
      } catch {
        untrackedMeta.push(`${name}:unstat`);
      }
    } else {
      try {
        const st = statSync(join(cwd, name));
        untrackedMeta.push(`${name}:${st.size}:${st.mtimeMs}`);
      } catch {
        untrackedMeta.push(`${name}:unstat`);
      }
    }
  }

  const digest = createHash("sha256")
    .update(head)
    .update("\0")
    .update(stagedDiff)
    .update("\0")
    .update(trackedDiff)
    .update("\0")
    .update(porcelain)
    .update("\0")
    .update(untrackedMeta.sort().join("\n"))
    .digest("hex");

  return { digest, head, unavailable: false };
}

const cwd = process.argv[2] || process.cwd();
console.log(JSON.stringify(compute(cwd)));
