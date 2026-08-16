#!/usr/bin/env node
/**
 * pi-review-gate postinstall installer (runs on `pi install`, `npm install`).
 *
 * pi packages natively load extensions + skills from the package itself, so
 * this installer ONLY handles what the pi package spec does not: the
 * sub-agents (loaded by pi-subagents from ~/.pi/agent/agents/), the git
 * hooks (installed per repo), and the COMPANION pi packages this extension
 * depends on at runtime (pi-subagents for the spawn-reviewer protocol,
 * pi-opencode-bridge for the opencode-go provider) — registered idempotently
 * via `pi install` so `pi install pi-review-gate` alone gives a working loop.
 *
 *   1. Copy agents/*.md → ~/.pi/agent/agents/  (idempotent, overwrite-owned)
 *   2. Register companion pi packages (pi-subagents / pi-opencode-bridge)
 *      into ~/.pi/agent/settings.json when missing (idempotent via `pi install`).
 *   3. If the current directory is a git repository, install the git hooks
 *      into it (the common local-dev case: `npm install` in this repo).
 *
 * Idempotent and fail-soft: a broken HOME or non-git cwd is not an error —
 * the extension still loads, and the README explains how to install hooks
 * per repo (`npx pi-review-gate-install-hooks` or the shipped script). A
 * missing `pi` CLU or a registration failure logs guidance instead of aborting.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const AGENT_DIR = join(homedir(), ".pi", "agent");
const AGENTS_DST = join(AGENT_DIR, "agents");
const PI_SETTINGS_PATH = join(AGENT_DIR, "settings.json");

/**
 * Companion pi packages this extension needs at runtime. Each entry is a
 * `pi install`-style source spec; when missing from the user's
 * ~/.pi/agent/settings.json packages list the installer registers it (the
 * pi CLI fetches and installs the package itself). Registration is
 * idempotent by construction: `pi install` of an already-present package is a
 * no-op that keeps the existing entry.
 *
 * The list is the extension's WORKING PLATFORM: subagents (pi-subagents),
 * provider keys (pi-opencode-bridge / pi-anthropic-oauth), editor
 * integration (pi-vim, @narumitw/pi-lsp), MCP tooling (pi-mcp-adapter,
 * pi-web-access), notifications (pi-notify), and leaderboard/readmap data
 * (pi-hashline-readmap). Every entry is also pinned in package.json
 * dependencies so the whole platform resolves on `npm install` / `pi install`.
 */
const COMPANION_PACKAGES = [
  "npm:pi-subagents",
  "npm:pi-opencode-bridge",
  "npm:pi-anthropic-oauth",
  "npm:pi-mcp-adapter",
  "npm:pi-notify",
  "npm:pi-vim",
  "npm:pi-web-access",
  "npm:@narumitw/pi-lsp",
  "npm:pi-hashline-readmap",
];


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

/**
 * Register companion pi packages (pi-subagents, pi-opencode-bridge) that this
 * extension needs at runtime, so `pi install pi-review-gate` alone yields a
 * working review loop. Reads the user's ~/.pi/agent/settings.json packages
 * list: missing entries are registered via `pi install <spec>` (idempotent —
 * the CLI keeps an already-present package as-is). Fail-soft: a missing pi
 * CLI, unreadable settings, or a failed registration logs guidance instead of
 * failing the install. The `pi` CLI is located on PATH; when pi itself is not
 * on PATH (rare — the CLI ships with pi), the follow-up instructions tell the
 * user the exact command to run.
 */
function registerCompanions() {
  let settings;
  try {
    if (!existsSync(PI_SETTINGS_PATH)) {
      log("no ~/.pi/agent/settings.json — skipping companion package registration");
      log("  companion packages are only needed inside a pi agent; run 'pi install' to set up pi homes");
      return;
    }
    settings = JSON.parse(readFileSync(PI_SETTINGS_PATH, "utf8"));
  } catch (e) {
    log(`  ✗ could not read ${PI_SETTINGS_PATH}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const packages = Array.isArray(settings?.packages) ? settings.packages : [];
  for (const spec of COMPANION_PACKAGES) {
    if (packages.includes(spec)) {
      log(`companion already registered: ${spec}`);
      continue;
    }
    log(`registering companion package: ${spec}`);
    const r = spawnSync("pi", ["install", spec], {
      stdio: "inherit",
      encoding: "utf8",
    });
    if (r.status !== 0) {
      log(`  ✗ could not register ${spec} — run 'pi install ${spec}' manually${r.error ? ` (${r.error.message})` : ""}`);
    }
  }
}

try {
  installAgents();
} catch (e) {
  log(`  ✗ agent install failed: ${e.message}`);
}
try {
  registerCompanions();
} catch (e) {
  log(`  ✗ companion registration failed: ${e.message}`);
}
try {
  installHooksHere();
} catch (e) {
  log(`  ✗ hook install failed: ${e.message}`);
}
log("done (extension + skills load natively via the pi package manifest)");
