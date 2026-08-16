#!/usr/bin/env node
/**
 * pi-review-gate postinstall installer (runs on `pi install`, `npm install`).
 *
 * pi packages natively load extensions + skills from the package itself, so
 * this installer ONLY handles what the pi package spec does not: the
 * sub-agents (loaded by pi-subagents from ~/.pi/agent/agents/) and the git
 * hooks (installed per repo).
 *
 *   1. Copy agents/*.md → ~/.pi/agent/agents/  (idempotent, overwrite-owned)
 *   2. If the current directory is a git repository, install the git hooks
 *      into it (the common local-dev case: `npm install` in this repo).
 *
 * Idempotent and fail-soft: a broken HOME or non-git cwd is not an error —
 * the extension still loads, and the README explains how to install hooks
 * per repo (`npx pi-review-gate-install-hooks` or the shipped script).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const AGENT_DIR = join(homedir(), ".pi", "agent");
const AGENTS_DST = join(AGENT_DIR, "agents");

function log(line) {
  process.stdout.write(`[pi-review-gate] ${line}\n`);
}

function isGitRepo(dir) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function installAgents() {
  const srcDir = join(ROOT, "agents");
  if (!existsSync(srcDir)) {
    log("agents/ not found in package — skipping sub-agent install");
    return;
  }
  mkdirSync(AGENTS_DST, { recursive: true });
  let count = 0;
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith(".md")) continue;
    const src = join(srcDir, f);
    try {
      if (statSync(src).isFile()) {
        copyFileSync(src, join(AGENTS_DST, f));
        count += 1;
      }
    } catch (e) {
      log(`  ✗ could not install ${f}: ${e.message}`);
    }
  }
  log(`sub-agents installed (${count} files → ${AGENTS_DST})`);
}

function installHooksHere() {
  if (!isGitRepo(process.cwd())) {
    log("current directory is not a git repo — skipping git-hook install");
    log(`per-repo hooks: run 'bash ${join(ROOT, "scripts", "install-git-hooks.sh")}' inside a repo`);
    return;
  }
  log("current directory is a git repo — installing git hooks");
  const r = spawnSync("bash", [join(ROOT, "scripts", "install-git-hooks.sh")], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  if (r.status !== 0) {
    log(`  ✗ git-hook install exited ${r.status ?? "unknown"}`);
  }
}

try {
  installAgents();
} catch (e) {
  log(`  ✗ agent install failed: ${e.message}`);
}
try {
  installHooksHere();
} catch (e) {
  log(`  ✗ hook install failed: ${e.message}`);
}
log("done (extension + skills load natively via the pi package manifest)");
