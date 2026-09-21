/**
 * THE ACCEPTANCE ROUND's rules — lib/acceptance-round.ts (2026-09-22).
 *
 * WHAT IS PINNED HERE, and why each half needs its own kind of test:
 *
 *  - the DECISION TABLE is a pure function, so every branch is a table entry
 *    (skip / dispatch / wait / block / pass) with the precedence between them
 *    (a closed gate beats a record; an approved goal clause beats the
 *    contents; "no code" beats everything);
 *  - the GOAL PARSERS are text handling on agent-authored input, so the
 *    fail-closed direction is the assertion: a bare 「本轮无真实验收」 is NOT an
 *    exemption, and a section that does not exist yields undefined instead of
 *    an empty plan the judge would work from;
 *  - the BINDING is checked against a REAL git worktree and the REAL
 *    fingerprint, not a hand-made string: the promise is "an edit un-binds the
 *    READY", and a test that never edits a file cannot fail if that stops
 *    being true.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACCEPTANCE_GATE_ENV,
  ACCEPTANCE_PLAN_HEADING,
  acceptanceDecision,
  acceptanceGateOpen,
  acceptanceGateValue,
  acceptanceProblems,
  buildAcceptanceTask,
  extractAcceptancePlan,
  parseNoAcceptanceDeclaration,
  sanitizeAcceptanceRecord,
  type AcceptanceRecord,
} from "../lib/acceptance-round.ts";
import { computeFingerprint } from "../lib/fingerprint.ts";
import { git } from "./helpers/git.ts";

const AT = "2026-09-22T00:00:00.000Z";

/** A REAL repository: `git` runs, a file is committed, nothing is faked. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-acceptance-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "gate@example.com"]);
  git(dir, ["config", "user.name", "gate"]);
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

/* ───────────────────────────── the gate switch ───────────────────────────── */

test("the gate is OPEN unless the dispatcher wrote exactly 'off'", () => {
  assert.equal(acceptanceGateOpen({}), true, "a standalone session has no variable");
  assert.equal(acceptanceGateOpen({ [ACCEPTANCE_GATE_ENV]: "" }), true);
  assert.equal(acceptanceGateOpen({ [ACCEPTANCE_GATE_ENV]: "on" }), true);
  assert.equal(acceptanceGateOpen({ [ACCEPTANCE_GATE_ENV]: "ON" }), true);
  assert.equal(acceptanceGateOpen({ [ACCEPTANCE_GATE_ENV]: " off " }), false);
});

test("only the plan's LAST task is handed the acceptance gate", () => {
  const plan = {
    deliveryStation: "pr" as const,
    tasks: [{ id: "t1" }, { id: "t2" }, { id: "t3" }],
  };
  assert.equal(acceptanceGateValue(plan, "t3"), "on", "the acceptance task is a POSITION");
  assert.equal(acceptanceGateValue(plan, "t1"), "off");
  assert.equal(acceptanceGateValue(plan, "t2"), "off");
  assert.equal(acceptanceGateValue({ deliveryStation: "pr", tasks: [] }, "t1"), "off", "no plan: nobody accepts");
});

/* ──────────────────────────── the decision table ─────────────────────────── */

test("the decision table, in precedence order", () => {
  const ready: AcceptanceRecord = { status: "READY", verdict: "READY", fingerprint: "fp-1", at: AT };
  const base = { hasCodeChange: true, gateOpen: true, fingerprint: "fp-1", record: ready };
  assert.equal(acceptanceDecision(base).action, "pass", "a READY bound to this content releases it");
  assert.equal(
    acceptanceDecision({ ...base, gateOpen: false }).action,
    "skip",
    "the gate being off beats the record",
  );
  assert.equal(
    acceptanceDecision({ ...base, goalSkipsAcceptance: "只改了文档" }).action,
    "skip",
    "an approved goal clause beats the record too",
  );
  assert.equal(
    acceptanceDecision({ ...base, hasCodeChange: false }).action,
    "skip",
    "nothing to run",
  );
});

