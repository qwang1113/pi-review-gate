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
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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

test("E2E: an unpinned reviewer spawn is blocked, a pinned one is not", async (t) => {
  const repo = makeRepo(parent, "solo");
  const pi = await bootstrap([repo]);
  const details = await prepare(pi, repo, ["a1", "a2"]);
  if (!haveSnapshots(t, details, 2)) return;
  const toolCall = pi.handlers.get("tool_call")!;

  const missing = await toolCall({ toolName: "subagent", input: { agent: "reviewer", task: "review" } }, pi.ctx);
  assert.ok(missing && (missing as { block?: boolean }).block === true,
    "the exact call that caused the original bug must be refused");
  assert.match(JSON.stringify(missing), /LIVE worktree/);

  const wrong = await toolCall({ toolName: "subagent", input: { agent: "reviewer", cwd: repo } }, pi.ctx);
  assert.ok(wrong && (wrong as { block?: boolean }).block === true, "the live worktree is not a snapshot");

  const pinned = await toolCall(
    { toolName: "subagent", input: { agent: "reviewer", cwd: details.snapshots[0]!.cwd } }, pi.ctx,
  );
  assert.equal(pinned, undefined, "a correctly pinned reviewer must run");

  // Read-only helpers and management calls keep working during a review.
  assert.equal(await toolCall({ toolName: "subagent", input: { agent: "recon", task: "read" } }, pi.ctx), undefined);
  assert.equal(await toolCall({ toolName: "subagent", input: { action: "list" } }, pi.ctx), undefined);
});

test("E2E: reviewers dispatched through a workflow are blocked whatever the tool name looks like", async (t) => {
  const repo = makeRepo(parent, "wf");
  const pi = await bootstrap([repo]);
  const details = await prepare(pi, repo, ["a1"]);
  if (!haveSnapshots(t, details)) return;
  const toolCall = pi.handlers.get("tool_call")!;

  const wf = await toolCall({
    toolName: "subagent",
    input: { workflowScript: 'await runs.all([{key:"a", agent:"reviewer", task:"review"}]);' },
  }, pi.ctx);
  assert.ok(wf && (wf as { block?: boolean }).block === true, "a workflow cannot carry a per-child cwd");

  // The same tool arrives under a proxied name when it is not in-process.
  const proxied = await toolCall({ toolName: "mcp__pi__subagent", input: { agent: "reviewer" } }, pi.ctx);
  assert.ok(proxied && (proxied as { block?: boolean }).block === true,
    "a proxied tool name must not make the guard inert");
});

test("REGRESSION E2E: a multi-repo session can still review its second repo", async (t) => {
  // The per-repo loop this replaced blocked repoB's correctly-pinned reviewer
  // because repoA's snapshot list did not contain it — and pointed the agent at
  // repoA's snapshots, with no way forward. Verified to FAIL against that loop
  // (a reviewer restored it and this case went red only once `bootstrap` armed
  // both repos — before that the case skipped and proved nothing).
  const repoA = makeRepo(parent, "mrA");
  const repoB = makeRepo(parent, "mrB");
  const pi = await bootstrap([repoA, repoB]);
  const a = await prepare(pi, repoA, ["a1"]);
  const b = await prepare(pi, repoB, ["b1"]);
  if (!haveSnapshots(t, a) || !haveSnapshots(t, b)) return;
  const toolCall = pi.handlers.get("tool_call")!;

  const pinnedB = await toolCall(
    { toolName: "subagent", input: { agent: "reviewer", cwd: b.snapshots[0]!.cwd } }, pi.ctx,
  );
  assert.equal(pinnedB, undefined, "repo B's reviewer must not be judged against repo A's snapshots");

  const pinnedA = await toolCall(
    { toolName: "subagent", input: { agent: "reviewer", cwd: a.snapshots[0]!.cwd } }, pi.ctx,
  );
  assert.equal(pinnedA, undefined, "and repo A's reviewer still runs");

  const unpinned = await toolCall({ toolName: "subagent", input: { agent: "reviewer" } }, pi.ctx);
  assert.ok(unpinned && (unpinned as { block?: boolean }).block === true,
    "an unpinned reviewer stays blocked in a multi-repo session too");
});

test("E2E: a snapshot nobody entered withholds the READY", async (t) => {
  const repo = makeRepo(parent, "unused");
  const pi = await bootstrap([repo]);
  const details = await prepare(pi, repo, ["seen", "never"]);
  if (!haveSnapshots(t, details, 2)) return;
  const toolCall = pi.handlers.get("tool_call")!;
  const seen = details.snapshots.find((s) => s.label === "seen")!;

  await toolCall({ toolName: "subagent", input: { agent: "reviewer", cwd: seen.cwd } }, pi.ctx);

  const record = await pi.tools.get("record_review")!.execute("id", {
    reviewer_output: '```json\n{"gate":"READY","docSync":"NOT_NEEDED","findings":[]}\n```\n',
    repo,
  }, undefined, undefined, pi.ctx) as { details: { verdict?: string; snapshotUnused?: string[] } };

  assert.equal(record.details.verdict, "BLOCKED",
    "one entered snapshot must not vouch for the one nobody opened");
  assert.deepEqual(record.details.snapshotUnused, ["never"]);
});

test("E2E: a reviewer's own pwd is accepted as evidence", async (t) => {
  // The path the spawn guard cannot observe (another session, a future tool
  // name): the verdict itself reports where the review ran.
  const repo = makeRepo(parent, "selfreport");
  const pi = await bootstrap([repo]);
  const details = await prepare(pi, repo, ["one", "two"]);
  if (!haveSnapshots(t, details, 2)) return;

  const fences = details.snapshots
    .map((s) => '```json\n' + JSON.stringify({ gate: "READY", docSync: "NOT_NEEDED", cwd: s.cwd, findings: [] }) + '\n```')
    .join("\n\n");
  const record = await pi.tools.get("record_review")!.execute("id", {
    reviewer_output: fences,
    repo,
  }, undefined, undefined, pi.ctx) as { details: { verdict?: string; snapshotUnused?: string[] } };

  assert.equal(record.details.verdict, "READY", "self-reported cwds cover every snapshot");
  assert.equal(record.details.snapshotUnused, undefined);
});
