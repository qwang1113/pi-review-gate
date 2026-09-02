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
import { neutraliseGateEnv } from "./helpers/gate-env.ts";
import { loadSidecar } from "../lib/gate-state.ts";

// Boots the REAL extension (same harness as loop-goal-gate.test.ts /
// multi-repo-gate.test.ts) and feeds it `tool_result` events, so the
// read-only drill stall guard is verified by BEHAVIOUR, not by grepping
// source tokens (a structure test cannot tell a live guard from one neutered
// by `if (false && ...)`).
neutraliseGateEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const INSTALL = mkdtempSync(join(tmpdir(), "rg-rs-install-"));
const TEST_HOME = mkdtempSync(join(tmpdir(), "rg-rs-HOME-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = TEST_HOME;
const rgDirs: string[] = [INSTALL, TEST_HOME];
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
  for (const d of rgDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
});

const { default: reviewGate } = await import(join(INSTALL, "extensions", "review-gate.ts"));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: hermeticGitEnv() }).trim();
}

function makeRepo(): string {
  const parent = mkdtempSync(join(tmpdir(), "rg-rs-repo-"));
  rgDirs.push(parent);
  const root = join(parent, "repo");
  git(parent, "init", "-b", "main", "repo");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Gate Test");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, "add", "a.ts");
  git(root, "commit", "-m", "init");
  return realpathSync(root);
}

function makeMockPi(cwd: string) {
  const tools = new Map<string, unknown>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const entries: Array<{ customType?: string; data?: unknown }> = [];
  const pi = {
    registerTool: (t: { name: string }) => tools.set(t.name, t),
    on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) => handlers.set(ev, h),
    appendEntry: (type: string, data: unknown) => entries.push({ customType: type, data }),
    sendMessage: () => {},
    sendUserMessage: () => {},
    registerCommand: () => {},
  };
  return {
    ...pi,
    tools, handlers, entries,
    ctx: {
      hasUI: true,
      ui: { notify: () => {}, setStatus: () => {}, confirm: async () => true, input: async () => undefined },
      sessionManager: { getEntries: () => entries, getSessionId: () => "rs-session" },
      isIdle: () => false,
      get cwd() { return cwd; },
    },
  };
}

/** Feed one successful read-family tool_result. */
async function readResult(pi: ReturnType<typeof makeMockPi>, toolName = "read"): Promise<unknown> {
  const h = pi.handlers.get("tool_result")!;
  return h({ toolName, isError: false, input: {}, content: [{ type: "text", text: "data" }] }, pi.ctx);
}

/** Feed one successful edit tool_result (production — resets the counter). */
async function editResult(pi: ReturnType<typeof makeMockPi>): Promise<unknown> {
  const h = pi.handlers.get("tool_result")!;
  return h({ toolName: "edit", isError: false, input: { path: join(pi.ctx.cwd, "a.ts") }, content: [{ type: "text", text: "ok" }] }, pi.ctx);
}

/** Count how many results carried the drill nudge. */
function countNudges(results: unknown[]): number {
  return results.filter((r) => {
    if (!r) return false;
    const obj = r as { content?: Array<{ type: string; text?: string }> };
    return (obj.content ?? []).some((c) => c.type === "text" && c.text?.includes("只读工具调用"));
  }).length;
}

test("read drill fires the nudge at the limit and only once per crossing", async () => {
  const repo = makeRepo();
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  await pi.handlers.get("session_start")!({}, pi.ctx);

  // 35 reads → exactly one nudge (at the 30th), never again before a reset.
  const results: unknown[] = [];
  for (let i = 0; i < 35; i++) results.push(await readResult(pi));
  assert.equal(countNudges(results), 1, "35 consecutive reads must nudge exactly once");
});

test("an edit resets the counter: a productive session is never nudged", async () => {
  // P2-2 from the reviewer: the core semantic "an edit is production" was
  // unpinned — flipping the edit site to produced:false kept the suite green
  // while a session with one edit per five calls got nudged at 30. This test
  // pins the real behaviour: a productive session must NEVER trip.
  const repo = makeRepo();
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  await pi.handlers.get("session_start")!({}, pi.ctx);

  const results: unknown[] = [];
  // 12 cycles of 4 reads + 1 edit = 48 reads, 12 edits → far past 30 reads,
  // but never 30 CONSECUTIVE reads.
  for (let cycle = 0; cycle < 12; cycle++) {
    for (let i = 0; i < 4; i++) results.push(await readResult(pi));
    results.push(await editResult(pi));
  }
  assert.equal(countNudges(results), 0, "a session that keeps editing must never be nudged");
});

test("bash drills count too, and an edit between drills re-arms", async () => {
  const repo = makeRepo();
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  await pi.handlers.get("session_start")!({}, pi.ctx);

  // 30 bash calls → nudge; edit resets; 30 more bash calls → nudge again.
  const results: unknown[] = [];
  const bashResult = async () => {
    const h = pi.handlers.get("tool_result")!;
    return h({ toolName: "bash", isError: false, input: { command: "grep x src" }, content: [{ type: "text", text: "out" }] }, pi.ctx);
  };
  for (let i = 0; i < 30; i++) results.push(await bashResult());
  assert.equal(countNudges(results), 1, "30 bash calls must nudge once");
  results.push(await editResult(pi));
  for (let i = 0; i < 30; i++) results.push(await bashResult());
  assert.equal(countNudges(results), 2, "after an edit reset, another 30 bash calls nudge again");
});

test("normal mode never nudges (the step-aside must not add extension text)", async () => {
  const repo = makeRepo();
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  // Preseed a normal-mode sidecar: the extension reads taskMode from it.
  mkdirSync(join(repo, ".pi"), { recursive: true });
  const sidecar = join(repo, ".pi", "review-gate-state.json");
  writeFileSync(sidecar, JSON.stringify({
    schema: 1,
    sessionId: "rs-session",
    taskMode: "normal",
    hasCodeChange: false,
    hasDocChange: false,
    review: { verdict: "PENDING", fingerprint: null, at: null },
    precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
    rounds: [],
    maxRounds: 10,
    bypass: { active: false, reason: null, at: null },
  }));
  await pi.handlers.get("session_start")!({}, pi.ctx);
  // The preseeded normal mode must survive session_start (a corrupt sidecar
  // would fall back to loop and start nudging — the exact regression this
  // test guards against).
  const afterStart = loadSidecar(sidecar);
  assert.equal(afterStart?.taskMode, "normal", "session_start must preserve the preseeded normal mode");

  const results: unknown[] = [];
  for (let i = 0; i < 40; i++) results.push(await readResult(pi));
  assert.equal(countNudges(results), 0, "normal mode must never append the drill nudge");
});
