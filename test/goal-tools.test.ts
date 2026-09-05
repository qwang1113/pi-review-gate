import test from "node:test";
import assert from "node:assert/strict";

import {
  registerGoalTools,
  doProposeLoopGoal,
  type GoalToolDeps,
} from "../lib/goal-tools.ts";
import {
  checkGoalDraft,
  buildGoalRecordReply,
  recordGoalPrereview,
} from "../lib/goal-prereview-tools.ts";
import type { ToolHost, ToolReply } from "../lib/tool-host.ts";
import type { ReportConclusion } from "../lib/orchestrator-channel.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import { goalTextHash, LOOP_GOAL_MAX_WRITE_CHARS } from "../lib/loop-goal.ts";
import { restatementHash, type RestatementRecord } from "../lib/restatement.ts";
import type { DeliveryStation } from "../lib/delivery-station.ts";

/**
 * The goal tool family used to live inside the 8000-line extension, where
 * exercising "the auditor never concluded" or "the user rejected the
 * draft" meant driving a real session through a real dialog. They are now a
 * lib/ module whose every effect arrives through `deps` — so the branches
 * below run against fakes, and a behavior change during the move would have
 * to survive an assertion instead of a reviewer's eyes.
 *
 * The PURE decisions (`checkGoalDraft`, `buildGoalRecordReply`) are tested
 * directly: they carry the refusal texts and the adjudication sentence the
 * agent actually reads, which is where a silent wording regression would hide.
 */

const ROOT = "/repo";
const OTHER = "/other-repo";
// Already NORMALIZED (no trailing newline): `normalizeGoalText` trims, and a
// fixture that needed trimming would make every text assertion below approximate.
const GOAL = "# 目标\n\n意图：把 goal 工具组搬进 lib/。\n\n1. 行为零变化";

// The auditor's conclusion arrives as DATA off its channel report — the same
// shape `judge_conclude` was called with. There is no output text to parse.
/** A goal-auditor round the gate must read as a PASS (READY, no P0/P1). */
const AUDITOR_PASS: ReportConclusion = { verdict: "READY", findings: [] };
/** …one it must read as a FAIL. */
const AUDITOR_FAIL: ReportConclusion = {
  verdict: "BLOCKED",
  findings: [{ severity: "P1", issue: "不可检查" }],
};
/** …and a READY carrying only NON-blocking findings, which is still a PASS. */
const AUDITOR_PASS_WITH_P2: ReportConclusion = {
  verdict: "READY",
  findings: [{ severity: "P2", issue: "措辞" }],
};
/** …and a round that never concluded: the gate must record NOTHING. */
const AUDITOR_NO_VERDICT: ReportConclusion = { verdict: "", findings: [] };

// ---------------------------------------------------------------------------
// checkGoalDraft — the three things BOTH tools demand of a submission

test("checkGoalDraft: an empty draft is refused, naming the tool that refused it", () => {
  const out = checkGoalDraft({
    tool: "propose_loop_goal", rawGoal: "   \n\t ", rawRepo: undefined, cwd: ROOT, primaryRepoRoot: ROOT,
  });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.text, "review-gate: propose_loop_goal rejected — the goal text is empty.");
  // A missing parameter is the same case, not a crash.
  const missing = checkGoalDraft({
    tool: "propose_loop_goal", rawGoal: undefined, rawRepo: undefined, cwd: ROOT, primaryRepoRoot: ROOT,
  });
  assert.equal(missing.ok, false);
});

test("checkGoalDraft: the write cap is refused with the number, and the audit runs the SAME check", () => {
  const huge = "# 目标\n\n" + "卡".repeat(LOOP_GOAL_MAX_WRITE_CHARS);
  const propose = checkGoalDraft({
    tool: "propose_loop_goal", rawGoal: huge, rawRepo: undefined, cwd: ROOT, primaryRepoRoot: ROOT,
  });
  assert.equal(propose.ok, false);
  // The cap is named in the refusal — an agent that cannot see the number
  // cannot know how much to cut.
  assert.match(propose.ok === false ? propose.text : "", new RegExp(String(LOOP_GOAL_MAX_WRITE_CHARS)));
});

test("checkGoalDraft: no `repo` binds to the session repo; a real one binds to its git root", () => {
  const primary = checkGoalDraft({
    tool: "propose_loop_goal", rawGoal: GOAL, rawRepo: "  ", cwd: ROOT, primaryRepoRoot: ROOT,
  });
  assert.equal(primary.ok && primary.root, ROOT);
  const second = checkGoalDraft({
    tool: "propose_loop_goal", rawGoal: GOAL, rawRepo: OTHER, cwd: ROOT, primaryRepoRoot: ROOT,
    gitRoot: (dir) => (dir === OTHER ? OTHER : null),
  });
  assert.equal(second.ok && second.root, OTHER);
});

