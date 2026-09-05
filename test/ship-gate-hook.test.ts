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
 * Scope: the pure decisions (`sensitiveEditBlock`,
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
  type ShipGateHookDeps,
} from "../lib/ship-gate-hook.ts";
import { sensitiveEditBlock } from "../lib/ship-gate-edit-guard.ts";
import {
  buildShipBlockReason,
  describeShips,
  detectHandRolledWaitPolling,
} from "../lib/ship-gate-bash.ts";

import { defaultProjectConfig } from "../lib/project-config.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import { DEFAULT_MAX_ROUNDS } from "../lib/constants.ts";
import type { TaskMode } from "../lib/task-mode.ts";
import { git, neutraliseHostGitConfig } from "./helpers/git.ts";


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
    hint: (message) => { calls.push(`hint:${message.slice(0, 24)}`); },

    isEditTool: (t) => t === "edit" || t === "write",
    isJudgeSession: () => false,
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
    // No delivery contract by default: every test written before stations
    // existed must keep measuring exactly what it measured then.
    deliveryStation: () => undefined,

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

test("a judge session is refused outward tools before either arm", async () => {
  const r = makeDeps({ isJudgeSession: () => true });
  for (const toolName of ["judge_submit", "judge_spawn", "orchestrator_spawn", "propose_loop_goal", "declare_done", "set_gate_mode"]) {
    const out = await evaluateToolCall(r.deps, { toolName, input: {} }, {});
    assert.equal(out?.block, true, `${toolName} must not run in a judge pane`);
    assert.match(out!.reason, /review 会话里不可用/);
  }
  const ask = await evaluateToolCall(r.deps, { toolName: "ask_user", input: {} }, {});
  assert.equal(ask, undefined, "ask_user stays available — questions race through the channel");
  const plain = makeDeps();
  const normal = await evaluateToolCall(plain.deps, { toolName: "judge_submit", input: {} }, {});
  assert.equal(normal, undefined, "outside a judge pane the same tool passes the hook");
});

// ---------------------------------------------------------------------------
// The hand-rolled WAIT hint (D6, 2026-09-05). It HINTS and never blocks: the
// command shape it recognises — a long sleep next to a read of the gate's own
// channel or findings stream — is exactly what a session reached for when
// `judge_wait` was off the agent surface, and it cost nine minutes because a
// turn that never ends never settles, so the wake-up never fires.

test("the polling detector needs BOTH a long sleep and a channel/stream read", () => {
  const hit = detectHandRolledWaitPolling(
    "for i in 1 2 3; do sleep 60; cat /home/u/.pi/rg-channels/orch/child.jsonl; done",
  );
  assert.ok(hit, "a loop that sleeps and reads the channel is the shape");
  assert.match(hit!.reason, /judge_wait/, "the hint names the tool that does this right");
  assert.match(hit!.reason, /不拦截/, "…and says out loud that it is not a block");

  assert.equal(
    detectHandRolledWaitPolling("sleep 300"),
    undefined,
    "a long sleep alone is somebody's own business",
  );
  assert.equal(
    detectHandRolledWaitPolling("cat .pi/review-stream/r.jsonl"),
    undefined,
    "reading the stream once is a diagnostic, not a wait",
  );
  assert.equal(
    detectHandRolledWaitPolling("sleep 2 && cat .pi/review-stream/r.jsonl"),
    undefined,
    "a two-second pause is not a wait",
  );
  assert.ok(
    detectHandRolledWaitPolling("sleep 280; grep P0 .pi/review-stream/review-x.jsonl"),
    "the measured shape (sleep 280 + grep the stream) is recognised",
  );
  // `sleep` takes a suffix on both GNU and BSD, and `sleep 5m` is the loudest
  // version of this shape — reading its argument as a bare number would miss it.
  assert.ok(
    detectHandRolledWaitPolling("sleep 5m && tail .pi/review-stream/r.jsonl"),
    "a suffixed duration is still a duration",
  );
  assert.equal(
    detectHandRolledWaitPolling("sleep 5s && tail .pi/review-stream/r.jsonl"),
    undefined,
    "…and five seconds is still not a wait",
  );
});


