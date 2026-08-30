/**
 * Unit tests for the L1 `tool_call` hook, now that it is a module rather than
 * a closure inside `extensions/review-gate.ts`.
 *
 * That is the whole point of the move: every branch below used to be reachable
 * only by loading the extension into a fake pi and driving it through a real
 * worktree, so in practice none of them was covered directly — the structural
 * test in test/extension-structure.test.ts pinned the SHAPE of the code and
 * nothing ran it. Here the decisions run, with three-line fakes for the seams.
 *
 * Scope: the pure decisions (`sensitiveEditBlock`, `judgeSubagentBlock`,
 * `describeShips`, `buildShipBlockReason`) plus the two
 * arms' ORDER — the orderings the gate's safety rests on (security floor
 * before the normal-mode return, gate-owned exemption before the L8 goal gate,
 * tmux backstop before `/gate-bypass`, `/gate-bypass` before ship detection).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateToolCall,
  judgeSubagentBlock,
  type ShipGateHookDeps,
} from "../lib/ship-gate-hook.ts";
import { sensitiveEditBlock } from "../lib/ship-gate-edit-guard.ts";
import { buildShipBlockReason, describeShips } from "../lib/ship-gate-bash.ts";
import { defaultProjectConfig } from "../lib/project-config.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import { DEFAULT_MAX_ROUNDS } from "../lib/constants.ts";
import type { TaskMode } from "../lib/task-mode.ts";

// ---------------------------------------------------------------------------
// A recording deps object: every seam answers a default, and each test
// overrides only what it is about.

interface Recorder {
  calls: string[];
  deps: ShipGateHookDeps;
  state: GateState;
}

function makeDeps(over: Partial<ShipGateHookDeps> & { taskMode?: () => TaskMode | undefined } = {}, cwd = "/repo"): Recorder {
  const calls: string[] = [];
  const state = emptyState("s1", DEFAULT_MAX_ROUNDS);
  const base: ShipGateHookDeps = {
    noteContext: () => { calls.push("noteContext"); },
    isEditTool: (t) => t === "edit" || t === "write",
    cwd: () => cwd,
    primaryRepoRoot: () => cwd,
    taskMode: () => "loop",
    relayHandoffPath: () => undefined,
    sensitiveGrants: () => [],
    sensitiveDeclined: () => false,
    nearestExistingDir: (p) => p,
    loopGoalEditBlockFor: () => undefined,
    checkTestLabels: async () => { calls.push("checkTestLabels"); return undefined; },
    markSessionEdited: () => { calls.push("markSessionEdited"); },
    bypassActive: () => false,
    projectConfig: () => defaultProjectConfig(),
    sessionRepos: () => [cwd],
    knownRepoRoots: () => [cwd],
    enforcementStateFor: () => undefined,
    stateForRepo: () => state,
    repoLabel: (r) => r.split("/").pop() ?? r,
    currentBranch: () => "work",
    worktreeTree: () => "t",
    headCommitTree: () => "t",
    hasStagedChanges: () => false,
    unreviewedTreesSince: () => undefined,
    loopGoalConfirmed: () => true,
    crossRepoVerdictHint: () => "",
    classifier: () => { throw new Error("no classifier in tests"); },
    notice: () => undefined,
    refuseText: (_k, _t, message) => { calls.push("refuseText"); return message; },
    appendLesson: (t) => { calls.push(`lesson:${t.slice(0, 24)}`); },
    bypassToken: () => null,
    setBypassToken: () => { calls.push("setBypassToken"); },
    clearBypassToken: () => { calls.push("clearBypassToken"); },
    computeTokenBindings: async () => { throw new Error("unused"); },
    setLastBlockedShip: () => { calls.push("setLastBlockedShip"); },
  };
  return { calls, state, deps: { ...base, ...over } as ShipGateHookDeps };
}

const editCall = (path: string) => ({ toolName: "edit", input: { path, newText: "x" } });
const bashCall = (command: string) => ({ toolName: "bash", input: { command } });

// ---------------------------------------------------------------------------
// The sensitive-file security floor.

test("sensitiveEditBlock names the path the agent typed, and offers the dialog when the path is askable", () => {
  const block = sensitiveEditBlock({ rawPath: "app/.env", askable: true });
  assert.equal(block.block, true);
  assert.match(block.reason, /"app\/\.env" matches a sensitive-file pattern/);
  assert.match(block.reason, /request_sensitive_edit/,
    "an askable path must point at the one-time authorization dialog");
});

test("sensitiveEditBlock withholds the dialog route for a path that cannot be authorized", () => {
  const block = sensitiveEditBlock({ rawPath: ".git/hooks/pre-commit", askable: false });
  assert.doesNotMatch(block.reason, /request_sensitive_edit/,
    "a .git internal (or a declined path) must never be presented as authorizable");
  assert.match(block.reason, /cannot be authorized from here/);
});

test("the edit arm refuses a sensitive path and never reaches the L6 label check", async () => {
  const r = makeDeps();
  const out = await evaluateToolCall(r.deps, editCall(".env"), {});
  assert.equal(out?.block, true);
  assert.match(out!.reason, /matches a sensitive-file pattern/);
  assert.ok(!r.calls.includes("checkTestLabels"), "a refused edit pays no LLM call");
  assert.ok(!r.calls.includes("markSessionEdited"), "a refused edit is not this session's work");
});

test("the sensitive floor holds in NORMAL mode — the mode that skips every workflow check", async () => {
  // This is the ordering test/extension-structure.test.ts pins structurally,
  // executed: normal mode returns early, and the guard has to be above it.
  const r = makeDeps({ taskMode: () => "normal" });
  const out = await evaluateToolCall(r.deps, editCall("secrets.json"), {});
  assert.equal(out?.block, true, "normal mode must not disarm the security floor");
  // …while an ordinary edit in normal mode passes untouched.
  const plain = await evaluateToolCall(r.deps, editCall("src/a.ts"), {});
  assert.equal(plain, undefined);
  assert.ok(!r.calls.includes("markSessionEdited"), "normal-mode edits are not session work");
});

test("a normalized path cannot dodge the pattern: `a/../.env` and `.pi/./precommit-cache.json`", async () => {
  for (const spelling of ["a/../.env", ".pi/./precommit-cache.json", "./x/../.env"]) {
    const r = makeDeps();
    const out = await evaluateToolCall(r.deps, editCall(spelling), {});
    assert.equal(out?.block, true, `${spelling} must be matched after resolve()`);
  }
});

test("a live grant lets the edit through, and the arm never consumes it", async () => {
  const r = makeDeps({
    sensitiveGrants: () => [{
      path: "/repo/.env",
      at: new Date().toISOString(),
      expiresAt: Date.now() + 60_000,
      reason: "user said so",
    }],
  });
  const out = await evaluateToolCall(r.deps, editCall(".env"), {});
  assert.equal(out, undefined, "a granted path passes");
  assert.ok(r.calls.includes("markSessionEdited"), "…and counts as this session's work");
});

// ---------------------------------------------------------------------------
// The rest of the edit arm's order.

test("a gate-owned write is exempt BEFORE the L8 goal gate (or the gate deadlocks on its own files)", async () => {
  let goalGateAsked = false;
  const r = makeDeps({
    loopGoalEditBlockFor: () => {
      goalGateAsked = true;
      return { block: true, reason: "no goal" };
    },
  });
  const out = await evaluateToolCall(r.deps, editCall(".pi/loop-goal.md"), {});
  assert.equal(out, undefined, "the gate must be able to write its own goal file");
  assert.equal(goalGateAsked, false, "the exemption must return before the goal gate is consulted");
  assert.ok(!r.calls.includes("markSessionEdited"),
    "a gate-owned write is invisible to review, so it is not session work either");
});

test("the L8 goal block wins over the L6 label check — a blocked write pays no LLM call", async () => {
  const r = makeDeps({ loopGoalEditBlockFor: () => ({ block: true, reason: "negotiate the goal first" }) });
  const out = await evaluateToolCall(r.deps, editCall("test/a.test.ts"), {});
  assert.equal(out?.reason, "negotiate the goal first");
  assert.ok(!r.calls.includes("checkTestLabels"));
});

test("an L6 label problem blocks the edit; a clean one lets it through and records the work", async () => {
  const bad = makeDeps({ checkTestLabels: async () => "label is not English" });
  assert.deepEqual(await evaluateToolCall(bad.deps, editCall("test/a.test.ts"), {}),
    { block: true, reason: "label is not English" });
  assert.ok(!bad.calls.includes("markSessionEdited"));

  const good = makeDeps();
  assert.equal(await evaluateToolCall(good.deps, editCall("test/a.test.ts"), {}), undefined);
  assert.ok(good.calls.includes("markSessionEdited"));
});

test("orchestrator mode refuses a code write, and the refusal comes AFTER the goal gate", async () => {
  const r = makeDeps({ taskMode: () => "orchestrator" });
  const out = await evaluateToolCall(r.deps, editCall("lib/a.ts"), {});
  assert.equal(out?.block, true, "an orchestrator delegates code, it does not write it");
  // The goal gate is checked first, so its refusal is the one the author sees.
  const goalFirst = makeDeps({
    taskMode: () => "orchestrator",
    loopGoalEditBlockFor: () => ({ block: true, reason: "goal first" }),
  });
  assert.equal((await evaluateToolCall(goalFirst.deps, editCall("lib/a.ts"), {}))?.reason, "goal first");
});

test("every tool_call refreshes the extension's context — including the ones that pass", async () => {
  const r = makeDeps();
  await evaluateToolCall(r.deps, { toolName: "read", input: { path: "a.ts" } }, {});
  assert.deepEqual(r.calls, ["noteContext"]);
});

// ---------------------------------------------------------------------------
// The judge-role subagent block.

test("the block recognizes a judge role in every spelling a dispatch can carry", () => {
  // Through `judgeSubagentBlock`, not the predicate directly: the predicate is
  // lib/judge-prompt.ts's `isJudgeAgentName` (covered in its own test), and what
  // matters here is that the L1 block asks it with the raw `agent` value —
  // trimming, casing, a path and a `.md` suffix all have to survive the trip.
  const named = (agentName: string) => judgeSubagentBlock({
    agentName,
    script: undefined,
    scriptPath: undefined,
    readScript: () => undefined,
  });
  for (const spelling of [
    "reviewer", "Reviewer", " adviser ", "goal-auditor",
    "agents/reviewer.md", "reviewer-readonly", "/abs/path/adviser.MD",
  ]) {
    assert.equal(named(spelling)?.block, true, spelling);
  }
  for (const other of ["recon", "fixer", "reviewer2", "my-reviewer", ""]) {
    assert.equal(named(other), undefined, other);
  }
});

test("judgeSubagentBlock refuses a judge named at the top level, and points at judge_submit", () => {
  const block = judgeSubagentBlock({
    agentName: "reviewer",
    script: undefined,
    scriptPath: undefined,
    readScript: () => undefined,
  });
  assert.equal(block?.block, true);
  assert.match(block!.reason, /`reviewer` is a judge role/);
  assert.match(block!.reason, /judge_submit\(\{role, task\}\)/);
});

test("judgeSubagentBlock scans an INLINE workflowScript for a judge role", () => {
  const block = judgeSubagentBlock({
    agentName: "",
    script: 'await runs.run("a", { agent: "adviser", task: "x" });',
    scriptPath: undefined,
    readScript: () => { throw new Error("must not read a file when the script is inline"); },
  });
  assert.equal(block?.block, true, "a judge role inside the script body is the same dispatch");
});

test("judgeSubagentBlock reads a workflowScriptPath, and FAILS CLOSED when it cannot", () => {
  const clean = judgeSubagentBlock({
    agentName: "",
    script: undefined,
    scriptPath: "flows/ok.js",
    readScript: () => 'runs.run("a", { agent: "fixer" })',
  });
  assert.equal(clean, undefined, "a readable, judge-free script passes");

  const named = judgeSubagentBlock({
    agentName: "",
    script: undefined,
    scriptPath: "flows/bad.js",
    readScript: () => 'runs.run("a", { agent: "goal-auditor" })',
  });
  assert.equal(named?.block, true);

  const unreadable = judgeSubagentBlock({
    agentName: "",
    script: undefined,
    scriptPath: "flows/missing.js",
    readScript: () => undefined,
  });
  assert.equal(unreadable?.block, true,
    "an unreadable script could hide a judge role — no information must not mean pass");
  assert.match(unreadable!.reason, /failing closed/);
});

test("a plain subagent call is untouched, and the whole scan is skipped for other tools", async () => {
  const r = makeDeps();
  assert.equal(await evaluateToolCall(r.deps, { toolName: "subagent", input: { agent: "recon" } }, {}), undefined);
  assert.equal(await evaluateToolCall(r.deps, { toolName: "subagent", input: {} }, {}), undefined);
});

test("the hook reads a workflowScriptPath relative to the session cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-ship-hook-"));
  try {
    mkdirSync(join(dir, "flows"), { recursive: true });
    writeFileSync(join(dir, "flows", "f.js"), 'runs.run("a", { agent: "reviewer" })', "utf8");
    const r = makeDeps({}, dir);
    const out = await evaluateToolCall(
      r.deps,
      { toolName: "subagent", input: { workflowScriptPath: "flows/f.js" } },
      {},
    );
    assert.equal(out?.block, true, "the relative path must resolve against the session cwd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The bash arm: the ship gate's own order.

test("normal mode steps aside before the tmux backstop and before ship detection", async () => {
  const r = makeDeps({ taskMode: () => "normal" });
  assert.equal(await evaluateToolCall(r.deps, bashCall("tmux kill-server"), {}), undefined);
  assert.equal(await evaluateToolCall(r.deps, bashCall("git commit -m 'x'"), {}), undefined);
});

test("the tmux backstop sits ABOVE /gate-bypass — a bypass is not a licence to destroy tmux", async () => {
  const bypassed = makeDeps({ bypassActive: () => true });
  const out = await evaluateToolCall(bypassed.deps, bashCall("tmux kill-server"), {});
  assert.equal(out?.block, true, "a bypassed session still may not kill the user's tmux server");
});

test("/gate-bypass disarms the SHIP gate, and does so before any ship detection", async () => {
  const armed: GateState = { ...emptyState("s1", DEFAULT_MAX_ROUNDS), hasCodeChange: true };
  const deps = makeDeps({
    bypassActive: () => true,
    enforcementStateFor: () => armed,
  });
  assert.equal(await evaluateToolCall(deps.deps, bashCall("git commit -m 'feat: x'"), {}), undefined);
  assert.ok(!deps.calls.includes("setLastBlockedShip"), "a bypassed ship is not a recorded block");
});

test("a repo with no tracked change and no sidecar work is not a gate to enforce", async () => {
  const r = makeDeps({ enforcementStateFor: () => emptyState("s1", DEFAULT_MAX_ROUNDS) });
  assert.equal(await evaluateToolCall(r.deps, bashCall("git commit -m 'feat: x'"), {}), undefined);
});

test("an ordinary command never pays for repo resolution", async () => {
  const r = makeDeps({
    enforcementStateFor: () => { throw new Error("must not resolve repos for a plain command"); },
  });
  assert.equal(await evaluateToolCall(r.deps, bashCall("ls -la"), {}), undefined);
  assert.equal(await evaluateToolCall(r.deps, { toolName: "bash", input: {} }, {}), undefined);
});

// ---------------------------------------------------------------------------
// The block text.

test("describeShips names a compound command by every operation in it", () => {
  assert.equal(describeShips("git push", [{ kind: "push" }]), "push");
  assert.equal(
    describeShips("git commit && git push", [{ kind: "commit" }, { kind: "push" }]),
    "compound command with commit + push",
  );
});

test("a single ship block lists its problems and names ONE next step", () => {
  const { recorded, shown } = buildShipBlockReason({
    command: "git push",
    ships: [{ kind: "push" }],
    problems: ["code review gate is PENDING (need READY)", "precommit has not run"],
    crossRepoHint: "",
  });
  assert.match(recorded, /^review-gate: push blocked — quality gates unmet:\n/);
  assert.match(recorded, /\n {2}- code review gate is PENDING \(need READY\)\n {2}- precommit has not run$/);
  assert.doesNotMatch(recorded, /judge_submit/, "the RECORDED text is what the arbiter reads");
  assert.match(shown, /judge_submit → declare_done/);
  assert.doesNotMatch(shown, /request_arbitration/,
    "a push is not arbitrable — offering the appeal would be a dead end");
});

test("a compound ship block warns about the compound, and carries the cross-repo hint", () => {
  const { recorded } = buildShipBlockReason({
    command: "git commit && git push",
    ships: [{ kind: "commit" }, { kind: "push" }],
    problems: ["[api] precommit has not run"],
    crossRepoHint: "\n(your READY is on another repo)",
  });
  assert.match(recorded, /compound command with commit \+ push blocked/);
  assert.match(recorded, /Compound ship commands are unsafe/);
  assert.match(recorded, /\(your READY is on another repo\)$/,
    "the hint is part of the RECORDED text, so the arbiter reads what the agent read");
});

test("a lone gh pr edit is the ONLY block that mentions arbitration", () => {
  const lone = buildShipBlockReason({
    command: "gh pr edit --title x",
    ships: [{ kind: "pr-edit" }],
    problems: ["code review gate is PENDING (need READY)"],
    crossRepoHint: "",
  });
  assert.match(lone.shown, /request_arbitration/);
  const withCommit = buildShipBlockReason({
    command: "git commit && gh pr edit --title x",
    ships: [{ kind: "commit" }, { kind: "pr-edit" }],
    problems: ["code review gate is PENDING (need READY)"],
    crossRepoHint: "",
  });
  assert.doesNotMatch(withCommit.shown, /request_arbitration/,
    "a compound command is judged by its strictest segment, arbitration included");
});
