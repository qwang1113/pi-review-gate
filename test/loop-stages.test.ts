/**
 * THE FIVE STAGE SWITCHES (2026-09-22, lib/loop-stages.ts).
 *
 * Three layers are covered, and they are the three that decide whether the
 * feature actually releases anything:
 *
 *  1. the module's own rules — defaults, the record's validator, the ONE
 *     `stageOpen`, the dialog's spec and every outcome it can produce;
 *  2. the SHARED ship authority (`lib/gate-state-requirements.ts`'s `unmetRequirements`)
 *     with each switch off in turn, which is also what the L3 git hook reads —
 *     and the REAL hook checker (`scripts/pre-commit-check.cjs`) driven
 *     in-process with real exit codes;
 *  3. the extension's WIRING — the four places a pure module cannot reach
 *     (the goal edit gate, the acceptance composition, the judge routing and
 *     the tool registration), pinned as text because a wrong wiring there is
 *     exactly a checkpoint that stays blocked after the user released it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  LOOP_STAGES,
  LOOP_STAGES_BODY,
  STAGE_LABELS,
  STAGE_OFF_CONSEQUENCES,
  allStagesOn,
  buildStagesDirective,
  chooseLoopStages,
  ensureLoopStages,
  formatStagesOutcome,
  loopStagesSpec,
  sanitizeLoopStages,
  stageOpen,
  stagesOff,
  stagesOffered,
  stagesSummary,
  type LoopStage,
  type LoopStagesDeps,
  type LoopStagesRecord,
} from "../lib/loop-stages.ts";
import { MULTI_UNAVAILABLE } from "../lib/multi-choice-dialog.ts";
import { doProposeRestatement, type RestatementToolDeps } from "../lib/restatement.ts";
import { doProposeLoopGoal, type GoalToolDeps } from "../lib/goal-tools.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import { unmetRequirements } from "../lib/gate-state-requirements.ts";
import { acceptanceDecision, acceptanceGateOpen } from "../lib/acceptance-round.ts";
import { readyLacksVerification } from "../lib/review-adjudicate.ts";
import { buildGateWidget } from "../lib/ui-widget.ts";
import { makeGitRepo, writeState, readyState } from "./helpers/hook-fixtures.ts";
import { neutraliseHostGitConfig } from "./helpers/git.ts";

// The hook fixtures shell out to git; the hermetic-git guard requires this
// call to appear in THIS file's code (not only in the shared fixtures).
neutraliseHostGitConfig();

const requireCjs = createRequire(import.meta.url);
const { runCheck, runWithExit } = requireCjs("../scripts/pre-commit-check.cjs") as {
  runCheck: (statePath: string, repo: string, env?: Record<string, string>) => void;
  runWithExit: <T>(fn: () => T) => number;
};

/** Run the REAL L3 checker in-process; returns its exit code. */
function check(dir: string): number {
  return runWithExit(() =>
    runCheck(join(dir, ".pi", "review-gate-state.json"), dir, { ...process.env, HOME: "/tmp/rg-stages-home" }));
}

/** A record with the named stages off and everything else on. */
function stagesWith(off: LoopStage[] = [], at = "2026-09-22T00:00:00.000Z"): LoopStagesRecord {
  const record = sanitizeLoopStages({ stages: { ...allStagesOn(), ...Object.fromEntries(off.map((s) => [s, false])) }, at });
  assert.ok(record, "the fixture record must be well-formed");
  return record;
}

/** This module's own source — the "one copy" drift guard reads it. */
const MODULE_SRC = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "lib", "loop-stages.ts"), "utf8");

/** Escape a literal for use inside a RegExp. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A code-change state whose gates are all unmet (the strictest baseline). */
function unmetCodeState(): GateState {
  const st = emptyState("test-session", 10);
  st.hasCodeChange = true;
  st.hasDocChange = false;
  st.review = { verdict: "PENDING", fingerprint: null, at: null };
  st.precommit = { verdict: "NOT_RUN", fingerprint: null, at: null };
  return st;
}

// ---------------------------------------------------------------------------
// 1. The module's own rules
// ---------------------------------------------------------------------------

test("no record = every stage ON (today's behaviour), and the summary says so", () => {
  for (const stage of LOOP_STAGES) {
    assert.equal(stageOpen(undefined, stage), true, `${stage} defaults ON`);
  }
  assert.deepEqual(stagesOff(undefined), []);
  assert.equal(stagesSummary(undefined), "全部开启（默认）");
});

test("a well-formed record round-trips; nothing else does", () => {
  const record = stagesWith(["review", "precommit"]);
  assert.deepEqual(sanitizeLoopStages(record), record, "a record written by the gate is readable back");
  assert.deepEqual(stagesOff(record), ["review", "precommit"]);
  assert.equal(stagesSummary(record), "已关闭 review、precommit");

  // A partial or type-broken record is DROPPED (⇒ defaults, all on): a record
  // can only ever release a gate, so guessing at one is the unsafe direction.
  assert.equal(sanitizeLoopStages({ stages: { review: false }, at: "t" }), undefined);
  assert.equal(sanitizeLoopStages({ stages: { ...allStagesOn(), review: "no" }, at: "t" }), undefined);
  assert.equal(sanitizeLoopStages({ stages: allStagesOn() }), undefined, "a missing timestamp is not a record");
  assert.equal(sanitizeLoopStages({ stages: [1, 2], at: "t" }), undefined);
  assert.equal(sanitizeLoopStages("nope"), undefined);
  assert.equal(sanitizeLoopStages(undefined), undefined);
});