test("checkGoalDraft: a NON-repo path is refused — a goal bound there could never be satisfied", () => {
  const out = checkGoalDraft({
    tool: "propose_loop_goal", rawGoal: GOAL, rawRepo: "/tmp/not-a-repo", cwd: ROOT, primaryRepoRoot: ROOT,
    gitRoot: () => null,
  });
  assert.equal(out.ok, false);
  const text = out.ok === false ? out.text : "";
  assert.match(text, /not inside a readable git repository/);
  assert.match(text, /\/tmp\/not-a-repo/, "the refusal must name the path that was rejected");
});

// ---------------------------------------------------------------------------
// buildGoalRecordReply — the sentence the agent reads after an audit

test("buildGoalRecordReply: a PASS points at propose_loop_goal and binds to the hash", () => {
  const text = buildGoalRecordReply({
    message: "PASS（第 1 轮审计）",
    passed: true,
    hash: "abcdef0123456789",
    verdict: "READY",
    durationMs: 54_000,
    auditGapMin: null,
    reaudit: false,
  });
  assert.match(text, /PASS（abcdef012345…）/, "the PASS names the draft it belongs to");
  assert.match(text, /IDENTICAL/, "…and says that changing one character voids it");
  assert.match(text, /本轮审计耗时 54s。/);
  assert.doesNotMatch(text, /距上一轮审计/, "no gap line without a previous audit");
  assert.doesNotMatch(text, /重审时/, "a first audit carries no re-audit hint");
});

test("buildGoalRecordReply: a FAIL names the verdict and says the gate stays shut", () => {
  const text = buildGoalRecordReply({
    message: "BLOCKED（第 2 轮审计）",
    passed: false,
    hash: "0000",
    verdict: "BLOCKED",
    durationMs: undefined,
    auditGapMin: 7,
    reaudit: true,
  });
  assert.match(text, /记录：FAIL（verdict BLOCKED）/);
  assert.match(text, /propose_loop_goal 保持阻塞。/);
  assert.match(text, /距上一轮审计 7 min。/);
  assert.match(text, /重审时把修订稿直接交给/, "a re-audit says the carryover is automatic");
  assert.doesNotMatch(text, /本轮审计耗时/, "no duration was reported, so none is invented");
});

// ---------------------------------------------------------------------------
// recordGoalPrereview — the audit becomes a record, or nothing at all

interface RecordFake {
  deps: GoalToolDeps;
  st: GateState;
  persisted: string[];
  logs: string[];
  /** The dialogs/audits `propose_loop_goal` reached, in order. */
  surfaces: string[];
  written: Array<{ path: string; text: string }>;
  audit: { ok: true } | { ok: false; text: string };
  auditRuns: number;
  auditorInstalled: boolean;
  approve: boolean;
  rejectReason: string | undefined;
  writeFails: boolean;
}

function fake(over: Partial<RecordFake> = {}): RecordFake {
  const f: RecordFake = {
    deps: undefined as unknown as GoalToolDeps,
    st: emptyState("sess-1", 10),
    persisted: [],
    logs: [],
    surfaces: [],
    written: [],
    audit: { ok: true },
    auditRuns: 0,
    auditorInstalled: true,
    approve: true,
    rejectReason: undefined,
    writeFails: false,
    ...over,
  };
  f.deps = {
    primaryRepoRoot: () => ROOT,
    cwd: () => ROOT,
    stateFor: () => f.st,
    persist: (_ctx, root) => { f.persisted.push(root); },
    log: (message) => { f.logs.push(message); },
    runGoalAudit: async () => {
      f.auditRuns += 1;
      f.surfaces.push("audit");
      return f.audit;
    },
    showToUser: () => { f.surfaces.push("showToUser"); return true; },
    confirmBounded: async () => { f.surfaces.push("confirm"); return f.approve; },
    askEitherSide: async (_request, _hasUI, render) => {
      const answer = await render(new AbortController().signal);
      return { answer, by: answer === undefined ? "dismissed" : "human", requestId: "r1", ...(f.rejectReason ? { reason: f.rejectReason } : {}) };
    },
    loopGoalPath: (root) => `${root}/.pi/loop-goal.md`,
    loopGoalRelPath: ".pi/loop-goal.md",
    findProjectAgent: (_dir, name) =>
      (f.auditorInstalled && name === "goal-auditor" ? "---\nname: goal-auditor\n---\n" : undefined),
    writeGoalFile: (path, text) => {
      if (f.writeFails) throw new Error("EACCES");
      f.written.push({ path, text });
    },
  };
  return f;
}

