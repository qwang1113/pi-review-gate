/**
 * The snapshot pin, driven END TO END through the real extension.
 *
 * WHY THIS FILE EXISTS. The pin's decisions are pure and truth-tabled in
 * test/reviewer-spawn-guard.test.ts, and its WIRING was pinned by source-text
 * assertions in test/extension-structure.test.ts. A reviewer demonstrated the
 * gap between those two: the wiring can be textually perfect and semantically
 * wrong. Its per-repo loop blocked a MULTI-REPO session's correctly-pinned
 * reviewer (repo A's snapshot list does not contain repo B's, so B's spawn
 * looked unpinned) — every text assertion still passed. So the hook and the
 * tools are exercised here for real: mock pi, real extension, real git repos.
 *
 * The harness mirrors test/multi-repo-gate.test.ts (hermetic HOME, a package
 * layout copy so the extension's relative imports resolve).
 */

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync,
  copyFileSync, readdirSync, symlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { hermeticGitEnv } from "./helpers/git.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = mkdtempSync(join(tmpdir(), "rg-pin-install-"));
const dirs: string[] = [INSTALL];
const TEST_HOME = mkdtempSync(join(tmpdir(), "rg-pin-HOME-"));
dirs.push(TEST_HOME);
const REAL_HOME = process.env.HOME;
process.env.HOME = TEST_HOME;

before(() => {
  mkdirSync(join(INSTALL, "extensions"), { recursive: true });
  mkdirSync(join(INSTALL, "lib"), { recursive: true });
  copyFileSync(join(ROOT, "extensions", "review-gate.ts"), join(INSTALL, "extensions", "review-gate.ts"));
  for (const f of readdirSync(join(ROOT, "lib"))) {
    copyFileSync(join(ROOT, "lib", f), join(INSTALL, "lib", f));
  }
  mkdirSync(join(INSTALL, "node_modules"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules", "typebox"), join(INSTALL, "node_modules", "typebox"));
});
after(() => {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const { default: reviewGate } = await import(join(INSTALL, "extensions", "review-gate.ts"));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: hermeticGitEnv() }).trim();
}

/** A repo with one commit AND an uncommitted edit (a review needs a change). */
function makeRepo(parent: string, name: string): string {
  const root = join(parent, name);
  git(parent, "init", "-b", "main", name);
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Gate Test");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, "add", "a.ts");
  git(root, "commit", "-m", "init");
  writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
  return realpathSync(root);
}

interface Harness {
  tools: Map<string, { execute: (id: unknown, p: Record<string, unknown>, sig?: unknown, upd?: unknown, ctx?: unknown) => Promise<unknown> }>;
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  ctx: Record<string, unknown>;
}

function makeMockPi(cwd: string): Harness & Record<string, unknown> {
  const tools = new Map();
  const handlers = new Map();
  const entries: unknown[] = [];
  const pi = {
    registerTool: (t: { name: string }) => tools.set(t.name, t),
    on: (ev: string, h: unknown) => handlers.set(ev, h),
    appendEntry: (type: string, data: unknown) => entries.push({ customType: type, data }),
    sendMessage: () => {},
    sendUserMessage: () => {},
    registerCommand: () => {},
  };
  return {
    ...pi,
    tools,
    handlers,
    ctx: {
      hasUI: true,
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: { getEntries: () => entries, getSessionId: () => "pin-session" },
      isIdle: () => false,
      cwd,
    },
  };
}

interface PrepareDetails {
  isolated?: boolean;
  snapshots?: Array<{ label: string; cwd: string }>;
}

async function bootstrap(repos: string[]) {
  const pi = makeMockPi(repos[0]!);
  reviewGate(pi as never);
  await pi.handlers.get("session_start")!({}, pi.ctx);
  // ARM every repo this test will review. `prepare_review` resolves its `repo`
  // argument against the repos the session has EDITED, so without this a
  // non-session repo is rejected ("not one of the repositories this session has
  // edited"), `details.isolated` is undefined, and a test that skips on that
  // asserts NOTHING. That is exactly how the multi-repo regression below sat
  // green while the bug it was written for was reintroduced — a reviewer proved
  // it by restoring the old per-repo loop and watching the suite stay green.
  const toolResult = pi.handlers.get("tool_result")!;
  for (const repo of repos) {
    await toolResult({
      toolName: "edit",
      isError: false,
      input: { path: join(repo, "a.ts") },
      content: [{ type: "text", text: "ok" }],
    }, pi.ctx);
  }
  return pi;
}

async function prepare(pi: ReturnType<typeof makeMockPi>, repo: string, labels: string[]) {
  const result = await pi.tools.get("prepare_review")!.execute(
    "id", { labels, repo }, undefined, undefined, pi.ctx,
  ) as { details: PrepareDetails; isError?: boolean };
  assert.notEqual(result.isError, true, "prepare_review must succeed for an armed repo");
  return result.details;
}

/**
 * Snapshots available? A host without `git worktree` reviews in place, and
 * there is nothing to assert there — but that must be an explicit SKIP, not a
 * bare `return` that reports a green test having checked nothing.
 */
function haveSnapshots(
  t: { skip: (why?: string) => void },
  details: PrepareDetails,
  min = 1,
): details is PrepareDetails & { snapshots: Array<{ label: string; cwd: string }> } {
  if (details.isolated === true && (details.snapshots?.length ?? 0) >= min) return true;
  t.skip(`host provided no review snapshots (isolated=${String(details.isolated)})`);
  return false;
}

const parent = mkdtempSync(join(tmpdir(), "rg-pin-"));
dirs.push(parent);