test("the switches are INDEPENDENT — one off never moves another", () => {
  for (const off of LOOP_STAGES) {
    const record = stagesWith([off]);
    for (const stage of LOOP_STAGES) {
      assert.equal(stageOpen(record, stage), stage !== off, `${stage} under ${off} off`);
    }
  }
  // Every combination: the power set, driven through the one query.
  const subsets = 1 << LOOP_STAGES.length;
  for (let mask = 0; mask < subsets; mask++) {
    const off = LOOP_STAGES.filter((_, i) => (mask & (1 << i)) !== 0);
    const record = stagesWith(off);
    for (const stage of LOOP_STAGES) {
      assert.equal(stageOpen(record, stage), !off.includes(stage));
    }
  }
});

test("the dialog offers all five, all ticked, and each label is a legal option", () => {
  const spec = loopStagesSpec();
  assert.equal(spec.options.length, LOOP_STAGES.length);
  assert.deepEqual(spec.options, LOOP_STAGES.map((s) => STAGE_LABELS[s]));
  assert.deepEqual(spec.defaultChecked, spec.options, "ENTER accepts the defaults = all five on");
  // No label may contain the multi-answer separator, or a ticked answer would
  // be unreadable (lib/ask-user.ts enforces the same rule for its questions).
  for (const option of spec.options) {
    assert.ok(!option.includes(" / "), `"${option}" must not contain the checklist separator`);
  }
  assert.match(LOOP_STAGES_BODY, /空勾/, "the body says an empty submission is legal");
});

test("orchestrator mode, its children and judge panes are NOT offered the switch", () => {
  assert.match(stagesOffered({ mode: "orchestrator" }) ?? "", /编排模式/);
  assert.match(stagesOffered({ mode: "loop", orchestrated: true }) ?? "", /子会话/);
  assert.match(stagesOffered({ mode: "loop", judge: true }) ?? "", /judge/);
  assert.match(stagesOffered({ mode: "explore" }) ?? "", /explore/);
  assert.equal(stagesOffered({ mode: "loop" }), undefined, "a standalone loop session may choose");
  assert.equal(stagesOffered({}), undefined, "an undecided mode behaves as loop (fail-closed default)");
});

/** A fake dialog host: records what it was asked, answers with a fixed line. */
function fakeDeps(answer: string | undefined, opts: { record?: LoopStagesRecord; refused?: string } = {}) {
  const persisted: LoopStagesRecord[] = [];
  let asked = 0;
  let specs: string[][] = [];
  const deps: LoopStagesDeps = {
    state: () => (opts.record === undefined ? {} : { stages: opts.record }),
    refusal: () => opts.refused,
    askMulti: async (_ui, spec) => { asked += 1; specs.push([...spec.options]); return answer; },
    persist: (record) => { persisted.push(record); },
    now: () => new Date("2026-09-22T12:00:00.000Z"),
  };
  return { deps, persisted, asked: () => asked, specs: () => specs };
}

test("the dialog records what was ticked — including an EMPTY submission", async () => {
  // The line shape lib/multi-choice-dialog.ts produces for two ticks.
  const two = fakeDeps(`A. ${STAGE_LABELS.goal} / C. ${STAGE_LABELS.quality}`);
  const outcome = await chooseLoopStages(two.deps, {});
  assert.equal(outcome.kind, "recorded");
  assert.equal(two.persisted.length, 1);
  assert.equal(two.persisted[0]!.at, "2026-09-22T12:00:00.000Z");
  assert.deepEqual(stagesOff(two.persisted[0]), ["review", "acceptance", "precommit"]);

  const none = fakeDeps("");
  const empty = await chooseLoopStages(none.deps, {});
  assert.equal(empty.kind, "recorded");
  assert.deepEqual(stagesOff(none.persisted[0]), [...LOOP_STAGES], "空勾提交 = 五个环节全关");
});

test("a closed box and an unrenderable host record NOTHING (defaults keep running)", async () => {
  for (const [answer, kind] of [[undefined, "dismissed"], [MULTI_UNAVAILABLE, "unavailable"]] as const) {
    const fake = fakeDeps(answer);
    const outcome = await chooseLoopStages(fake.deps, {});
    assert.equal(outcome.kind, kind);
    assert.deepEqual(fake.persisted, [], "no record may be invented from a box nobody answered");
    assert.match(formatStagesOutcome(outcome, undefined), /全部开启（默认）/);
  }
});

test("the ✎ row is not a selection: it is reported back with its reason", async () => {
  const fake = fakeDeps("✎ 不选，我说明原因：这些环节一个都不能关");
  const outcome = await chooseLoopStages(fake.deps, {});
  assert.equal(outcome.kind, "declined");
  assert.equal(outcome.kind === "declined" ? outcome.reason : "", "这些环节一个都不能关");
  assert.deepEqual(fake.persisted, []);
});

