import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync,
  copyFileSync, readdirSync, existsSync, readFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Regression test for the P-multi fix: the ship gate must bind to the repo a
// command actually operates on, not blindly to the session cwd. Reproduces the
// original failure (frontend dashboard repo shipped while the backend repo's
// stale READY+PASS legitimated it):
//   1. session cwd = repoA, gate READY+PASS on repoA
//   2. agent edits a file in repoB (a different checkout)
//   3. `cd repoB && git commit` MUST be blocked (repoB never passed review)
//   4. record_review targets repoB (active repo), precommit still required
//   5. declare_done requires BOTH repos to pass
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The extension imports ./lib/... and typebox relative to its own file, so
// load it from a temp copy under /tmp that mirrors the installed layout
// (extensions/pi-review-gate/); /tmp/node_modules symlinks provide typebox
// (ESM resolves node_modules up from the file's own directory).
const INSTALL = mkdtempSync(join(tmpdir(), "rg-ext-install-"));
before(() => {
  mkdirSync(join(INSTALL, "lib"), { recursive: true });
  copyFileSync(join(ROOT, "extensions", "review-gate.ts"), join(INSTALL, "review-gate.ts"));
  for (const f of readdirSync(join(ROOT, "lib"))) {
    copyFileSync(join(ROOT, "lib", f), join(INSTALL, "lib", f));
  }
});
after(() => {
  for (const d of [INSTALL, ...(globalThis as { __rgDirs?: string[] }).__rgDirs ?? []]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
});
const rgDirs = ((globalThis as { __rgDirs?: string[] }).__rgDirs ??= []);

const { default: reviewGate } = await import(join(INSTALL, "review-gate.ts"));

// ---- fixtures ---------------------------------------------------------------

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function makeRepo(parent: string, name: string): string {
  const root = join(parent, name);
  git(parent, "init", "-b", "main", name);
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Gate Test");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, "add", "a.ts");
  git(root, "commit", "-m", "init");
  return realpathSync(root);
}

interface MockPi {
  tools: Map<string, { execute: (id: unknown, p: Record<string, unknown>, sig?: AbortSignal, upd?: unknown, ctx?: unknown) => Promise<unknown> }>;
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  ctx: Record<string, unknown>;
  setCwd: (c: string) => void;
  entries: Array<{ customType?: string; data?: unknown }>;
}

function makeMockPi(cwd: string): MockPi {
  const tools = new Map();
  const handlers = new Map();
  const entries: Array<{ customType?: string; data?: unknown }> = [];
  const ui = { notify: () => {}, setStatus: () => {} };
  const sessionManager = {
    getEntries: () => entries,
    getSessionId: () => "test-session-1",
  };
  let sessionCwd = cwd;
  const pi = {
    registerTool: (t: { name: string }) => tools.set(t.name, t),
    on: (ev: string, h: unknown) => handlers.set(ev, h),
    appendEntry: (type: string, data: unknown) => entries.push({ customType: type, data }),
    sendMessage: () => {},
    sendUserMessage: () => {},
    registerCommand: () => {},
  };
  return {
    // Spread the pi API onto the returned object so tests can pass it
    // directly to reviewGate() AND reach the registration maps.
    ...pi,
    tools, handlers,
    entries,
    setCwd: (c: string) => { sessionCwd = c; },
    ctx: {
      hasUI: false,
      ui,
      sessionManager,
      isIdle: () => false,
      get cwd() { return sessionCwd; },
    },
  };
}

const READY_REVIEW = '```json\n{"gate":"READY","docSync":"NOT_NEEDED","findings":[]}\n```\n';

// ---------------------------------------------------------------------------

test("P-multi: a commit in an edited non-session repo is blocked by THAT repo's gate", async () => {
  const parent = mkdtempSync(join(tmpdir(), "rg-mg-"));
  rgDirs.push(parent);
  const repoA = makeRepo(parent, "repoA");
  const repoB = makeRepo(parent, "repoB");

  const pi = makeMockPi(repoA);
  reviewGate(pi as never);
  const { handlers, tools, ctx } = pi;
  const sessionStart = handlers.get("session_start")!;
  const toolResult = handlers.get("tool_result")!;
  const toolCall = handlers.get("tool_call")!;

  await sessionStart({}, ctx);

  // Give repoA a passing gate (READY + precommit PASS via sidecar surgery is
  // not allowed — PASS only comes from the runner — so simulate the historical
  // state with a READY review and rely on precommit being blocked).
  // First: edit repoB's file through the edit tool (arms repoB's gate).
  const repoBFile = join(repoB, "a.ts");
  writeFileSync(repoBFile, "export const a = 2;\n");
  const editResult = await toolResult({
    toolName: "edit",
    isError: false,
    input: { path: repoBFile },
    content: [{ type: "text", text: "ok" }],
  }, ctx);
  assert.equal(editResult, undefined, "edit result must be untouched");

  // Session repo (repoA) is clean — no ship block yet there.
  const cleanCommit = await toolCall({
    toolName: "bash",
    input: { command: `cd ${repoA} && git commit -am x` },
  }, ctx);
  assert.equal(cleanCommit, undefined, "clean-session commit must not block");

  // The cross-repo commit MUST be blocked: repoB was edited and has no READY.
  const blocked = await toolCall({
    toolName: "bash",
    input: { command: `cd ${repoB} && git commit -am x` },
  }, ctx);
  assert.ok(blocked && (blocked as { block?: boolean }).block === true,
    "commit in edited non-session repo must be blocked");
  const reason = JSON.stringify(blocked);
  assert.match(reason, /repoB/, "block reason must name the offending repo");

  // record_review targets the ACTIVE repo (repoB) — write repoB's sidecar.
  const recordReview = tools.get("record_review")!.execute;
  const rr = await recordReview("id", { reviewer_output: READY_REVIEW }, undefined, undefined, ctx);
  assert.equal((rr as { details: { verdict?: string } }).details.verdict, "READY");
  const sidecarB = JSON.parse(readFileSync(join(repoB, ".pi", "review-gate-state.json"), "utf8"));
  assert.equal(sidecarB.review.verdict, "READY");
  assert.ok(sidecarB.review.fingerprint, "READY must bind repoB's fingerprint");

  // Review READY alone is NOT enough: precommit is still NOT_RUN → blocked.
  const stillBlocked = await toolCall({
    toolName: "bash",
    input: { command: `cd ${repoB} && git push` },
  }, ctx);
  assert.ok(stillBlocked && (stillBlocked as { block?: boolean }).block === true,
    "push must stay blocked until repoB's precommit passes");

  // declare_done requires EVERY edited repo: repoB has a READY review but no
  // precommit PASS (and repoA never passed anything) → rejected.
  const declareDone = tools.get("declare_done")!.execute;
  const dd = await declareDone("id", { summary: "done" }, undefined, undefined, ctx);
  assert.equal((dd as { details: { accepted?: boolean } }).details.accepted, false,
    "declare_done must be rejected while any edited repo's gate is unmet");
});

test("P-multi: session repo untouched → cross-repo ship checks only the target repo", async () => {
  const parent = mkdtempSync(join(tmpdir(), "rg-mg2-"));
  rgDirs.push(parent);
  const repoA = makeRepo(parent, "repoA");
  const repoB = makeRepo(parent, "repoB");
  const repoBFile = join(repoB, "a.ts");
  writeFileSync(repoBFile, "export const a = 3;\n");

  const pi = makeMockPi(repoA);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  const sessionStart = handlers.get("session_start")!;
  const toolResult = handlers.get("tool_result")!;
  const toolCall = handlers.get("tool_call")!;
  await sessionStart({}, ctx);

  // Edit repoB only (repoA stays untouched).
  const editResult = await toolResult({
    toolName: "write",
    isError: false,
    input: { path: repoBFile },
    content: [{ type: "text", text: "ok" }],
  }, ctx);
  assert.equal(editResult, undefined);

  // repoB has uncommitted work + no gate state → fail-closed block.
  const blocked = await toolCall({
    toolName: "bash",
    input: { command: `cd ${repoB} && git commit -am x` },
  }, ctx);
  assert.ok(blocked && (blocked as { block?: boolean }).block === true);
});

test("P-multi: ambiguous cd ($VAR) widens the check to all edited repos", async () => {
  const parent = mkdtempSync(join(tmpdir(), "rg-mg3-"));
  rgDirs.push(parent);
  const repoA = makeRepo(parent, "repoA");
  const repoB = makeRepo(parent, "repoB");

  const pi = makeMockPi(repoA);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  const sessionStart = handlers.get("session_start")!;
  const toolResult = handlers.get("tool_result")!;
  const toolCall = handlers.get("tool_call")!;
  await sessionStart({}, ctx);

  // Edit repoB (arms its gate), then a variable-cd commit: the parser cannot
  // tell where it lands, so it must check repoB too → blocked.
  writeFileSync(join(repoB, "a.ts"), "export const a = 4;\n");
  await toolResult({
    toolName: "edit", isError: false,
    input: { path: join(repoB, "a.ts") },
    content: [{ type: "text", text: "ok" }],
  }, ctx);

  const blocked = await toolCall({
    toolName: "bash",
    input: { command: `cd $DIR && git commit -am x` },
  }, ctx);
  assert.ok(blocked && (blocked as { block?: boolean }).block === true,
    "variable-cd commit must be blocked because repoB's gate is unmet");
});

test("P-multi: a ship from a clean, never-edited repo is not blocked", async () => {
  const parent = mkdtempSync(join(tmpdir(), "rg-mg4-"));
  rgDirs.push(parent);
  const repoA = makeRepo(parent, "repoA");
  const repoC = makeRepo(parent, "repoC");

  const pi = makeMockPi(repoA);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  const sessionStart = handlers.get("session_start")!;
  const toolCall = handlers.get("tool_call")!;
  await sessionStart({}, ctx);

  // repoC is clean (one commit, nothing edited this session, no sidecar).
  const ok = await toolCall({
    toolName: "bash",
    input: { command: `cd ${repoC} && git commit -am x` },
  }, ctx);
  assert.equal(ok, undefined, "clean never-edited repo must not be blocked");
});

test("P-multi: git -C targets the right repo even with a cd chain", async () => {
  const parent = mkdtempSync(join(tmpdir(), "rg-mg5-"));
  rgDirs.push(parent);
  const repoA = makeRepo(parent, "repoA");
  const repoB = makeRepo(parent, "repoB");

  const pi = makeMockPi(repoA);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  const sessionStart = handlers.get("session_start")!;
  const toolResult = handlers.get("tool_result")!;
  const toolCall = handlers.get("tool_call")!;
  await sessionStart({}, ctx);

  // Edit repoB.
  writeFileSync(join(repoB, "a.ts"), "export const a = 5;\n");
  await toolResult({
    toolName: "edit", isError: false,
    input: { path: join(repoB, "a.ts") },
    content: [{ type: "text", text: "ok" }],
  }, ctx);

  // `cd repoA && git -C repoB commit` must check repoB → blocked.
  const blocked = await toolCall({
    toolName: "bash",
    input: { command: `cd ${repoA} && git -C ${repoB} commit -am x` },
  }, ctx);
  assert.ok(blocked && (blocked as { block?: boolean }).block === true,
    "git -C into an unreviewed repo must be blocked");
});

test("P-multi: sidecar from ANOTHER session is not trusted (stale PENDING stays blocking)", async () => {
  const parent = mkdtempSync(join(tmpdir(), "rg-mg6-"));
  rgDirs.push(parent);
  const repoA = makeRepo(parent, "repoA");
  const repoB = makeRepo(parent, "repoB");

  // Forge a stale sidecar from a DIFFERENT session with a READY review that
  // this session must NOT inherit (its fingerprint cannot match anyway, and
  // the edit re-arms it — the point is the state is treated as foreign).
  const staleDir = join(repoB, ".pi");
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(join(staleDir, "review-gate-state.json"), JSON.stringify({
    schema: 1,
    fingerprintVersion: 2,
    sessionId: "some-other-session",
    hasCodeChange: true,
    hasDocChange: false,
    review: { verdict: "READY", fingerprint: "deadbeef", at: "2026-01-01T00:00:00.000Z" },
    precommit: { verdict: "PASS", fingerprint: "deadbeef", at: "2026-01-01T00:00:00.000Z" },
    rounds: [],
    maxRounds: 10,
    bypass: { active: false, reason: null, at: null },
    updatedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2));

  const pi = makeMockPi(repoA);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  const sessionStart = handlers.get("session_start")!;
  const toolResult = handlers.get("tool_result")!;
  const toolCall = handlers.get("tool_call")!;
  await sessionStart({}, ctx);

  // Edit repoB (re-arms; a foreign READY must not survive).
  writeFileSync(join(repoB, "a.ts"), "export const a = 6;\n");
  await toolResult({
    toolName: "edit", isError: false,
    input: { path: join(repoB, "a.ts") },
    content: [{ type: "text", text: "ok" }],
  }, ctx);

  const blocked = await toolCall({
    toolName: "bash",
    input: { command: `cd ${repoB} && git commit -am x` },
  }, ctx);
  assert.ok(blocked && (blocked as { block?: boolean }).block === true,
    "stale READY from another session must not legitimate a commit");

  // And the sidecar must now belong to THIS session with PENDING review.
  const sidecarB = JSON.parse(readFileSync(join(staleDir, "review-gate-state.json"), "utf8"));
  assert.equal(sidecarB.sessionId, "test-session-1");
  assert.equal(sidecarB.review.verdict, "PENDING");
});

test("P-multi: editing the PRIMARY repo resets the active repo (no review deadlock)", async () => {
  const parent = mkdtempSync(join(tmpdir(), "rg-mg7-"));
  rgDirs.push(parent);
  const repoA = makeRepo(parent, "repoA");
  const repoB = makeRepo(parent, "repoB");

  const pi = makeMockPi(repoA);
  reviewGate(pi as never);
  const { handlers, tools, ctx } = pi;
  const sessionStart = handlers.get("session_start")!;
  const toolResult = handlers.get("tool_result")!;
  const toolCall = handlers.get("tool_call")!;
  await sessionStart({}, ctx);

  // Edit repoB first (active repo → repoB), then a file in the PRIMARY repo.
  writeFileSync(join(repoB, "a.ts"), "export const a = 7;\n");
  await toolResult({ toolName: "edit", isError: false, input: { path: join(repoB, "a.ts") }, content: [] }, ctx);
  const repoAFile = join(repoA, "a.ts");
  writeFileSync(repoAFile, "export const a = 8;\n");
  await toolResult({ toolName: "edit", isError: false, input: { path: repoAFile }, content: [] }, ctx);

  // record_review must now target the PRIMARY repo (active reset by the
  // primary edit) — its sidecar gets READY, repoB's sidecar stays PENDING.
  const recordReview = tools.get("record_review")!.execute;
  const rr = await recordReview("id", { reviewer_output: READY_REVIEW }, undefined, undefined, ctx);
  assert.equal((rr as { details: { verdict?: string } }).details.verdict, "READY");
  const sidecarA = JSON.parse(readFileSync(join(repoA, ".pi", "review-gate-state.json"), "utf8"));
  assert.equal(sidecarA.review.verdict, "READY", "review must land on the PRIMARY repo's sidecar");
  const sidecarB = JSON.parse(readFileSync(join(repoB, ".pi", "review-gate-state.json"), "utf8"));
  assert.equal(sidecarB.review.verdict, "PENDING", "repoB must stay unreviewed");

  // repoB is still unreviewed → its commit stays blocked.
  const blocked = await toolCall({
    toolName: "bash",
    input: { command: `cd ${repoB} && git commit -am x` },
  }, ctx);
  assert.ok(blocked && (blocked as { block?: boolean }).block === true);
});

test("P-multi: a ship targeting a NON-EXISTENT dir fails closed (mis-parse can't sail)", async () => {
  const parent = mkdtempSync(join(tmpdir(), "rg-mg8-"));
  rgDirs.push(parent);
  const repoA = makeRepo(parent, "repoA");
  const repoB = makeRepo(parent, "repoB");

  const pi = makeMockPi(repoA);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  const sessionStart = handlers.get("session_start")!;
  const toolResult = handlers.get("tool_result")!;
  const toolCall = handlers.get("tool_call")!;
  await sessionStart({}, ctx);

  // Edit repoB (arms its gate), then try to ship from a MIS-PARSED dir that
  // does not exist: the resolver marks it ambiguous, the widened check hits
  // repoB's unmet gate → blocked.
  writeFileSync(join(repoB, "a.ts"), "export const a = 9;\n");
  await toolResult({ toolName: "edit", isError: false, input: { path: join(repoB, "a.ts") }, content: [] }, ctx);

  const blocked = await toolCall({
    toolName: "bash",
    input: { command: `cd /tmp/rg-missing-dir-xyz && git commit -am x` },
  }, ctx);
  assert.ok(blocked && (blocked as { block?: boolean }).block === true,
    "ship from an unresolvable/missing dir must fail closed");
});