/** A tool ctx with a UI: `hasUI` decides whether a dialog may render at all. */
function uiCtx(f: RecordFake): unknown {
  return {
    hasUI: true,
    ui: {
      notify: () => {},
      input: async () => f.rejectReason,
    },
  };
}

test("record: a READY without P0/P1 is recorded as a PASS, bound to the draft's hash", async () => {
  const f = fake();
  const out = await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
  assert.match(out, /PASS/);
  assert.equal(f.st.goalPrereview?.verdict, "PASS");
  assert.equal(f.st.goalPrereview?.hash, goalTextHash(GOAL));
  assert.equal(f.st.goalPrereview?.draft, GOAL);
  assert.equal(f.st.goalPrereviewHistory?.length, 1);
  assert.deepEqual(f.persisted, [ROOT], "the record is persisted for the repo it binds to");
  assert.match(f.logs.join("\n"), /goal pre-review recorded for \/repo: PASS/);
});

test("record: non-blocking findings never turn a READY into a FAIL (B2)", async () => {
  const f = fake();
  await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_PASS_WITH_P2 }, {});
  assert.equal(f.st.goalPrereview?.verdict, "PASS");
  assert.equal(f.st.goalPrereview?.findings?.length, 1, "the finding is kept on the record…");
  assert.equal(f.st.goalAuditRound, 1, "…and it did not buy another audit round");
});

test("record: the findings are kept VERBATIM off the auditor's own conclusion", async () => {
  const f = fake();
  await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_FAIL }, {});
  assert.deepEqual(f.st.goalPrereview?.findings, [{ severity: "P1", issue: "不可检查" }]);
  assert.equal(f.st.goalPrereview?.findingsTotal, 1);
});

test("record: a BLOCKED verdict is a FAIL, and the audit round is counted per goal", async () => {
  const f = fake();
  await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_FAIL }, {});
  assert.equal(f.st.goalPrereview?.verdict, "FAIL");
  assert.equal(f.st.goalAuditRound, 1);
  // A revised draft is a RE-audit: round 2, and the reply says the carryover
  // is automatic (the previous record was for a different hash).
  const revised = await recordGoalPrereview(
    f.deps, { goal: GOAL + "\n2. 又一条\n", conclusion: AUDITOR_PASS }, {},
  );
  assert.equal(f.st.goalAuditRound, 2);
  assert.match(revised, /重审时把修订稿直接交给/, "the reply says the carryover is automatic");
  assert.equal(f.st.goalPrereviewHistory?.length, 2, "every audit stays in the history, oldest first");
  assert.equal(f.st.goalPrereview?.verdict, "PASS");
});

test("record: a round that never concluded records NOTHING (fail-closed), leaving a standing PASS intact", async () => {
  const f = fake();
  await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
  const standing = f.st.goalPrereview;
  const out = await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_NO_VERDICT }, {});
  assert.match(out, /NOTHING was recorded/);
  assert.equal(f.st.goalPrereview, standing, "the standing record must not be downgraded");
  assert.equal(f.st.goalPrereviewHistory?.length, 1);
});

test("record: an agent-supplied duration in the future records NO duration", async () => {
  const f = fake();
  const future = new Date(Date.now() + 600_000).toISOString();
  await recordGoalPrereview(
    f.deps, { goal: GOAL, conclusion: AUDITOR_PASS, auditStartedAt: future }, {},
  );
  assert.equal(f.st.goalPrereview?.durationMs, undefined);
  await recordGoalPrereview(
    f.deps,
    { goal: GOAL + "\nx\n", conclusion: AUDITOR_PASS, auditStartedAt: new Date(Date.now() - 5_000).toISOString() },
    {},
  );
  assert.ok((f.st.goalPrereview?.durationMs ?? 0) >= 5_000);
});

// ---------------------------------------------------------------------------
// doProposeLoopGoal — the audit runs first, the user decides, the gate writes