test("the hint is delivered through the hook and the command still runs", async () => {
  const r = makeDeps();
  const out = await evaluateToolCall(
    r.deps,
    { toolName: "bash", input: { command: "sleep 120; cat .pi/review-stream/r.jsonl" } },
    {},
  );
  assert.equal(out, undefined, "a hint must never block the command");
  assert.ok(r.calls.some((c) => c.startsWith("hint:")), "…and the agent is told there is a tool");

  const quiet = makeDeps();
  await evaluateToolCall(quiet.deps, { toolName: "bash", input: { command: "npm test" } }, {});
  assert.ok(!quiet.calls.some((c) => c.startsWith("hint:")), "an ordinary command says nothing");
});

// ---------------------------------------------------------------------------
// THE DELIVERY STATION (2026-09-06). Where this round stops is a contract, not
// a quality gate: these tests hold the two apart. Every case below starts from
// a state where the quality gates are FULLY satisfied, so whatever blocks can
// only be the station — and the two tests at the end prove the reverse, that
// the station never makes an unmet gate pass.

/** A sidecar whose review and precommit both pass for fingerprint "t". */
function shippableState(): GateState {
  return {
    ...emptyState("s1", DEFAULT_MAX_ROUNDS),
    hasCodeChange: true,
    review: { verdict: "READY", fingerprint: "t", at: "2026-09-06T00:00:00.000Z", docSync: "NOT_NEEDED" },
    precommit: { verdict: "PASS", fingerprint: "t", at: "2026-09-06T00:00:00.000Z", testScope: "full" },
  };
}

const COMMIT_CMD = "git commit -m 'feat: x'";
const PUSH_CMD = "git push origin work";
const PR_CMD = "gh pr create --title 'feat: x' --body 'why'";

async function shipAt(station: "precommit" | "commit" | "pr" | undefined, command: string, over: Partial<ShipGateHookDeps> = {}) {
  const base = defaultProjectConfig();
  const r = makeDeps({
    enforcementStateFor: () => shippableState(),
    stateForRepo: () => shippableState(),
    deliveryStation: () => station,
    // The semantic guards are a different subject and would need a classifier;
    // the commit/PR texts here are plain English either way.
    projectConfig: () => ({ ...base, llmGuards: { ...base.llmGuards, aiAttribution: false, englishCheck: false, shipDetect: false } }),
    ...over,
  });

  return { r, out: await evaluateToolCall(r.deps, bashCall(command), {}) };
}

test("station `precommit`: every ship command is refused even with the gates green", async () => {
  for (const command of [COMMIT_CMD, PUSH_CMD, PR_CMD]) {
    const { out } = await shipAt("precommit", command);
    assert.equal(out?.block, true, `${command} must not run at precommit`);
    assert.match(out!.reason, /超出本轮交付站点 precommit/);
    assert.match(out!.reason, /不放行任何 ship 命令/, "the refusal says what the station DOES allow");
  }
});

test("station `commit`: the commit goes through, publishing does not", async () => {
  const committed = await shipAt("commit", COMMIT_CMD);
  assert.equal(committed.out, undefined, "a commit is exactly what this station promised");

  for (const command of [PUSH_CMD, PR_CMD]) {
    const { out } = await shipAt("commit", command);
    assert.equal(out?.block, true, `${command} travels past the commit station`);
    assert.match(out!.reason, /超出本轮交付站点 commit/);
    assert.match(out!.reason, /`git commit`/, "…and names the one command this station allows");
  }
});

test("station `pr`: commit, push and pr-create all pass", async () => {
  for (const command of [COMMIT_CMD, PUSH_CMD, PR_CMD]) {
    const { out } = await shipAt("pr", command);
    assert.equal(out, undefined, `${command} is inside the pr station`);
  }
});

test("a session with NO delivery contract keeps its pre-station behaviour", async () => {
  // explore / normal, and a loop repo whose goal was never approved: the dep
  // answers `undefined`, which must not be read as the strictest station.
  for (const command of [COMMIT_CMD, PUSH_CMD, PR_CMD]) {
    const { out } = await shipAt(undefined, command);
    assert.equal(out, undefined, `${command} must be unaffected when no station applies`);
  }
});

test("the station refusal is self-rescuing: it names the legal routes and offers no dead-end appeal", async () => {
  const { out } = await shipAt("precommit", PUSH_CMD);
  assert.match(out!.reason, /propose_restatement/, "a loop session is told how the station moves");
  assert.match(out!.reason, /deliveryStation/, "…and an orchestration child is told the plan route");
  assert.doesNotMatch(
    out!.reason,
    /request_arbitration/,
    "the arbiter only hears a lone `gh pr edit`, so pointing a push at it would be a dead end that also burns an appeal",
  );
  assert.doesNotMatch(
    out!.reason,
    /judge_submit/,
    "running another review round cannot clear a station — saying so would be a loop with no exit",
  );
});