test("a session that may not choose gets the refusal, and no box is opened", async () => {
  const fake = fakeDeps("", { refused: "review-gate: 编排模式不提供环节开关 —— 项目经理负责统筹，五个环节一律完整运行。" });
  const outcome = await chooseLoopStages(fake.deps, {});
  assert.equal(outcome.kind, "refused");
  assert.equal(fake.asked(), 0, "the box is never shown to a session the rule refuses");
});

test("the fallback is the SAME dialog, and only while nothing is on record", async () => {
  const first = fakeDeps("");
  const outcome = await ensureLoopStages(first.deps, {});
  assert.equal(outcome?.kind, "recorded");
  assert.equal(first.asked(), 1);

  const second = fakeDeps("", { record: stagesWith(["goal"]) });
  assert.equal(await ensureLoopStages(second.deps, {}), undefined);
  assert.equal(second.asked(), 0, "an answered session is never asked again");
});

test("re-opening the box offers the CURRENT record, not a fresh all-on default", async () => {
  const current = stagesWith(["review", "precommit"]);
  const fake = fakeDeps("", { record: current });
  await chooseLoopStages(fake.deps, {});
  assert.equal(fake.asked(), 1);
  assert.deepEqual(
    loopStagesSpec(current).defaultChecked,
    [STAGE_LABELS.goal, STAGE_LABELS.quality, STAGE_LABELS.acceptance],
    "the three stages still on are the ones ticked",
  );
  // …and an all-off record opens with nothing ticked, so Enter keeps it off
  // instead of silently re-enabling four stages.
  const off = stagesWith([...LOOP_STAGES]);
  assert.deepEqual(loopStagesSpec(off).defaultChecked, []);
});

test("the prompt block and the user's dialog body share ONE consequence table", () => {
  // Exit criterion 3: exactly these two consumers, one source. Both render
  // every stage's consequence from `STAGE_OFF_CONSEQUENCES` — so each sentence
  // exists ONCE in the module, and neither surface can drift from the other.
  // A source line may wrap one literal in two (`"…" +` / `"…"`), which is
  // formatting, not a second copy — join those first, then count.
  const flattened = MODULE_SRC.replace(/"\s*\+\s*\n\s*"/g, "");
  for (const stage of LOOP_STAGES) {
    const needle = STAGE_OFF_CONSEQUENCES[stage];
    assert.equal(flattened.split(needle).length - 1, 1, `${stage}'s consequence is written once (the shared table)`);
    assert.match(LOOP_STAGES_BODY, new RegExp(escapeRe(needle)), `the dialog body renders ${stage} from it`);
  }
});

// ---------------------------------------------------------------------------
// 1b. The prompt-side rendering (2026-09-22, user requirement)
// ---------------------------------------------------------------------------

test("no record renders NOTHING — a session that never opened the box is unchanged", () => {
  assert.equal(buildStagesDirective(undefined), "");
});

test("all five on says so in one line and releases nothing", () => {
  const text = buildStagesDirective(stagesWith([]));
  assert.match(text, /环节开关（用户设定）/);
  for (const stage of LOOP_STAGES) assert.match(text, new RegExp(`${stage} 开`), `${stage} is reported ON`);
  assert.doesNotMatch(text, /关 ⇒/, "nothing is off ⇒ no consequence sentence may appear");
  assert.doesNotMatch(text, /不要为/, "and no 'prepare nothing' instruction either");
});

test("every stage the user throws is named with its consequence", () => {
  for (const off of LOOP_STAGES) {
    const text = buildStagesDirective(stagesWith([off]));
    assert.match(text, new RegExp(`${off} \\*\\*关\\*\\*`), `${off} is named as off`);
    assert.match(text, /不要为关掉的环节做任何准备/, "the agent is told to prepare nothing for it");
    if (off === "goal") {
      // THE ONE EXCEPTION (audit Nit): the goal's switched-off behaviour has a
      // paragraph of its own in the same prompt, so this block must not state
      // it a second time — it points at it instead.
      assert.doesNotMatch(text, /不做需求反述/, "the goal-off wording is not duplicated here");
      assert.match(text, /见上面那段 goal 指令/, "…and it says where that wording lives");
      continue;
    }
    assert.match(text, new RegExp(escapeRe(STAGE_OFF_CONSEQUENCES[off])), `${off} off ⇒ its consequence rides along`);
  }
});

test("acceptance off says what to write INSTEAD, and names the way back", () => {
  const text = buildStagesDirective(stagesWith(["acceptance"]));
  assert.match(text, /本轮无真实验收（用户关闭了验收环节）/, "the goal's replacement clause is spelled out");
  assert.match(text, /不要写验收方案/, "and the plan it replaces is named");
  assert.match(text, /choose_loop_stages/, "re-opening the switch is named too");
  // …and it does NOT leak into a session where acceptance is on: there the
  // goal owes a real plan, and telling it otherwise would be the same bug in
  // the other direction.
  assert.doesNotMatch(buildStagesDirective(stagesWith(["review"])), /本轮无真实验收/);
});