test("skip says WHICH kind of not-owed it is, and never blocks", () => {
  const disabled = acceptanceDecision({ hasCodeChange: true, gateOpen: false, fingerprint: "fp" });
  assert.equal(disabled.action === "skip" && disabled.status, "DISABLED");
  assert.deepEqual(acceptanceProblems(disabled), [], "a closed gate produces no completion problem");

  const byGoal = acceptanceDecision({
    hasCodeChange: true,
    gateOpen: true,
    goalSkipsAcceptance: "本轮只改文档",
    fingerprint: "fp",
  });
  assert.equal(byGoal.action === "skip" && byGoal.status, "SKIPPED");
  assert.match(byGoal.reason, /本轮只改文档/);

  const noCode = acceptanceDecision({ hasCodeChange: false, gateOpen: true, fingerprint: "fp" });
  assert.equal(noCode.action === "skip" && noCode.status, "SKIPPED");
});

test("no record or an ARMED record: dispatch; AWAITING: wait unless the pane is gone", () => {
  const base = { hasCodeChange: true, gateOpen: true, fingerprint: "fp-1" };
  assert.equal(acceptanceDecision(base).action, "dispatch");
  assert.equal(
    acceptanceDecision({ ...base, record: { status: "ARMED", at: AT } }).action,
    "dispatch",
  );
  const awaiting: AcceptanceRecord = { status: "AWAITING", at: AT, fingerprint: "fp-1", judgeId: "j-1" };
  assert.equal(acceptanceDecision({ ...base, record: awaiting, roundAlive: true }).action, "wait");
  assert.equal(acceptanceDecision({ ...base, record: awaiting }).action, "wait", "unknown liveness waits");
  assert.equal(
    acceptanceDecision({ ...base, record: awaiting, roundAlive: false }).action,
    "dispatch",
    "a dead pane is not a report coming",
  );
  assert.match(acceptanceProblems(acceptanceDecision({ ...base, record: awaiting }))[0]!, /judge_wait/);
});

test("a settled verdict binds, and the binding is what decides pass or dispatch", () => {
  const base = { hasCodeChange: true, gateOpen: true, fingerprint: "fp-1" };
  const blocked: AcceptanceRecord = { status: "BLOCKED", verdict: "BLOCKED", fingerprint: "fp-1", at: AT, reason: "服务起不来" };
  const blockedNow = acceptanceDecision({ ...base, record: blocked });
  assert.equal(blockedNow.action, "block");
  const problems = acceptanceProblems(blockedNow);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /服务起不来/);
  assert.match(problems[0]!, /findings/);

  assert.equal(
    acceptanceDecision({ ...base, record: blocked, fingerprint: "fp-2" }).action,
    "dispatch",
    "a BLOCKED about old content does not block the new content",
  );
  const ready: AcceptanceRecord = { status: "READY", verdict: "READY", fingerprint: "fp-1", at: AT };
  assert.equal(
    acceptanceDecision({ ...base, record: ready, fingerprint: "fp-2" }).action,
    "dispatch",
    "a READY about old content is stale",
  );
  assert.equal(
    acceptanceDecision({ ...base, record: ready, fingerprint: "" }).action,
    "dispatch",
    "an unreadable fingerprint can never confirm a pass",
  );
  // A SKIPPED/DISABLED record is advice about a state that has since changed:
  // the default branch re-evaluates instead of trusting it.
  assert.equal(
    acceptanceDecision({ ...base, record: { status: "SKIPPED", at: AT } }).action,
    "dispatch",
  );
});

/* ─────────────────────────────── the goal side ───────────────────────────── */