test("the station never relaxes a quality gate, and a station block still lists the unmet ones", async () => {
  // Gates unmet AND the station allows the command: the original block stands.
  const unmet = makeDeps({
    enforcementStateFor: () => ({ ...emptyState("s1", DEFAULT_MAX_ROUNDS), hasCodeChange: true }),
    deliveryStation: () => "pr",
  });
  const stillBlocked = await evaluateToolCall(unmet.deps, bashCall(PUSH_CMD), {});
  assert.equal(stillBlocked?.block, true, "a permissive station is not an authorization");
  assert.match(stillBlocked!.reason, /code review gate is PENDING/);

  // Gates unmet AND the station refuses: BOTH problems are reported, with
  // both next steps — the two are cleared in completely different ways.
  const both = makeDeps({
    enforcementStateFor: () => ({ ...emptyState("s1", DEFAULT_MAX_ROUNDS), hasCodeChange: true }),
    deliveryStation: () => "precommit",
  });
  const out = await evaluateToolCall(both.deps, bashCall(PUSH_CMD), {});
  assert.match(out!.reason, /code review gate is PENDING/, "the quality problem survives");
  assert.match(out!.reason, /超出本轮交付站点 precommit/, "…next to the station problem");
  assert.match(out!.reason, /judge_submit/, "…and the review loop is still named for the quality half");
});

test("a message-only `--amend` is exempt from the station, in a REAL repo", async () => {
  // Same exemption the content gates make: an amend publishes the tree it
  // replaces, so it travels no further than the commit that already exists.
  // Blocking it would leave a bad commit message unfixable at `precommit`.
  //
  // A real worktree, because the exemption also requires the ship command to
  // resolve unambiguously to a repo — which is a `git` measurement, not
  // something a fake dep can answer.
  neutraliseHostGitConfig();
  const dir = mkdtempSync(join(tmpdir(), "rg-station-"));
  try {
    git(dir, ["init", "-q", "-b", "work"]);
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "chore: first"]);
    const base = defaultProjectConfig();
    const r = makeDeps({
      enforcementStateFor: () => shippableState(),
      stateForRepo: () => shippableState(),
      deliveryStation: () => "precommit",
      worktreeTree: () => "same-tree",
      headCommitTree: () => "same-tree",
      hasStagedChanges: () => false,
      projectConfig: () => ({ ...base, llmGuards: { ...base.llmGuards, aiAttribution: false, englishCheck: false, shipDetect: false } }),
    }, dir);
    const out = await evaluateToolCall(r.deps, bashCall("git commit --amend -m 'fix: better subject'"), {});
    assert.equal(out, undefined, "a reword must not be trapped by the station");

    // …while a REAL commit in the same repo is still refused by the station.
    const real = await evaluateToolCall(r.deps, bashCall(COMMIT_CMD), {});
    assert.equal(real?.block, true, "the exemption is the amend, not the repo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("no tracked change ⇒ no station check either (the gate has nothing of this round to hold back)", async () => {
  const r = makeDeps({
    enforcementStateFor: () => emptyState("s1", DEFAULT_MAX_ROUNDS),
    deliveryStation: () => "precommit",
  });
  assert.equal(await evaluateToolCall(r.deps, bashCall(COMMIT_CMD), {}), undefined);
});

test("buildShipBlockReason keeps the station and the quality halves distinguishable", () => {
  const stationOnly = buildShipBlockReason({
    command: "git push",
    ships: [{ kind: "push" }],
    problems: [],
    stationProblems: ["`git push` 超出本轮交付站点 commit（…）——该站点放行的 ship 命令：`git commit`"],
    crossRepoHint: "",
  });
  assert.match(stationOnly.recorded, /beyond this round's delivery station/,
    "a station-only block must not be recorded as unmet quality");
  assert.doesNotMatch(stationOnly.shown, /judge_submit/);

  const mixed = buildShipBlockReason({
    command: "git push",
    ships: [{ kind: "push" }],
    problems: ["precommit has not run"],
    stationProblems: ["`git push` 超出本轮交付站点 commit"],
    crossRepoHint: "",
  });
  assert.match(mixed.recorded, /quality gates unmet/);
  assert.match(mixed.recorded, /precommit has not run/);
  assert.match(mixed.shown, /judge_submit/, "the quality half still points at the loop");
});