test("the switches ride the loop prompt — and reach an UNDECIDED session too", () => {
  assert.match(SRC, /buildStagesDirective\(loopStagesRecord\(\)\)/, "the extension renders the session's own record");
  // ONE injection, shared by both cases: loop, and a session that has not
  // classified its mode yet (isEnforcedMode treats it as the loop, and the
  // checklist can already have been answered).
  const at = SRC.indexOf('if (state.taskMode === "loop" || state.taskMode === undefined) {');
  assert.ok(at > 0, "the block is injected for the loop AND for an undecided session");
  assert.match(SRC.slice(at, at + 400), /buildStagesDirective/,
    "…at that one guarded site, so the agent cannot miss the switches");
  assert.doesNotMatch(SRC, /if \(state\.taskMode === "explore" \|\| state\.taskMode === "normal"\) \{\n\s+const stagesBlock/,
    "explore/normal keep the gate out of their prompt");
  // …AND THE BLOCK'S POINTER MUST NOT DANGLE (quality round P2, 2026-09-22):
  // with the goal stage OFF the block says “see the goal paragraph above”, and
  // in an undecided session the loop branch below does not inject it.
  const undecidedGoal = SRC.indexOf('if (state.taskMode === undefined && !stageIsOn("goal")) {');
  assert.ok(undecidedGoal > at && undecidedGoal < at + 1200,
    "an undecided session whose goal stage is off gets that paragraph injected too");
  assert.match(SRC.slice(undecidedGoal, undecidedGoal + 220), /buildGoalStageOffDirective\(\)/,
    "…the same body the pointer names");
});

// ---------------------------------------------------------------------------
// 2. The shared ship authority + the REAL git hook
// ---------------------------------------------------------------------------

test("all five on is byte-for-byte today's requirement list", () => {
  const allOn = unmetCodeState();
  const noRecord = unmetCodeState();
  allOn.stages = stagesWith([]);
  const today = unmetRequirements(noRecord, "tree-oid", false);
  assert.deepEqual(unmetRequirements(allOn, "tree-oid", false), today);
  assert.ok(today.some((p) => /code review gate is PENDING/.test(p)), "the baseline really is blocked");
  assert.ok(today.some((p) => /precommit has not run/.test(p)), "the baseline really is blocked");
});

test("each switch releases its own half of the ship authority", () => {
  const reviewOff = unmetCodeState();
  reviewOff.stages = stagesWith(["review"]);
  const onlyPrecommit = unmetRequirements(reviewOff, "tree-oid", false);
  assert.ok(!onlyPrecommit.some((p) => /^(code|doc) review gate is/.test(p)), "a released review stage stops blocking");
  assert.deepEqual(onlyPrecommit, [
    // The quality stage is still ON, and with no reviewer to carry its verdict
    // it takes the review's place (see the test below).
    "quality round is NOT_RUN (need READY) — the review stage is off, so this is the verdict that stands between the code and a ship; submit a round (`judge_submit`) to run it",
    "precommit has not run",
  ]);

  const precommitOff = unmetCodeState();
  precommitOff.stages = stagesWith(["precommit"]);
  const onlyReview = unmetRequirements(precommitOff, "tree-oid", false);
  assert.ok(!onlyReview.some((p) => /precommit/.test(p)), "a released precommit stage stops blocking");
  assert.deepEqual(onlyReview, ["code review gate is PENDING (need READY)"],
    "with review ON the quality round is carried by the review's own record — no second requirement appears");

  // BOTH released, quality still on: the quality round is the only judge left,
  // so it is required; releasing it too is what lets the round ship with none.
  const bothOff = unmetCodeState();
  bothOff.stages = stagesWith(["review", "precommit"]);
  assert.equal(unmetRequirements(bothOff, "tree-oid", false).length, 1);
  bothOff.stages = stagesWith(["review", "precommit", "quality"]);
  assert.deepEqual(unmetRequirements(bothOff, "tree-oid", false), [], "three released stages ship");
});

test("the doc-review half is released by the same review switch", () => {
  const docs = unmetCodeState();
  docs.hasCodeChange = false;
  docs.hasDocChange = true;
  assert.deepEqual(unmetRequirements(docs, "tree-oid", false), ["doc review gate is PENDING (need READY)"]);
  docs.stages = stagesWith(["review"]);
  assert.deepEqual(unmetRequirements(docs, "tree-oid", false), []);
});

test("with the review stage off, the quality verdict IS the review — and it is content-bound", () => {
  // With review ON the quality verdict gates the READY's RECORD; with it OFF
  // nothing else reads it, so it takes the review's place: required, and bound
  // to the tree it judged (quality round P2, 2026-09-22).
  const st = unmetCodeState();
  st.stages = stagesWith(["review", "precommit"]);

  // Never ran ⇒ the round is owed.
  let problems = unmetRequirements(st, "tree-oid", false);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /quality round is NOT_RUN \(need READY\)/);

  // A refusal binds exactly like a review verdict.
  st.quality = { verdict: "BLOCKED", commitSha: "c", treeSha: "tree-oid", at: "t" };
  assert.match(unmetRequirements(st, "tree-oid", false)[0]!, /quality round is BLOCKED \(need READY\)/);

  // A SKIP STANDS FOR EXACTLY ONE REASON (acceptance round P1, 2026-09-22):
  // the round had no code to judge. A skip written because the stage was OFF
  // does not stand once it is back on.
  st.quality = { verdict: "READY", commitSha: "c", treeSha: "tree-oid", at: "t", skipped: true, skipCause: "stage-off" };
  assert.match(unmetRequirements(st, "tree-oid", false)[0]!, /quality round is SKIPPED \(need READY\)/,
    "a stage-off SKIP record is not the quality READY this authority requires: with the stage back ON and code in the " +
      "worktree it proves nothing about this code");
  // …while a CODE-FREE skip IS the standing for its content (functional round
  // P1, same day): refusing it too made every docs-only round unshippable.
  st.quality = { verdict: "READY", commitSha: "c", treeSha: "tree-oid", at: "t", skipped: true, skipCause: "no-code" };
  assert.deepEqual(unmetRequirements(st, "tree-oid", false), [],
    "a code-free round's skip stands — no quality judge is ever owed for that content");
  assert.match(unmetRequirements(st, "other-tree", false)[0]!, /modified after the last quality READY/,
    "…and it is still bound to the tree it was written for");

  // A READY unlocks only the tree it judged.
  st.quality = { verdict: "READY", commitSha: "c", treeSha: "tree-oid", at: "t" };
  assert.deepEqual(unmetRequirements(st, "tree-oid", false), []);
  assert.match(unmetRequirements(st, "other-tree", false)[0]!, /modified after the last quality READY/,
    "an edit after the quality READY withdraws it, exactly like the review's own binding");
  st.quality = { verdict: "READY", commitSha: "c", at: "t" };
  assert.match(unmetRequirements(st, "tree-oid", false)[0]!, /modified after the last quality READY/,
    "a record with no tree binding is unverifiable — fail closed");

  // …and releasing the quality stage releases it like everything else.
  st.stages = stagesWith(["review", "precommit", "quality"]);
  assert.deepEqual(unmetRequirements(st, "tree-oid", false), []);
});