test("the no-acceptance clause is an exemption only WITH a reason", () => {
  assert.deepEqual(
    parseNoAcceptanceDeclaration("真实验收方案：\n  本轮无真实验收（本轮只改文档，没有可运行的东西）\n"),
    { reason: "本轮只改文档，没有可运行的东西" },
    "the parenthesised reason is read out",
  );
  assert.deepEqual(
    parseNoAcceptanceDeclaration("本轮无真实验收：这一轮只动 .md，没有服务可起。"),
    { reason: "这一轮只动 .md，没有服务可起。" },
  );
  assert.equal(parseNoAcceptanceDeclaration("# t\n本轮无真实验收\n"), undefined, "a bare clause is NOT an exemption");
  assert.equal(parseNoAcceptanceDeclaration("# t\n本轮无真实验收（）\n"), undefined, "empty parens are not a reason");
  assert.equal(parseNoAcceptanceDeclaration("# t\n本轮无真实验收（无）\n"), undefined, "a one-character placeholder is not a reason");
  assert.equal(parseNoAcceptanceDeclaration("# t\n本轮有真实验收\n"), undefined);
  // MENTION IS NOT DECLARATION (2026-09-22, quality round P1). The skeleton
  // and every goal that explains this rule carry the phrase, and the first
  // version read BOTH as an exemption — measured on this round's own goal,
  // which would have skipped its own acceptance round.
  assert.equal(
    parseNoAcceptanceDeclaration(
      "真实验收方案（acceptance judge 按它验收；没有东西可验收就写「本轮无真实验收（理由）」—— 那是要用户拍板的豁免）：\n  - 正向真实调用：<…>",
    ),
    undefined,
    "a mention inside another line is not a declaration",
  );
  assert.equal(
    parseNoAcceptanceDeclaration("  - 本轮无真实验收（理由）\n"),
    undefined,
    "the skeleton's unfilled blank is a placeholder, not a reason",
  );
  assert.deepEqual(
    parseNoAcceptanceDeclaration("  - 本轮无真实验收：本轮只改文档，没有可运行的东西。"),
    { reason: "本轮只改文档，没有可运行的东西。" },
    "a bullet PREFIX is stripped; the clause itself must OPEN the line",
  );
  // THE FORM THE SKELETON TEACHES (2026-09-22, quality round P2): the wrapper
  // is one unit, so the reason does not carry its closing paren and colon into
  // the user's approval box and the SKIPPED note.
  assert.deepEqual(
    parseNoAcceptanceDeclaration("本轮无真实验收（理由）：这一个只改 .md，没有服务可起。"),
    { reason: "这一个只改 .md，没有服务可起。" },
    "「（理由）：」 comes off as one wrapper",
  );
  assert.deepEqual(
    parseNoAcceptanceDeclaration("- **本轮无真实验收（理由）**：只改文档。"),
    { reason: "只改文档。" },
    "a bolded, bulleted opener is still the clause opening the line",
  );
});

test("extractAcceptancePlan takes the section verbatim and stops at the next heading", () => {
  const goal = [
    "# 任务",
    "意图：x",
    "真实验收方案：",
    "  - 正向真实调用：起服务，调 /x，期望 200",
    "  - 反向验证：再调 /y 确认没坏",
    "非目标：",
    "  - 不做 z",
  ].join("\n");
  assert.equal(
    extractAcceptancePlan(goal),
    "  - 正向真实调用：起服务，调 /x，期望 200\n  - 反向验证：再调 /y 确认没坏",
  );
  assert.equal(extractAcceptancePlan("# 任务\n退出标准：\n  1. x\n"), undefined, "no section: undefined, never an empty plan");
  assert.equal(extractAcceptancePlan("# 任务\n真实验收方案：\n非目标：\n  - z\n"), undefined, "an empty section is not a plan");
  // THE SECTION IS FOUND BY ITS OPENING LINE (2026-09-22, quality round P1),
  // not by the first mention: criteria that NAME the column come earlier.
  const withMention = [
    "# 任务",
    "退出标准：",
    "  1. `LOOP_GOAL_SKELETON` 含「真实验收方案」段。",
    "真实验收方案：",
    "  - 正向真实调用：起服务，调 /x，期望 200",
    "非目标：",
  ].join("\n");
  assert.equal(
    extractAcceptancePlan(withMention),
    "  - 正向真实调用：起服务，调 /x，期望 200",
    "a mention in the criteria does not become the plan",
  );
  // MARKDOWN DECORATION IS NOT A DIFFERENT LINE (2026-09-22, quality round
  // P2): a section written as a heading or in bold is the same section, and
  // returning undefined would leave the judge without the plan it was told to
  // work from.
  for (const heading of ["## 真实验收方案：", "**真实验收方案**：", "- 真实验收方案："]) {
    assert.equal(
      extractAcceptancePlan(`# 任务\n${heading}\n  - 正向真实调用：起服务\n非目标：\n`),
      "  - 正向真实调用：起服务",
      `${heading} opens the section too`,
    );
  }
  // A NESTED SUB-HEAD IS NOT A SECTION (reviewer P2, 2026-09-22). The
  // skeleton's own acceptance plan is a list of colon-terminated labels, and
  // one of them carrying its content on the NEXT line used to close the
  // section at its own first bullet — the judge was handed no plan at all.
  // Depth is what makes an item nested, so depth is the discriminator.
  const nested = [
    "# 任务",
    "真实验收方案：",
    "  - 正向真实调用：",
    "     起服务，调 /x，期望 200",
    "  - 反向验证：",
    "     再调 /y 确认没坏",
    "非目标：",
    "  - 不做 z",
  ].join("\n");
  assert.equal(
    extractAcceptancePlan(nested),
    "  - 正向真实调用：\n     起服务，调 /x，期望 200\n  - 反向验证：\n     再调 /y 确认没坏",
    "a deeper sub-head keeps the section open — the plan arrives whole",
  );
  // …and a deeper MARKDOWN heading is content for the same reason: it is
  // inside the section, not a new one.
  assert.equal(
    extractAcceptancePlan("# 任务\n真实验收方案：\n  ### 正向真实调用\n     起服务\n非目标：\n", ),
    "  ### 正向真实调用\n     起服务",
  );
});

