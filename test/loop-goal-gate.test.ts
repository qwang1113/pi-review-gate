import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync,
  copyFileSync, readdirSync, existsSync, readFileSync, symlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Behavioral regression for the loop goal's core promise: writing
// `.pi/loop-goal.md` must not arm the gate.
//
// The fingerprint already excludes `.pi/` (GATE_EXCLUDE_PATHSPECS), but edit
// tracking used to classify every `.md` write as a doc change — so writing the
// goal set hasDocChange, demoted a recorded READY to PENDING and a precommit
// PASS to NOT_RUN, over a file no reviewer can see (it is not in the diff).
// The prompts tell the agent to rewrite the goal whenever it drifts, which
// would have made that self-deadlock a routine event.
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The extension imports ../lib/... and typebox relative to its own file, so
// run it from a temp copy that mirrors the pi-package layout
// (<pkg>/extensions/review-gate.ts + <pkg>/lib/). A per-fixture
// node_modules/typebox symlink keeps ESM resolution self-contained —
// os.tmpdir() is not /tmp on macOS, so a global /tmp/node_modules would not
// be found by walking up from the fixture.
const INSTALL = mkdtempSync(join(tmpdir(), "rg-lg-install-"));
const dirs: string[] = [INSTALL];
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
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
});

const { default: reviewGate } = await import(join(INSTALL, "extensions", "review-gate.ts"));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function makeRepo(): string {
  const parent = mkdtempSync(join(tmpdir(), "rg-lg-"));
  dirs.push(parent);
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
      // Enforced modes require a UI (a no-UI session is forced to normal).
      hasUI: true,
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: { getEntries: () => entries, getSessionId: () => "loop-goal-session" },
      isIdle: () => false,
      get cwd() { return cwd; },
    },
  };
}

function readSidecar(repo: string): Record<string, unknown> {
  const path = join(repo, ".pi", "review-gate-state.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("writing .pi/loop-goal.md does NOT arm the gate", async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, ".pi"), { recursive: true });
  const goalPath = join(repo, ".pi", "loop-goal.md");
  writeFileSync(goalPath, "# Goal\n\n1. ship it\n");

  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  await handlers.get("session_start")!({}, ctx);

  await handlers.get("tool_result")!({
    toolName: "write",
    isError: false,
    input: { path: goalPath },
    content: [{ type: "text", text: "ok" }],
  }, ctx);

  const state = readSidecar(repo);
  assert.notEqual(state.hasDocChange, true, "a gate-owned write must not arm the doc gate");
  assert.notEqual(state.hasCodeChange, true, "a gate-owned write must not arm the code gate");
  const edited = (state.sessionEditedFiles ?? []) as string[];
  assert.ok(!edited.some((f) => f.includes("loop-goal.md")), "gate-owned writes are not session edits");
});

test("a .pi-subagents artifact write does NOT arm the gate either", async () => {
  const repo = makeRepo();
  const artifact = join(repo, ".pi-subagents", "artifacts", "out.md");
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, "# subagent output\n");

  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  await handlers.get("session_start")!({}, ctx);

  await handlers.get("tool_result")!({
    toolName: "write",
    isError: false,
    input: { path: artifact },
    content: [{ type: "text", text: "ok" }],
  }, ctx);

  assert.notEqual(readSidecar(repo).hasDocChange, true);
});

test("a PROJECT doc write still arms the gate (the skip is scoped, not a hole)", async () => {
  const repo = makeRepo();
  const doc = join(repo, "README.md");
  writeFileSync(doc, "# readme\n");

  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  await handlers.get("session_start")!({}, ctx);

  await handlers.get("tool_result")!({
    toolName: "write",
    isError: false,
    input: { path: doc },
    content: [{ type: "text", text: "ok" }],
  }, ctx);

  const state = readSidecar(repo);
  assert.equal(state.hasDocChange, true, "project docs must still arm the gate");
  const edited = (state.sessionEditedFiles ?? []) as string[];
  assert.ok(edited.includes("README.md"), "project edits are attributed to the session");
});

test("a nested sub/.pi/ file is NOT gate-owned (only the repo root's is)", async () => {
  const repo = makeRepo();
  const nested = join(repo, "sub", ".pi", "notes.md");
  mkdirSync(dirname(nested), { recursive: true });
  writeFileSync(nested, "# notes\n");

  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  await handlers.get("session_start")!({}, ctx);

  await handlers.get("tool_result")!({
    toolName: "write",
    isError: false,
    input: { path: nested },
    content: [{ type: "text", text: "ok" }],
  }, ctx);

  // hasDocChange alone would NOT discriminate here: session_start's
  // pre-existing-change detection already sets it for sub/.pi/notes.md (only
  // the repo-root .pi/ is excluded from status). The session-edit attribution
  // is what proves the skip did not swallow this path.
  const state = readSidecar(repo);
  assert.equal(state.hasDocChange, true, "only the repo-root .pi/ is gate-owned");
  const edited = (state.sessionEditedFiles ?? []) as string[];
  assert.ok(edited.includes(join("sub", ".pi", "notes.md")), "a nested .pi/ file is a normal session edit");
});
