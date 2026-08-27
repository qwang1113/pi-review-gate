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
import { goalTextHash } from "../lib/loop-goal.ts";
import { gitRootOfDir } from "../lib/repo-resolve.ts";
import { isPiSelfPath } from "../lib/pi-self.ts";
import { hermeticGitEnv } from "./helpers/git.ts";

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
// HERMETIC HOME for the whole file: session_start renders the model layers and
// self-heals missing agent files into `~/.pi/agent/agents`, so a test run must
// never reach the developer's real home (nor depend on their global config).
// Today the shared INSTALL fixture ships no `agents/` so the probe finds
// nothing — but that is a property of the fixture, not a guarantee, and this
// makes the isolation mechanical instead of incidental.
const TEST_HOME = mkdtempSync(join(tmpdir(), "rg-lg-HOME-"));
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
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
});

const { default: reviewGate } = await import(join(INSTALL, "extensions", "review-gate.ts"));

// A SECOND fixture that also ships `agents/`, so the bootstrap self-heal is
// actually reachable. The shared INSTALL above deliberately has none (its
// probe returns null), which is why every other test in this file leaves the
// user's agent dir alone — the heal must only ever be exercised against an
// isolated HOME, never the developer's real one.
const INSTALL_WITH_AGENTS = mkdtempSync(join(tmpdir(), "rg-lg-install-agents-"));
dirs.push(INSTALL_WITH_AGENTS);
before(() => {
  mkdirSync(join(INSTALL_WITH_AGENTS, "extensions"), { recursive: true });
  mkdirSync(join(INSTALL_WITH_AGENTS, "lib"), { recursive: true });
  mkdirSync(join(INSTALL_WITH_AGENTS, "agents"), { recursive: true });
  copyFileSync(join(ROOT, "extensions", "review-gate.ts"), join(INSTALL_WITH_AGENTS, "extensions", "review-gate.ts"));
  for (const f of readdirSync(join(ROOT, "lib"))) {
    copyFileSync(join(ROOT, "lib", f), join(INSTALL_WITH_AGENTS, "lib", f));
  }
  for (const f of readdirSync(join(ROOT, "agents"))) {
    copyFileSync(join(ROOT, "agents", f), join(INSTALL_WITH_AGENTS, "agents", f));
  }
  mkdirSync(join(INSTALL_WITH_AGENTS, "node_modules"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules", "typebox"), join(INSTALL_WITH_AGENTS, "node_modules", "typebox"));
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: hermeticGitEnv() }).trim();
}

function makeRepoAt(base: string): string {
  const parent = mkdtempSync(join(base, "rg-lg-"));
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

function makeRepo(): string {
  return makeRepoAt(tmpdir());
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
      ui: {
        notify: () => {},
        setStatus: () => {},
        // propose_loop_goal approval dialog: accept by default; a test can
        // override `ui.confirm` on the returned object to simulate a refusal.
        confirm: async () => true,
        // The reject path asks for a reason; the confirm path no longer does.
        input: async () => undefined,
      },
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

// ---------------------------------------------------------------------------
// L8 edit gate — loop mode blocks edit/write until the USER approved a goal.
// ---------------------------------------------------------------------------

const GOAL_TEXT =
  "# Loop goal: test\n\n**Intent**: n/a\n\n**Exit criteria**:\n1. tests pass\n\n**Date**: 2026-08-23";

type ToolMap = { tools: Map<string, unknown> };

type ToolExecute = (id: string, params: unknown, s: unknown, u: unknown, c: unknown) => Promise<unknown>;

function tool(pi: ToolMap, name: string): ToolExecute {
  const t = pi.tools.get(name) as { execute: ToolExecute } | undefined;
  return (id, params, s, u, c) => t!.execute(id, params, s, u, c);
}

function setMode(pi: ToolMap, ctx: unknown, mode: string) {
  // set_gate_mode is a registered TOOL, so drive it exactly like the agent does.
  return tool(pi, "set_gate_mode")("id", { mode, reason: "test" }, undefined, undefined, ctx);
}

function editCall(handlers: Map<string, (event: unknown, ctx: unknown) => unknown>, path: string, ctx: unknown) {
  return handlers.get("tool_call")!({ toolName: "edit", input: { path } }, ctx);
}

/** A goal-auditor reply the EXTENSION will read as a pass (READY, no P0/P1). */
const AUDITOR_PASS = 'The draft is checkable and scoped.\n\n```json\n{"gate": "READY", "findings": []}\n```';
/** …and one it must read as a fail. */
const AUDITOR_FAIL = 'Criterion 1 cannot be judged.\n\n```json\n{"gate": "BLOCKED", "findings": [{"severity": "P1", "issue": "不可检查"}]}\n```';

/** Drive the L8b pre-review exactly like the agent does, before proposing. */
async function recordPrereview(pi: ToolMap, ctx: unknown, goal: string, repo?: string, output = AUDITOR_PASS) {
  return tool(pi, "record_goal_prereview")(
    "id",
    repo ? { goal, auditor_output: output, repo } : { goal, auditor_output: output },
    undefined,
    undefined,
    ctx,
  );
}

async function approveGoal(pi: ToolMap, ctx: unknown, goal: string, repo?: string) {
  await recordPrereview(pi, ctx, goal, repo);
  const result = await tool(pi, "propose_loop_goal")("id", repo ? { goal, repo } : { goal }, undefined, undefined, ctx);
  assert.equal((result as { details: { approved?: boolean } }).details.approved, true, "goal must be approved by the mock dialog");
}

test("L8b: propose_loop_goal is REFUSED without a matching goal-auditor PASS — no dialog at all", async () => {
  // The whole point of the mechanical pre-review: the user must never be asked
  // to approve a draft no auditor judged. A refusal that still rendered the
  // dialog would leave the old "protocol the agent can skip" behavior intact.
  const repo = makeRepo();
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  await handlers.get("session_start")!({}, ctx);
  let dialogs = 0;
  const shown: string[] = [];
  const uiCtx = ctx as {
    ui: {
      confirm: (t: string, m: string) => Promise<boolean>;
      // NOTE the signature: notify takes (message, type) — capturing the SECOND
      // argument here would silently record the severity and leave the
      // transcript surface untested.
      notify?: (message: string, type?: string) => unknown;
    };
  };
  const notify = uiCtx.ui.notify?.bind(uiCtx.ui);
  uiCtx.ui.notify = (message: string, type?: string) => { shown.push(String(message)); return notify?.(message, type); };
  uiCtx.ui.confirm = async (_t, m) => { dialogs++; shown.push(String(m)); return true; };

  const noAudit = await tool(pi, "propose_loop_goal")("id", { goal: GOAL_TEXT }, undefined, undefined, ctx);
  assert.equal((noAudit as { isError?: boolean }).isError, true, "an unaudited goal must be refused");
  assert.equal((noAudit as { details: { approved?: boolean } }).details.approved, false);
  assert.equal(dialogs, 0, "the user must not be asked about an unaudited draft");
  assert.match(JSON.stringify(noAudit), /record_goal_prereview/, "the refusal must name the recovery path");
  assert.equal(readSidecar(repo).loopGoal, undefined, "no approval may be recorded");
  // The isolated HOME has no goal-auditor, so the refusal offers the BOOTSTRAP
  // remedy — and a project copy must clear it by frontmatter IDENTITY, not by
  // filename: pi-subagents dispatches project agents by their declared `name`.
  assert.match(JSON.stringify(noAudit), /BOOTSTRAP/, "a missing role must be called out");
  const projectAgents = join(repo, ".pi", "agents");
  mkdirSync(projectAgents, { recursive: true });
  writeFileSync(join(projectAgents, "custom.md"), "---\nname: goal-auditor\ndescription: local override\n---\nbody\n");
  const renamedRole = await tool(pi, "propose_loop_goal")("id", { goal: GOAL_TEXT }, undefined, undefined, ctx);
  assert.equal((renamedRole as { isError?: boolean }).isError, true, "still refused — the audit itself is what is missing");
  assert.doesNotMatch(
    JSON.stringify(renamedRole),
    /BOOTSTRAP/,
    "but a project file DECLARING name: goal-auditor is dispatchable, so the bootstrap remedy must not be offered",
  );
  rmSync(projectAgents, { recursive: true, force: true });

  // A FAIL verdict is recorded, but it does not open the dialog either.
  await recordPrereview(pi, ctx, GOAL_TEXT, undefined, AUDITOR_FAIL);
  assert.equal((readSidecar(repo).goalPrereview as { verdict?: string } | undefined)?.verdict, "FAIL");
  const afterFail = await tool(pi, "propose_loop_goal")("id", { goal: GOAL_TEXT }, undefined, undefined, ctx);
  assert.equal((afterFail as { isError?: boolean }).isError, true, "a FAIL keeps the dialog shut");
  assert.equal(dialogs, 0);

  // An auditor reply with NO parseable fence must record nothing (fail-closed)
  // — otherwise a truncated or hand-written reply could look like an audit.
  const unparseable = await recordPrereview(pi, ctx, GOAL_TEXT, undefined, "Looks good to me, ship it.");
  assert.equal((unparseable as { isError?: boolean }).isError, true);
  assert.equal((readSidecar(repo).goalPrereview as { verdict?: string } | undefined)?.verdict, "FAIL",
    "the previous record must survive an unparseable submission");

  // PASS for the audited text opens the dialog — and only for THAT text.
  await recordPrereview(pi, ctx, GOAL_TEXT);
  const edited = await tool(pi, "propose_loop_goal")("id", { goal: GOAL_TEXT + "\n2. 又一条" }, undefined, undefined, ctx);
  assert.equal((edited as { isError?: boolean }).isError, true, "editing after the PASS needs a fresh audit");
  assert.match(JSON.stringify(edited), /DIFFERENT text/);
  assert.equal(dialogs, 0);

  const approved = await tool(pi, "propose_loop_goal")("id", { goal: GOAL_TEXT }, undefined, undefined, ctx);
  assert.equal((approved as { details: { approved?: boolean } }).details.approved, true);
  assert.equal(dialogs, 1, "the audited text reaches the user exactly once");
  // Exit criterion 5: the user must SEE that an independent audit passed — and
  // see it after the repo binding, which is the consent-critical fact the
  // dialog budget must never truncate away.
  // BOTH surfaces must carry it: the transcript echo (notify) is where the
  // user actually reads the goal, and the dialog is where consent is given.
  // Asserting only the joined text would let one of them go dark.
  const carriers = shown.filter((m) => /goal-auditor 预审: PASS @ \d{4}-\d{2}-\d{2}T/.test(m));
  assert.equal(carriers.length, 2, `both the transcript and the dialog must show the pre-review fact: ${JSON.stringify(shown)}`);
  for (const surface of carriers) {
    // Assert the repo binding is PRESENT before comparing positions: with a
    // bare `indexOf(...) < indexOf(...)` a vanished repo line yields -1, which
    // is less than any index, so the ordering check would pass vacuously
    // exactly when the consent-critical fact went missing.
    const repoAt = surface.indexOf("仓库");
    const prereviewAt = surface.indexOf("goal-auditor 预审");
    assert.ok(repoAt >= 0, `the repo binding must be on this surface: ${surface}`);
    assert.ok(prereviewAt >= 0, `the pre-review line must be on this surface: ${surface}`);
    assert.ok(
      repoAt < prereviewAt,
      "the pre-review line must come AFTER the repo binding on every surface",
    );
  }
});

test("L8b BOOTSTRAP: session start heals a MISSING goal-auditor into the agents dir (idempotently)", async () => {
  // The role that gates every goal approval must become dispatchable on its
  // own, or a fresh install deadlocks: no auditor ⇒ no PASS ⇒ no dialog ⇒ (in
  // loop mode) no edits either. Structural assertions cannot prove that; this
  // drives the real session_start against an ISOLATED home.
  const fakeHome = mkdtempSync(join(tmpdir(), "rg-lg-home-"));
  dirs.push(fakeHome);
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const { default: gateWithAgents } = await import(join(INSTALL_WITH_AGENTS, "extensions", "review-gate.ts"));
    const repo = makeRepo();
    const pi = makeMockPi(repo);
    gateWithAgents(pi as never);
    const agentsDir = join(fakeHome, ".pi", "agent", "agents");
    assert.equal(existsSync(join(agentsDir, "goal-auditor.md")), false, "precondition: the role is missing");

    await pi.handlers.get("session_start")!({}, pi.ctx);
    assert.equal(existsSync(join(agentsDir, "goal-auditor.md")), true, "session start must restore the gate-critical role");
    const healed = readFileSync(join(agentsDir, "goal-auditor.md"), "utf8");
    assert.match(healed, /name: goal-auditor/, "and it must be the real role file, not an empty placeholder");

    // Idempotent + gaps-only: a local edit must survive the next session start.
    writeFileSync(join(agentsDir, "goal-auditor.md"), healed + "\n<!-- local note -->\n");
    await pi.handlers.get("session_start")!({}, pi.ctx);
    assert.match(
      readFileSync(join(agentsDir, "goal-auditor.md"), "utf8"),
      /local note/,
      "the heal fills gaps; it must never overwrite an existing file",
    );
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
});

test("L8b BOOTSTRAP: an unlocatable package agents dir is REPORTED, never a silent no-op", async () => {
  // Exit criterion 4 in one assertion: when the probe cannot find the package's
  // own agents/ (the shared INSTALL fixture ships none), the heal must SAY so.
  // A silent no-op is exactly how a missing gate role turns into an
  // unexplainable deadlock.
  const fakeHome = mkdtempSync(join(tmpdir(), "rg-lg-home-quiet-"));
  dirs.push(fakeHome);
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const problems: string[] = [];
  try {
    const repo = makeRepo();
    const pi = makeMockPi(repo);
    reviewGate(pi as never);
    const uiCtx = pi.ctx as { ui: { notify?: (message: string, type?: string) => unknown } };
    const notify = uiCtx.ui.notify?.bind(uiCtx.ui);
    uiCtx.ui.notify = (message: string, type?: string) => { problems.push(String(message)); return notify?.(message, type); };

    await pi.handlers.get("session_start")!({}, pi.ctx);
    assert.equal(
      existsSync(join(fakeHome, ".pi", "agent", "agents", "goal-auditor.md")),
      false,
      "precondition: this fixture ships no agents/, so nothing can be healed",
    );
    assert.match(
      problems.join("\n"),
      /包内 agents 目录无法定位/,
      `the failed probe must surface a diagnostic: ${JSON.stringify(problems)}`,
    );
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
});

test("L8b: record_goal_prereview refuses an empty goal and a non-repo `repo`, recording nothing", async () => {
  // Both are dead-approval guards: a record bound to empty text or parked in a
  // non-repo directory could never satisfy propose_loop_goal, so recording one
  // would only look like progress.
  const repo = makeRepo();
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  await handlers.get("session_start")!({}, ctx);

  const empty = await tool(pi, "record_goal_prereview")("id", { goal: "   \n\t ", auditor_output: AUDITOR_PASS }, undefined, undefined, ctx);
  assert.equal((empty as { isError?: boolean }).isError, true, "an empty draft cannot be audited");
  assert.equal(readSidecar(repo).goalPrereview, undefined, "nothing may be recorded");

  // Same length cap propose_loop_goal enforces: auditing a draft the approval
  // tool can never accept would burn a whole audit round for a PASS that is
  // structurally unusable.
  const huge = "# 目标\n\n" + "卡".repeat(20001);
  const tooLong = await tool(pi, "record_goal_prereview")("id", { goal: huge, auditor_output: AUDITOR_PASS }, undefined, undefined, ctx);
  assert.equal((tooLong as { isError?: boolean }).isError, true, "an over-long draft must be refused BEFORE it is audited");
  assert.match(JSON.stringify(tooLong), /20000/, "the refusal must name the limit");
  assert.equal(readSidecar(repo).goalPrereview, undefined, "and record nothing");

  const notARepo = mkdtempSync(join(dirname(repo), "rg-norepo-pre-"));
  dirs.push(notARepo);
  const badRepo = await tool(pi, "record_goal_prereview")(
    "id",
    { goal: GOAL_TEXT, auditor_output: AUDITOR_PASS, repo: notARepo },
    undefined, undefined, ctx,
  );
  assert.equal((badRepo as { isError?: boolean }).isError, true, "a non-repo path must be refused");
  assert.equal(readSidecar(repo).goalPrereview, undefined, "and it must not land in the session repo either");

  // NEEDS_HUMAN is a FAIL, not a pass: only READY opens the dialog.
  const needsHuman = 'Cannot judge this alone.\n\n```json\n{"gate": "NEEDS_HUMAN", "findings": []}\n```';
  await recordPrereview(pi, ctx, GOAL_TEXT, undefined, needsHuman);
  assert.equal((readSidecar(repo).goalPrereview as { verdict?: string } | undefined)?.verdict, "FAIL");
});

test("L8: loop mode with NO confirmed goal blocks edit/write; approval unblocks it", async () => {
  const repo = makeRepo();
  const file = join(repo, "a.ts");
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  await handlers.get("session_start")!({}, ctx);

  // Undecided mode behaves as loop (fail-closed): the edit is blocked before
  // any mode decision, so the agent cannot start editing its own contract.
  // (This test repo lives under the scratch dir, where the agent can never
  // enter loop explicitly — undecided IS the loop behavior, exactly like the
  // multi-repo ship tests rely on.)
  const blocked = await editCall(handlers, file, ctx);
  assert.ok(blocked && (blocked as { block?: boolean }).block === true,
    "undecided (loop-equivalent) edit must be blocked without a confirmed goal");
  assert.match(JSON.stringify(blocked), /loop goal/, "block must name the goal");
  assert.match(JSON.stringify(blocked), /goal-auditor/, "block must carry the goal-auditor pre-review step");

  // A path-less edit/write call cannot be attributed to a repo, so it must
  // fail closed against the PRIMARY repo's goal (round P2: untested branch).
  const pathless = await handlers.get("tool_call")!({ toolName: "edit", input: {} }, ctx);
  assert.ok(pathless && (pathless as { block?: boolean }).block === true,
    "a path-less edit call must fail closed against the primary repo's goal");

  // User approves the goal in the (mock) dialog → the same edit passes.
  await approveGoal(pi, ctx, GOAL_TEXT);
  const passed = await editCall(handlers, file, ctx);
  assert.equal(passed, undefined, "a confirmed goal must unblock edits");
});

test("L8: EXPLICIT loop mode (not just undecided) blocks edits without a goal and unlocks with one", async (t) => {
  // Every other L8 test drives the gate in the UNDECIDED state: a fixture
  // repo under /tmp can never enter loop via set_gate_mode (scratch clamp in
  // lib/pi-self.ts). This repo lives OUTSIDE /tmp (never scratch, never
  // HOME-dependent — a sandbox whose HOME lives under /tmp would force
  // normal mode and fail the test spuriously), so the explicit
  // taskMode === "loop" branch runs end-to-end through tool_call — a
  // mutation that disabled L8 for exactly loop mode used to survive the
  // whole suite. The base is the first ancestor of this test file whose path
  // has no rg-review-snap- segment and is outside any git repo: inside a
  // review snapshot the fixture must not sit under the snapshot segment
  // (isReviewSnapshotPath would make the extension inert and the test would
  // fail there), and outside one it must not pollute the reviewed repo with
  // untracked files.
  let base = ROOT;
  for (;;) {
    const parent = dirname(base);
    if (parent === base) break;
    if (!base.includes("rg-review-snap-") && !isPiSelfPath(base) && gitRootOfDir(base) === null) break;
    base = parent;
  }
  // On an unusual host the candidate base is unwritable — skip on EACCES
  // rather than fail: the test needs a writable non-scratch, non-snapshot
  // directory that the environment does not provide. (The base walk already
  // excludes scratch, so no scratch check is needed here.)
  let repo: string;
  try {
    repo = makeRepoAt(base);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      t.skip(`no writable non-scratch base under ${base}: ${(err as Error).message}`);
      return;
    }
    throw err;
  }
  const file = join(repo, "a.ts");
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  await handlers.get("session_start")!({}, ctx);

  const mode = await setMode(pi, ctx, "loop");
  assert.equal((mode as { details: { mode?: string } }).details.mode, "loop",
    "a non-scratch session must accept an explicit loop classification");

  const blocked = await editCall(handlers, file, ctx);
  assert.ok(blocked && (blocked as { block?: boolean }).block === true,
    "explicit loop mode must block edits without a confirmed goal");
  assert.match(JSON.stringify(blocked), /set_gate_mode/, "the block must point an undecided/loop session at set_gate_mode");

  await approveGoal(pi, ctx, GOAL_TEXT);
  const passed = await editCall(handlers, file, ctx);
  assert.equal(passed, undefined, "a confirmed goal must unblock edits in explicit loop mode");
});

test("L8: a goal edited AFTER approval drops the approval and re-blocks edits", async () => {
  const repo = makeRepo();
  const file = join(repo, "a.ts");
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  await handlers.get("session_start")!({}, ctx);
  await approveGoal(pi, ctx, GOAL_TEXT);

  const passed = await editCall(handlers, file, ctx);
  assert.equal(passed, undefined, "freshly approved goal must pass");

  // The contract text changes (agent or user edit) → the approval no longer
  // describes the file → fail-closed back to blocked.
  writeFileSync(join(repo, ".pi", "loop-goal.md"), GOAL_TEXT + "\n4. changed criterion\n", "utf8");
  const reBlocked = await editCall(handlers, file, ctx);
  assert.ok(reBlocked && (reBlocked as { block?: boolean }).block === true,
    "a goal file that no longer matches the approval must re-block edits");
});

test("L8: explore mode edits are NOT goal-gated (goal is a loop-mode contract)", async () => {
  const repo = makeRepo();
  const file = join(repo, "a.ts");
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  await handlers.get("session_start")!({}, ctx);

  const mode = await setMode(pi, ctx, "explore");
  assert.equal((mode as { details: { mode?: string } }).details.mode, "explore");
  const passed = await editCall(handlers, file, ctx);
  assert.equal(passed, undefined, "explore must not gate edits on the loop goal");
});

test("L8: gate-owned writes stay exempt even without a goal (no self-deadlock)", async () => {
  const repo = makeRepo();
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  await handlers.get("session_start")!({}, ctx);
  // NOTE: no setMode here on purpose — in this /tmp test repo an agent
  // set_gate_mode("loop") is clamped to normal by scratchFirstMode, and a
  // normal-mode early return would make every assertion below trivially true
  // (the test would be dead code). Undecided IS the loop behavior, exactly
  // like the first L8 test above.

  // The goal file itself, the sidecar, the project config: all under .pi/.
  const goalPath = join(repo, ".pi", "loop-goal.md");
  mkdirSync(dirname(goalPath), { recursive: true });
  const goalWrite = await editCall(handlers, goalPath, ctx);
  assert.equal(goalWrite, undefined, "writing the goal file must never be goal-gated");

  const cfgPath = join(repo, ".pi", "review-gate.json");
  const cfgWrite = await editCall(handlers, cfgPath, ctx);
  assert.equal(cfgWrite, undefined, "project config writes must stay exempt");

  // Sanity: a NORMAL edit in the same undecided session IS still blocked —
  // proves this test actually exercises the gate rather than passing by mode.
  const blocked = await editCall(handlers, join(repo, "a.ts"), ctx);
  assert.ok(blocked && (blocked as { block?: boolean }).block === true,
    "the same session must still block ordinary edits (test is not vacuous)");
});

test("L8: the confirm path no longer asks for a reason (reject still does)", async () => {
  const repo = makeRepo();
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  await handlers.get("session_start")!({}, ctx);

  let inputs = 0;
  (ctx as { ui: { input?: (t: string, p: string) => Promise<string | undefined> } }).ui.input =
    async () => { inputs += 1; return "n/a"; };

  // Confirm path: the input box must NOT be shown.
  await approveGoal(pi, ctx, GOAL_TEXT);
  assert.equal(inputs, 0, "confirming a goal must not prompt for a reason");
  const sidecar = readSidecar(repo);
  assert.equal((sidecar.loopGoal as { reason?: string } | undefined)?.reason, undefined,
    "an approval carries no reason");

  // Reject path: the input box must still be shown and the reason recorded.
  (ctx as { ui: { confirm: (t: string, m: string) => Promise<boolean> } }).ui.confirm = async () => false;
  // The revised text is a DIFFERENT draft, so it needs its own audit before
  // the dialog can be reached at all (L8b binds to content).
  await recordPrereview(pi, ctx, GOAL_TEXT + "\n(revised)");
  const rejected = await tool(pi, "propose_loop_goal")("id", { goal: GOAL_TEXT + "\n(revised)" }, undefined, undefined, ctx);
  assert.equal((rejected as { details: { approved?: boolean } }).details.approved, false);
  assert.equal(inputs, 1, "rejecting a goal must ask for the reason");
  assert.equal((rejected as { details: { reason?: string } }).details.reason, "n/a", "the reject reason must be carried back");
});

test("L8: multi-repo — each repo checks its OWN goal; repo-scoped approval unlocks the second repo", async () => {
  // Two real git repos; the session starts in repoA. The L8 edit gate must
  // check the goal of the repo the write LANDS IN: approving A's goal does
  // not unlock B, and approving B's goal (via propose_loop_goal repo param)
  // does.
  const repoA = makeRepo();
  const repoB = makeRepo();
  const fileA = join(repoA, "a.ts");
  const fileB = join(repoB, "a.ts");
  const pi = makeMockPi(repoA);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  await handlers.get("session_start")!({}, ctx);

  // No goal anywhere: both repos block.
  const blockA = await editCall(handlers, fileA, ctx);
  assert.ok(blockA && (blockA as { block?: boolean }).block === true, "repo A edit must be blocked without a goal");
  const blockB = await editCall(handlers, fileB, ctx);
  assert.ok(blockB && (blockB as { block?: boolean }).block === true, "repo B edit must be blocked without a goal");

  // Approve ONLY repo A's goal → A unlocks, B stays blocked (per-repo!).
  await approveGoal(pi, ctx, GOAL_TEXT);
  const passA = await editCall(handlers, fileA, ctx);
  assert.equal(passA, undefined, "repo A edit must pass once A's goal is approved");
  const stillBlockB = await editCall(handlers, fileB, ctx);
  assert.ok(stillBlockB && (stillBlockB as { block?: boolean }).block === true,
    "A's approval must NOT open B's write surface (per-repo goal check)");

  // …and the same holds for a write into a NOT-YET-EXISTING nested dir of B:
  // repo attribution must climb to B's root (nearestExistingDir), not fall
  // back to the approved primary repo (round P2 — regression-pinned here).
  const newDeepFile = join(repoB, "new", "deep", "x.ts");
  const stillBlockNew = await handlers.get("tool_call")!(
    { toolName: "write", input: { path: newDeepFile } }, ctx);
  assert.ok(stillBlockNew && (stillBlockNew as { block?: boolean }).block === true,
    "A's approval must NOT open B's write surface for a new nested path either");

  // Approve B's goal with the repo param → B unlocks too. B gets a DIFFERENT
  // goal text on purpose: with identical texts a "reads the primary sidecar
  // instead of B's" mutation survives (both hashes would match), which is
  // exactly the per-repo binding this test exists to prove.
  const GOAL_TEXT_B = GOAL_TEXT + "\n\n(second repo's contract)";
  await approveGoal(pi, ctx, GOAL_TEXT_B, repoB);
  const passB = await editCall(handlers, fileB, ctx);
  assert.equal(passB, undefined, "repo B edit must pass once B's own goal is approved");
  const sidecarB = readSidecar(repoB);
  assert.equal((sidecarB.loopGoal as { hash?: string } | undefined)?.hash, goalTextHash(GOAL_TEXT_B),
    "repo B's sidecar records the hash of B's own goal text");
});

test("L8: a NESTED independent repo is not unlocked by the primary repo's goal", async () => {
  // Round P2 regression: a fast path that attributed any write under
  // primaryRepoRoot to the primary repo would let an approved primary goal
  // open a NESTED independent git repo's write surface. The per-repo binding
  // must come from the real git resolution, not a prefix check.
  const repoA = makeRepo();
  const nested = join(repoA, "nested");
  mkdirSync(nested);
  git(nested, "init", "-b", "main", ".");
  git(nested, "config", "user.email", "test@example.com");
  git(nested, "config", "user.name", "Gate Test");
  writeFileSync(join(nested, "n.ts"), "export const n = 1;\n");
  git(nested, "add", "n.ts");
  git(nested, "commit", "-m", "init");
  const fileA = join(repoA, "a.ts");
  const nestedFile = join(nested, "n.ts");
  const pi = makeMockPi(repoA);
  reviewGate(pi as never);
  const { handlers, ctx } = pi;
  await handlers.get("session_start")!({}, ctx);

  // Approve ONLY the primary repo's goal.
  await approveGoal(pi, ctx, GOAL_TEXT);
  const passA = await editCall(handlers, fileA, ctx);
  assert.equal(passA, undefined, "primary repo edit must pass once its goal is approved");

  const blockedNested = await editCall(handlers, nestedFile, ctx);
  assert.ok(blockedNested && (blockedNested as { block?: boolean }).block === true,
    "the primary goal must NOT open a nested independent repo's write surface");
});

test("L8: snapshot ship gate holds when the snapshot IS the process cwd (real reviewer child)", async () => {
  // A real reviewer subagent is a `pi` child process spawned with cwd = the
  // snapshot, so primaryRepoRoot resolves to the snapshot root — the exact
  // scenario where returning the untouched empty state for the primary repo
  // let `git push` through (round P1). The in-process mock normally keeps
  // process.cwd() OUTSIDE the snapshot, so this test chdirs into it and
  // restores afterwards.
  const repo = makeRepo();
  const snapDir = join(repo, "rg-review-snap-abc", "shard-1");
  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "b.ts"), "export const b = 2;\n");
  const prevCwd = process.cwd();
  process.chdir(snapDir);
  try {
    const pi = makeMockPi(snapDir);
    reviewGate(pi as never);
    const { handlers, ctx } = pi;
    await handlers.get("session_start")!({}, ctx);
    const push = await handlers.get("tool_call")!(
      { toolName: "bash", input: { command: "git push origin main" } }, ctx);
    assert.ok(push && (push as { block?: boolean }).block === true,
      "the bash ship gate must hold even when the snapshot is the process cwd");
  } finally {
    process.chdir(prevCwd);
  }
});

test("L8: propose_loop_goal refuses a NON-repo repo param and shows the binding repo at consent", async () => {
  const repo = makeRepo();
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const { ctx } = pi;
  await (pi.handlers.get("session_start")!({}, ctx));

  // A non-repo directory must be refused, not silently recorded. Use an
  // EXISTING dir OUTSIDE any git repo (not a nonexistent path — that
  // exercises a different branch: unresolvable vs resolvable-but-not-a-repo).
  const notARepo = mkdtempSync(join(dirname(repo), "rg-norepo-"));
  dirs.push(notARepo);
  const refused = await tool(pi, "propose_loop_goal")("id", { goal: GOAL_TEXT, repo: notARepo }, undefined, undefined, ctx);
  assert.equal((refused as { isError?: boolean }).isError, true, "a non-repo repo param must be refused");
  assert.equal((refused as { details: { approved?: boolean } }).details.approved, false);
  // Assert the REASON, not just the shape: L8b's pre-review refusal returns the
  // same isError/approved:false envelope, so a shape-only assertion would stay
  // green even if the repo guard were deleted entirely.
  assert.match(
    JSON.stringify(refused),
    /not inside a readable git repository/,
    "the refusal must be the REPO guard, not the pre-review guard standing in for it",
  );

  // The consent dialog must name the binding repo (repo-scoped approval).
  let dialogText = "";
  (ctx as { ui: { confirm: (t: string, m: string) => Promise<boolean> } }).ui.confirm = async (_t, m) => {
    dialogText = m;
    return true;
  };
  const repoB = makeRepo();
  await recordPrereview(pi, ctx, GOAL_TEXT, repoB);
  await tool(pi, "propose_loop_goal")("id", { goal: GOAL_TEXT, repo: repoB }, undefined, undefined, ctx);
  assert.match(dialogText, new RegExp(repoB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the consent dialog must name the repo the goal binds to");
});