test("propose: with no PASS on record the gate runs the audit ITSELF, before any user surface", async () => {
  const f = fake();
  // The audit "passes" by recording one, exactly as the real chain does.
  f.deps.runGoalAudit = async () => {
    f.auditRuns += 1;
    f.surfaces.push("audit");
    await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
    return { ok: true };
  };
  const out = await doProposeLoopGoal(f.deps, { goal: GOAL }, uiCtx(f), undefined);
  assert.equal(out.details?.approved, true);
  assert.equal(f.auditRuns, 1);
  assert.deepEqual(f.surfaces, ["audit", "showToUser", "confirm"],
    "the audit must come BEFORE the transcript echo and the dialog");
  assert.equal(f.written[0]?.path, `${ROOT}/.pi/loop-goal.md`);
  assert.equal(f.written[0]?.text, GOAL + "\n");
  assert.equal(f.st.loopGoal?.hash, goalTextHash(GOAL), "the approval binds to the text the user saw");
  assert.equal(f.st.goalAuditRound, undefined, "an approved goal ends its own audit count");
});

test("propose: a BLOCKED audit shows the user NOTHING and writes no file", async () => {
  const f = fake({ audit: { ok: false, text: "review-gate: goal 审计**没过**" } });
  const out = await doProposeLoopGoal(f.deps, { goal: GOAL }, uiCtx(f), undefined);
  assert.equal(out.isError, true);
  assert.equal(out.details?.approved, false);
  assert.equal(out.details?.prereview, "BLOCKED");
  assert.deepEqual(f.surfaces, ["audit"], "no dialog, no transcript spam");
  assert.deepEqual(f.written, []);
  assert.equal(f.st.loopGoal, undefined);
});