test("the acceptance composition is the AND the extension writes", () => {
  // `gateOpen` is t2's own input; the extension feeds it the dispatcher's
  // environment value AND the user's stage. With either false the round is
  // DISABLED — the same action the orchestration-child path already had.
  const closed = acceptanceDecision({
    hasCodeChange: true,
    gateOpen: acceptanceGateOpen({}) && false,
    fingerprint: "f",
  });
  assert.equal(closed.action, "skip");
  assert.equal(closed.action === "skip" ? closed.status : "", "DISABLED");
  const open = acceptanceDecision({ hasCodeChange: true, gateOpen: acceptanceGateOpen({}) && true, fingerprint: "f" });
  assert.equal(open.action, "dispatch");
});

test("the REAL L3 pre-commit checker honors the same record (exit codes, not prose)", () => {
  const dir = makeGitRepo();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "lib.ts"), "// x\n");
  execFileSync("git", ["add", "src/lib.ts"], { cwd: dir, stdio: "ignore" });
  const base = {
    ...readyState(dir),
    review: { verdict: "PENDING", fingerprint: null, at: null },
    precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
  };

  writeState(dir, base);
  assert.equal(check(dir), 1, "the baseline really blocks a commit");

  writeState(dir, { ...base, stages: stagesWith(["review"]) });
  assert.equal(check(dir), 1, "releasing review alone still blocks on precommit");

  writeState(dir, { ...base, stages: stagesWith(["precommit"]) });
  assert.equal(check(dir), 1, "releasing precommit alone still blocks on review");

  writeState(dir, { ...base, stages: stagesWith(["review", "precommit", "quality"]) });
  assert.equal(check(dir), 0, "all three released ⇒ the commit hook lets the commit through");

  // A partial/forged record is invalid state: the hook fails CLOSED rather
  // than reading a half-written switch-off (the same rule as the sanitizer).
  writeState(dir, { ...base, stages: { stages: { review: false }, at: "t" } });
  assert.equal(check(dir), 1, "an unreadable stage record fails closed");

  // THE QUALITY VERDICT is mirrored too (2026-09-22): with the review stage
  // released, it takes the review's place — required, and bound to the tree.
  const tree = (readyState(dir).review as { fingerprint: string }).fingerprint;
  writeState(dir, {
    ...base,
    quality: { verdict: "BLOCKED", commitSha: "c", treeSha: tree, at: "t" },
    stages: stagesWith(["review", "precommit"]),
  });
  assert.equal(check(dir), 1, "a BLOCKED quality round with no reviewer to carry it still blocks");
  writeState(dir, {
    ...base,
    // THE RECORD A RELEASED STAGE WRITES (acceptance round P1, 2026-09-22):
    // 「quality 关 → 编辑 → judge_submit → 重开 quality」must not ship on it —
    // the stage is ON again, and no quality judge ever saw this code.
    quality: {
      verdict: "READY", commitSha: "c", treeSha: tree, at: "t", skipped: true, skipCause: "stage-off",
      skipReason: "质量环节已关闭（用户设定的环节开关）—— 不派 quality-auditor",
    },
    stages: stagesWith(["review", "precommit"]),
  });
  assert.equal(check(dir), 1, "a stage-off SKIP record must not stand in for the quality READY once the stage is back on");
  writeState(dir, {
    ...base,
    // …AND A CODE-FREE SKIP IS A DIFFERENT THING (functional round P1, same
    // day): no quality judge is owed for a docs-only round, so the hook must
    // not block the commit on it either.
    quality: {
      verdict: "READY", commitSha: "c", treeSha: tree, at: "t", skipped: true, skipCause: "no-code",
      skipReason: "本轮只改动了非代码文件",
    },
    stages: stagesWith(["review", "precommit"]),
  });
  assert.equal(check(dir), 0, "a code-free skip still stands — refusing it would deadlock every docs-only round");
  writeState(dir, {
    ...base,
    quality: { verdict: "READY", commitSha: "c", treeSha: tree, at: "t" },
    stages: stagesWith(["review", "precommit"]),
  });
  assert.equal(check(dir), 0, "a quality READY on this exact tree stands in for the missing review");
  writeState(dir, {
    ...base,
    // The tree the quality round judged is the PREVIOUS content: the worktree
    // has moved since, and nothing else would notice.
    quality: { verdict: "READY", commitSha: "c", treeSha: "0".repeat(40), at: "t" },
    stages: stagesWith(["review", "precommit"]),
  });
  assert.equal(check(dir), 1, "a quality READY bound to other content must not ship");
  writeState(dir, {
    ...base,
    quality: { verdict: "BLOCKED", commitSha: "c", treeSha: tree, at: "t" },
    stages: stagesWith(["review", "precommit", "quality"]),
  });
  assert.equal(check(dir), 0, "…and releasing the quality stage releases it");
});