/* ──────────────────────────── the dispatched task ────────────────────────── */

test("buildAcceptanceTask: gate instructions first, the goal's plan and the range as untrusted data", () => {
  const goal = [
    "# 任务",
    "真实验收方案：",
    "  - 正向真实调用：起 fixture 服务，调 /status，期望 200",
    "  - 环境前提：本机有 curl",
    "非目标：",
    "  - 不做 z",
  ].join("\n");
  const task = buildAcceptanceTask({
    repoRoot: "/repo",
    goalText: goal,
    range: "abc1234..def5678",
    files: ["lib/a.ts", "test/a.test.ts"],
  });
  assert.ok(task.includes(ACCEPTANCE_PLAN_HEADING));
  assert.match(task, /正向真实调用：起 fixture 服务/);
  assert.match(task, /abc1234\.\.def5678/);
  assert.match(task, /lib\/a\.ts/);
  // The gate's own instructions are NOT inside the untrusted region.
  assert.ok(
    task.indexOf("You are acceptance") < task.indexOf("<acceptance_plan>"),
    "instructions come first; agent-authored text is data",
  );
  assert.ok(task.indexOf("<acceptance_plan>") < task.indexOf("<goal_text>"));
});

/* ────────────────────────────── the record shape ─────────────────────────── */

test("sanitizeAcceptanceRecord drops anything it cannot fully trust", () => {
  const good: AcceptanceRecord = {
    status: "BLOCKED",
    verdict: "BLOCKED",
    fingerprint: "fp-1",
    at: AT,
    judgeId: "j-1",
    findingsTotal: 2,
    reason: "两条 P1",
  };
  assert.deepEqual(sanitizeAcceptanceRecord(good), good);
  assert.equal(sanitizeAcceptanceRecord({ ...good, status: "WHAT" }), undefined, "an unknown status is dropped");
  assert.equal(sanitizeAcceptanceRecord({ verdict: "READY" }), undefined, "no status, no record");
  assert.equal(sanitizeAcceptanceRecord({ status: "READY", at: "  " }), undefined);
  assert.equal(sanitizeAcceptanceRecord(null), undefined);
  assert.equal(sanitizeAcceptanceRecord("READY"), undefined);
  // Optional fields are dropped, not defaulted — a zero findingsTotal must not
  // appear out of nowhere.
  assert.deepEqual(
    sanitizeAcceptanceRecord({ status: "READY", at: AT, findingsTotal: -1, fingerprint: "" }),
    { status: "READY", at: AT },
  );
});

/* ─────────────────────── the real worktree, end to end ───────────────────── */

test("against a REAL worktree: armed, then READY binds, then an edit un-binds it", () => {
  const repo = makeRepo();
  try {
    const before = computeFingerprint(repo);
    assert.equal(before.unavailable, false, "the fixture is a real repository");
    // 1. the state a finished round is in before any acceptance ran
    const armed = acceptanceDecision({ hasCodeChange: true, gateOpen: true, fingerprint: before.digest });
    assert.equal(armed.action, "dispatch");
    // 2. the judge concluded READY, bound to THIS content
    const record: AcceptanceRecord = { status: "READY", verdict: "READY", fingerprint: before.digest, at: AT };
    assert.equal(
      acceptanceDecision({ hasCodeChange: true, gateOpen: true, fingerprint: before.digest, record }).action,
      "pass",
    );
    // 3. a REAL edit — the whole promise of the binding, exercised for real
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    const after = computeFingerprint(repo);
    assert.notEqual(after.digest, before.digest, "an edit moves the fingerprint");
    const stale = acceptanceDecision({ hasCodeChange: true, gateOpen: true, fingerprint: after.digest, record });
    assert.equal(stale.action, "dispatch", "the old READY no longer answers for this content");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