test("propose: a PASS already on record for THIS text skips the audit; one character voids it", async () => {
  const f = fake();
  await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
  await doProposeLoopGoal(f.deps, { goal: GOAL }, uiCtx(f), undefined);
  assert.equal(f.auditRuns, 0, "re-auditing identical text would burn minutes for the same verdict");

  const f2 = fake({ audit: { ok: false, text: "blocked" } });
  await recordGoalPrereview(f2.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
  const edited = await doProposeLoopGoal(f2.deps, { goal: GOAL + "（改了一个字）" }, uiCtx(f2), undefined);
  assert.equal(f2.auditRuns, 1, "a different draft needs its own audit");
  assert.equal(edited.details?.approved, false);
});

test("propose: a missing goal-auditor is reported as SETUP, not as a failed audit", async () => {
  const f = fake({ auditorInstalled: false });
  const out = await doProposeLoopGoal(f.deps, { goal: GOAL }, uiCtx(f), undefined);
  assert.equal(out.isError, true);
  assert.equal(f.auditRuns, 0, "there is nothing to dispatch");
  assert.deepEqual(f.surfaces, [], "and nothing to show the user");
  assert.match(out.content[0]!.text, /goal-auditor/);
});

test("propose: the user's rejection carries their reason back, and nothing is written", async () => {
  const f = fake({ approve: false, rejectReason: "退出条件 3 不可检查" });
  await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
  const out = await doProposeLoopGoal(f.deps, { goal: GOAL }, uiCtx(f), undefined);
  assert.equal(out.details?.approved, false);
  assert.equal(out.details?.reason, "退出条件 3 不可检查");
  assert.match(out.content[0]!.text, /did NOT approve this goal/);
  assert.match(out.content[0]!.text, /退出条件 3 不可检查/);
  assert.deepEqual(f.written, []);
  assert.equal(f.st.loopGoal, undefined, "a rejected goal is not recorded as approved");
});

test("propose: the ORCHESTRATOR's decline reason (channel) is used as the rejection reason", async () => {
  // The PM answered the goal dialog through the channel with a reason; the
  // child's local input box is NOT consulted (the PM cannot see it).
  const f = fake({ approve: false, rejectReason: undefined });
  await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
  // Simulate the channel answer carrying a reason: the extension's askEitherSide
  // returns the full outcome, so make the fake's askEitherSide inject it.
  f.deps.askEitherSide = async () => ({ answer: "不认可，退回重谈", by: "orchestrator", requestId: "r1", reason: "验收标准 4 不可机械检查" });
  const out = await doProposeLoopGoal(f.deps, { goal: GOAL }, uiCtx(f), undefined);
  assert.equal(out.details?.approved, false);
  assert.equal(out.details?.reason, "验收标准 4 不可机械检查", "the channel reason is the objection the agent renegotiates against");
  assert.match(out.content[0]!.text, /验收标准 4 不可机械检查/);
});

test("propose: a file the gate cannot write means the approval was NOT recorded", async () => {
  const f = fake({ writeFails: true });
  await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
  const out = await doProposeLoopGoal(f.deps, { goal: GOAL }, uiCtx(f), undefined);
  assert.equal(out.isError, true);
  assert.equal(out.details?.approved, false);
  assert.match(out.content[0]!.text, /could not write \.pi\/loop-goal\.md \(EACCES\)/);
  assert.match(out.content[0]!.text, /approval was NOT recorded/);
  assert.equal(f.st.loopGoal, undefined);
});

test("propose: an empty or over-long draft is refused before anything else happens", async () => {
  const f = fake();
  const empty = await doProposeLoopGoal(f.deps, { goal: "  " }, uiCtx(f), undefined);
  assert.equal(empty.isError, true);
  assert.equal(empty.details?.approved, false);
  const huge = await doProposeLoopGoal(
    f.deps, { goal: "# 目标\n" + "卡".repeat(LOOP_GOAL_MAX_WRITE_CHARS) }, uiCtx(f), undefined,
  );
  assert.equal(huge.isError, true);
  assert.deepEqual(f.surfaces, [], "neither an audit nor a dialog may be reached");
});

// ---------------------------------------------------------------------------
// registerGoalTools — ONE tool, one host, one entry point

// ---------------------------------------------------------------------------
// L8a — the restatement precondition (2026-09-06)

/** The confirmed restatement a loop-mode goal submission needs. */
function confirmedRestatement(station: DeliveryStation = "precommit"): RestatementRecord {
  const text = [
    "1. 这件事是什么：把需求反述做成谈 goal 之前的前置步骤。",
    "2. 举个例子：子会话读完代码先反述，用户确认后才谈 goal。",
    "3. 改之前：propose_loop_goal 只要审计过就能问用户。",
    "4. 改之后：没有已确认的反述就直接被拒，一个框都不弹。",
    "5. 哪几步会变得不同：谈 goal 前多一步 propose_restatement。",
  ].join("\n");
  return { text, hash: restatementHash(text), at: "2026-09-06T00:00:00.000Z", station };
}

test("L8a: in LOOP mode, no confirmed restatement ⇒ refused with NO dialog and NO audit", async () => {
  const f = fake();
  f.st.taskMode = "loop";
  const out = await doProposeLoopGoal(f.deps, { goal: GOAL }, uiCtx(f), undefined);
  assert.equal(out.isError, true);
  assert.equal(out.details?.approved, false);
  assert.equal(out.details?.restated, false);
  assert.deepEqual(f.surfaces, [],
    "the refusal costs the user nothing — no transcript echo, no dialog, and no minutes-long audit");
  assert.equal(f.auditRuns, 0);
  assert.deepEqual(f.written, []);
  // Self-rescuing: the refusal names the step and the appeal route.
  assert.match(out.content[0]!.text, /propose_restatement/);
  assert.match(out.content[0]!.text, /request_arbitration/);
});

test("L8a: a broken restatement record (hash ≠ text) is treated as none at all", async () => {
  const f = fake();
  f.st.taskMode = "loop";
  f.st.restatement = { ...confirmedRestatement(), hash: "0".repeat(64) };
  const out = await doProposeLoopGoal(f.deps, { goal: GOAL }, uiCtx(f), undefined);
  assert.equal(out.details?.restated, false, "a record that cannot prove itself is not a confirmation");
  assert.deepEqual(f.surfaces, []);
});

test("L8a: it is SCOPE, not a gate — explore/normal sessions are not asked to restate", async () => {
  for (const mode of ["explore", "normal"] as const) {
    const f = fake();
    f.st.taskMode = mode;
    f.deps.runGoalAudit = async () => {
      f.auditRuns += 1;
      f.surfaces.push("audit");
      await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
      return { ok: true };
    };
    const out = await doProposeLoopGoal(f.deps, { goal: GOAL }, uiCtx(f), undefined);
    assert.equal(out.details?.approved, true, `${mode} mode must still be able to approve a goal`);
  }
});

test("L8a: with a confirmed restatement the goal flows, and its STATION is carried over", async () => {
  const f = fake();
  f.st.taskMode = "loop";
  f.st.restatement = confirmedRestatement("commit");
  await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
  const out = await doProposeLoopGoal(f.deps, { goal: GOAL }, uiCtx(f), undefined);
  assert.equal(out.details?.approved, true);
  assert.equal(out.details?.station, "commit");
  assert.equal(f.st.loopGoal?.station, "commit",
    "the goal inherits the station the user already agreed to; it is not re-asked");
});

test("L8a: an explicit station overrides the restatement's; an unreadable one falls back", async () => {
  const explicit = fake();
  explicit.st.taskMode = "loop";
  explicit.st.restatement = confirmedRestatement("precommit");
  await recordGoalPrereview(explicit.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
  await doProposeLoopGoal(explicit.deps, { goal: GOAL, station: "pr" }, uiCtx(explicit), undefined);
  assert.equal(explicit.st.loopGoal?.station, "pr");

  const typo = fake();
  typo.st.taskMode = "loop";
  typo.st.restatement = confirmedRestatement("commit");
  await recordGoalPrereview(typo.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
  await doProposeLoopGoal(typo.deps, { goal: GOAL, station: "开 PR" }, uiCtx(typo), undefined);
  assert.equal(typo.st.loopGoal?.station, "commit",
    "an unreadable parameter falls back to what the user confirmed, never to something looser");

  const nothing = fake();
  nothing.st.taskMode = "explore";
  await recordGoalPrereview(nothing.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
  await doProposeLoopGoal(nothing.deps, { goal: GOAL }, uiCtx(nothing), undefined);
  assert.equal(nothing.st.loopGoal?.station, "precommit",
    "no restatement and no parameter ⇒ the strictest station");
});

test("L8a: the station the user SEES is the station recorded (both surfaces carry it)", async () => {
  const f = fake();
  f.st.taskMode = "loop";
  f.st.restatement = confirmedRestatement("pr");
  const shown: string[] = [];
  f.deps.showToUser = (_ctx, _lead, body) => { f.surfaces.push("showToUser"); shown.push(body); return true; };
  const dialogs: string[] = [];
  f.deps.confirmBounded = async (_ctx, _title, message) => {
    f.surfaces.push("confirm");
    dialogs.push(message);
    return true;
  };
  await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
  await doProposeLoopGoal(f.deps, { goal: GOAL }, uiCtx(f), undefined);
  assert.match(shown[0] ?? "", /本轮交付站点/, "the transcript names the station");
  assert.match(dialogs[0] ?? "", /本轮交付站点/, "and so does the dialog that binds the approval");
  assert.equal(f.st.loopGoal?.station, "pr");
});


test("registration: the family registers propose_loop_goal and NOTHING else", () => {
  const f = fake();
  const names: string[] = [];
  const host: ToolHost = { registerTool: (definition) => { names.push(definition.name); } };
  registerGoalTools(host, f.deps);
  // The audit recorder is a plain function now (2026-09-04): it is not on the
  // agent's surface and not on an internal one either, so there is exactly one
  // way to reach the goal contract.
  assert.deepEqual(names, ["propose_loop_goal"]);
});

test("registration: the tool accepts no agent-attested verdict or approval", () => {
  const f = fake();
  const specs = new Map<string, { description: string; parameters: { properties?: Record<string, unknown> } }>();
  const host: ToolHost = {
    registerTool: (definition) => {
      specs.set(definition.name, definition as unknown as {
        description: string;
        parameters: { properties?: Record<string, unknown> };
      });
    },
  };
  registerGoalTools(host, f.deps);
  const propose = specs.get("propose_loop_goal")!;
  assert.deepEqual(
    Object.keys(propose.parameters.properties ?? {}).sort(),
    ["goal", "repo", "station"],
    // `station` (2026-09-06) says where the round STOPS — it grants nothing:
    // an unreadable value is read as the strictest station, and the user is
    // shown the value in the dialog that approves the goal.
    "no `confirmed`/`passed`/`verdict`/`hash` parameter — that would be self-approval",
  );
  assert.match(propose.description, /goal-auditor/, "the agent-facing tool names the audit it runs");
});

test("registration: the tool dispatches to its handler, not to a copy of the logic", async () => {
  const f = fake();
  const tools = new Map<string, (params: Record<string, unknown>, ctx: unknown) => Promise<ToolReply>>();
  const host: ToolHost = {
    registerTool: (definition) => {
      tools.set(definition.name, (params, ctx) => definition.execute("id", params, undefined, undefined, ctx));
    },
  };
  registerGoalTools(host, f.deps);
  await recordGoalPrereview(f.deps, { goal: GOAL, conclusion: AUDITOR_PASS }, {});
  const approved = await tools.get("propose_loop_goal")!({ goal: GOAL }, uiCtx(f));
  assert.equal(approved.details?.approved, true);
  assert.equal(f.auditRuns, 0, "the PASS recorded a moment ago is the one it binds to");
});