// The hook carries its own copy of the stage LIST (it runs on every commit and
// push, in checkouts where the extension is not loaded at all), so the list is a
// TS/CJS pair like the session modes — and a pair drifts in one direction.
// Textual on purpose: the hook's other four stages have no rule to observe.
test("the hook's stage list is the TS module's list (drift guard)", () => {
  const cjs = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "scripts", "pre-commit-check.cjs"), "utf8");
  const match = /const LOOP_STAGES = \[([^\]]*)\]/.exec(cjs);
  assert.ok(match, "the hook declares LOOP_STAGES (its copy of the vocabulary)");
  const names = match[1]!.split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  assert.deepEqual(names, [...LOOP_STAGES],
    "a stage added on the TS side must be added to the hook — otherwise its sidecar reads as corrupt");
});

test("goal off: both contract tools short-circuit BEFORE any other step", async () => {
  // Exit criterion 3 (`goal 关 ⇒ 不跑 goal 审计、不弹批准框、免需求反述`) rests on
  // these two early returns, and the deps below make it behavioural: every
  // member except the state read THROWS, so reaching one is a failed test
  // rather than a detail nobody asserts (reviewer P2, 2026-09-22).
  const boom = (name: string) => () => { throw new Error(`must not be reached: ${name}`); };
  const depsFor = (record: LoopStagesRecord | undefined) => {
    const st = { ...emptyState("test-session", 10), ...(record === undefined ? {} : { stages: record }) };
    return {
      primaryRepoRoot: () => "/repo",
      cwd: () => "/repo",
      stateFor: () => st,
      persist: boom("persist"),
      log: boom("log"),
      runGoalAudit: async () => { throw new Error("must not be reached: runGoalAudit"); },
      showToUser: boom("showToUser"),
      askChoice: async () => { throw new Error("must not be reached: askChoice"); },
      askEitherSide: async () => { throw new Error("must not be reached: askEitherSide"); },
      loopGoalPath: () => "/repo/.pi/loop-goal.md",
      loopGoalRelPath: ".pi/loop-goal.md",
      findProjectAgent: boom("findProjectAgent"),
      writeGoalFile: boom("writeGoalFile"),
    };
  };

  const off = stagesWith(["goal"]);
  const restated = await doProposeRestatement(
    depsFor(off) as unknown as RestatementToolDeps,
    { restatement: "whatever the agent wrote", station: "commit" },
    { hasUI: true },
  );
  assert.match(restated.content[0]!.text, /goal 环节已关闭/);
  assert.notEqual(restated.isError, true, "the stage is off: this is an answer, not a refusal");

  const proposed = await doProposeLoopGoal(
    depsFor(off) as unknown as GoalToolDeps,
    { goal: "# any draft" },
    { hasUI: true },
    undefined,
    undefined,
  );
  assert.match(proposed.content[0]!.text, /goal 环节已关闭/);
  assert.equal(proposed.details?.approved, false, "no approval is invented for a switched-off stage");

  // AND THE STAGE BEING ON IS STILL THE ORDINARY PATH: the same untouchable
  // deps now reach the draft checks and refuse the draft, which is what proves
  // the early return is keyed on the switch and not on the deps being stubs.
  const on = await doProposeRestatement(
    depsFor(stagesWith([])) as unknown as RestatementToolDeps,
    { restatement: "太短了", station: "commit" },
    { hasUI: true },
  );
  assert.equal(on.isError, true, "a stage that is ON evaluates the draft exactly as before");
});

test("the fallback keeps its one chance for a session that can actually be asked", () => {
  // Reviewer Nit: `stagesAsked` used to be set BEFORE the eligibility check, so
  // an explore/normal edit spent it and a later promotion to loop never saw the
  // box.
  const at = SRC.indexOf("async function ensureLoopStagesFor(");
  assert.ok(at > 0, "the fallback exists");
  const body = SRC.slice(at, at + 1000);
  assert.ok(body.indexOf("stagesOffered(") < body.indexOf("stagesAsked = true"),
    "the refusal is checked before the once-per-session flag is spent");
});

test("the body says what a released goal stage does to the delivery station", () => {
  // Reviewer P2: the station ceiling comes from the goal, and the checkbox is
  // where the user reads what they are switching off.
  assert.match(LOOP_STAGES_BODY, /交付站点上限也随之消失/);
});

test("an acceptance round the USER switched off records that reason, not the orchestration one", () => {
  // Reviewer P2: `acceptanceDecision` writes DISABLED for both causes and its
  // copy names the orchestration rule; the status stays the module's, the
  // recorded reason is composed where the switch is known.
  assert.match(SRC, /const skippedReason = !stageIsOn\("acceptance", root\)/);
  assert.match(SRC, /reason: skippedReason,/);
});

// ---------------------------------------------------------------------------
// 3. The extension's wiring (the four places a pure module cannot reach)
// ---------------------------------------------------------------------------

const SRC = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "extensions", "review-gate.ts"),
  "utf8",
);

test("the goal stage releases the edit gate and the ship block through goalStageSatisfied", () => {
  assert.match(SRC, /goalConfirmed: goalStageSatisfied\(goalRoot, goalSt\)/,
    "the L8 edit gate asks the stage-aware question");
  assert.match(SRC, /loopGoalConfirmed: \(\) => goalStageSatisfied\(\)/,
    "the L1 ship gate asks the stage-aware question");
  assert.match(SRC, /if \(!goalStageSatisfied\(\)\) completion\.push\(LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK\)/,
    "the completion/continuation path asks the stage-aware question");
  assert.match(SRC, /if \(!stageIsOn\("goal", root\)\) return undefined;/,
    "a released goal stage has no delivery station to read");
});

test("the five checkpoints read the ONE query, not a second rule", () => {
  assert.match(SRC, /const reviewOn = stageIsOn\("review", input\.root\)/);
  assert.match(SRC, /const qualityOn = stageIsOn\("quality", input\.root\)/);
  assert.match(SRC, /const precommitOn = stageIsOn\("precommit", input\.root\)/);
  assert.match(SRC, /gateOpen: acceptanceGateOpen\(process\.env\) && stageIsOn\("acceptance", root\)/);
  assert.match(SRC, /registerLoopStageTools\(pi, loopStageDeps\)/, "the tool is registered");
  assert.match(SRC, /ensureLoopStages: \(ctx\) => ensureLoopStagesFor\(ctx\)/,
    "the fallback is wired into the L1 hook for the first edit / restatement");
});

test("precommit off owes no lane: the verification binding never withholds that READY (quality round P1, 2026-09-22)", () => {
  // The combination's deadlock: with the stage off the chain starts no lane at
  // all, so `lastFullPassTree` can never catch up with the content — and the
  // old reading withheld EVERY READY as `unverified-idle` (REFUSED, not held),
  // which nothing the agent could do would end.
  //
  // TWO halves, pinned together: the extension composes “no lane is owed” ONCE
  // and BOTH adjudication sites read that composition (the recorder and the
  // parked-READY re-ask). Feeding them separately is the drift the adjudicator's
  // docblock records from 2026-09-16.
  const at = SRC.indexOf("function laneVerificationWaived(");
  assert.ok(at > 0, "the composition exists");
  const body = SRC.slice(at, SRC.indexOf("\n  }", at));
  assert.match(body, /st\.bypass\.active \|\| !stageIsOn\("precommit", root\)/,
    "the user's bypass and the switched-off stage are ONE fact");
  assert.equal(
    (SRC.match(/bypassActive: laneVerificationWaived\(/g) ?? []).length,
    2,
    "the recorder and the parked-READY re-ask both read the composition",
  );
  assert.doesNotMatch(SRC, /bypassActive: st\.bypass\.active,/,
    "no site reads the bypass alone — that is how the two halves drift");
  // …and the flag it feeds means “no lane is owed”: a round nobody has to
  // verify is NOT withheld as unverified.
  assert.equal(
    readyLacksVerification({
      precommitVerdict: "NOT_RUN",
      lastFullPassTree: "old-tree",
      reviewedTree: "this-round-tree",
      bypassActive: true,
    }),
    false,
    "a round that owes no lane is never reported unverified",
  );
});

test("a proxy may not answer the stage checklist (quality round P1, 2026-09-22)", () => {
  // The checkbox travels through the gate's own dialog, which races every
  // question against the thirty-minute arbiter hand-off. A stand-in naming only
  // SOME rows would record the unnamed ones as OFF — a machine switching gates
  // off in the user's name. The one place that can express “not this question”
  // is the dialog's `proxy` option, and it must be wired false HERE.
  const start = SRC.indexOf("const loopStageDeps: LoopStagesDeps = {");
  assert.ok(start > 0, "the stage deps exist");
  const wiring = SRC.slice(start, SRC.indexOf("\n  };", start));
  assert.match(wiring, /proxy: false/, "the stage checklist must not be handed to the arbiter proxy");
  assert.match(SRC, /options: opts\.proxy === false \? \[\] : spec\.options/,
    "…and the dialog turns that request into the race's own no-proxy signal");
  // AND IT MUST NOT BLAME THE ARBITER (quality round P2): the timeout notice
  // is the user's only clue that a decision is still owed, and “arbiter 无法代答”
  // would read as a broken machine rather than a deliberate policy. Both copies
  // live in the same dialog body, which is where the branch is read from.
  const raceAt = SRC.indexOf("options: opts.proxy === false ? [] : spec.options");
  assert.ok(raceAt > 0, "the dialog knows the no-proxy request");
  const notice = SRC.slice(raceAt, raceAt + 2500);
  assert.match(notice, /opts\.proxy === false/, "the timeout notice branches on it");
  assert.match(notice, /不问 arbiter 代答/, "…and does not report a deliberate policy as a broken arbiter");
  assert.match(notice, /arbiter 无法代答/, "the other dialogs' wording is left alone");
});

test("a skipped quality round carries the tree the ship gate verifies (quality round P1)", () => {
  // With the review stage OFF the quality record IS the ship requirement, and
  // a record without `treeSha` cannot be verified. A docs-only SKIP used to
  // write exactly that shape (lib/quality-round.ts's `skippedQualityRecord`
  // takes an OPTIONAL tree), so the next ship would have failed closed on a
  // tree nobody recorded.
  const at = SRC.indexOf("st.quality = skippedQualityRecord({");
  assert.ok(at > 0, "the chain records the skipped quality round");
  assert.match(SRC.slice(at, at + 700), /tree: skipTarget\.tree/,
    "the skip binds to the prepared tree, the same source the verdict recorder reads");
});

test("the no-acceptance declaration is only read from a goal that is in force", () => {
  // `parseNoAcceptanceDeclaration` reads TEXT, so a leftover goal file could
  // exempt this round from real acceptance — and with the goal stage off there
  // is no approval requirement left to notice (quality round P2, 2026-09-22).
  //
  // ONE READ FOR BOTH HALVES (quality round P2, 2026-09-22): the declaration
  // and the PLAN handed to the judge are the same question, so the guard lives
  // in `acceptanceGoalText` and both halves go through it — the plan side used
  // to re-read `readSessionLoopGoal` unguarded.
  const goalRead = SRC.indexOf("function acceptanceGoalText(");
  assert.ok(goalRead > 0, "the one read of the governing goal exists");
  const guard = SRC.slice(goalRead, SRC.indexOf("\n  }", goalRead));
  // The guard's SHAPE is not the rule — `goal.present && loopGoalConfirmed(…)`
  // and its De Morgan form (`if (!goal.present || !loopGoalConfirmed(…)) return
  // undefined`) say the same thing, and pinning one spelling made an unrelated
  // change to this function (reading the whole file instead of the capped
  // prompt copy, 2026-09-22) fail a test about approval. What must hold: the
  // file has to be there, it has to be the one this session had approved, and
  // anything else leaves the round with NO contract.
  assert.match(guard, /goal\.present/, "the goal file must be there");
  assert.match(guard, /loopGoalConfirmed\(root, st\)/,
    "only a goal this session actually had approved is in force");
  assert.match(guard, /return undefined/, "…and anything else is no contract (fail-closed)");
  const at = SRC.indexOf("const declared = ");
  assert.ok(at > 0, "armAcceptanceRound reads the declaration");
  const read = SRC.slice(at - 300, at + 400);
  assert.match(read, /acceptanceGoalText\(root, st\)/, "…through that one read");
  assert.match(read, /parseNoAcceptanceDeclaration\(goalText\)/);
  assert.match(read, /extractAcceptancePlan\(goalText\)/, "the plan comes from the same text");
  const dispatchAt = SRC.indexOf("async function dispatchAcceptanceRound(");
  const dispatch = SRC.slice(dispatchAt, dispatchAt + 900);
  assert.doesNotMatch(dispatch, /readSessionLoopGoal\(/,
    "the plan side re-reads nothing — the text is handed in");
});

test("the widget shows the switches only when something is off", () => {
  const on = buildGateWidget({ mode: "loop", edited: true, unmet: [] });
  assert.ok(!on.join(" ").includes("已关闭"), "an all-on session's strip is unchanged");
  const off = buildGateWidget({ mode: "loop", edited: true, unmet: [], stages: stagesSummary(stagesWith(["review"])) });
  assert.match(off.join(" "), /已关闭 review/);
});
