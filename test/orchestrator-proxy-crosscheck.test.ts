/**
 * THE PROXY CROSSCHECK (2026-09-06) — a project manager may not rubber-stamp
 * a child's contract.
 *
 * The user's rule is the whole subject of this file: answering a child's goal
 * approval (or its requirement restatement) on their behalf costs one word
 * today, and one word cannot tell "I read the draft and held it against the
 * plan" apart from "I pressed yes". So the gate asks for the comparison and
 * refuses to write an approval without one.
 *
 * What is pinned here, and why each would fail silently otherwise:
 *
 *  - the KEYWORD TABLE is the contract. Every spelling in
 *    `PROXY_CROSSCHECK_TOKENS` is enumerated below: a narrowing edit (dropping
 *    a row, or re-inlining literals into the function) would refuse honest
 *    comparisons over their word choice, and nothing else would notice.
 *  - BOTH topics share one validator. A goal approval and a restatement
 *    confirmation are the same act; two checks would drift.
 *  - DECLINING needs nothing. A manager that cannot say no is worse than one
 *    that rubber-stamps.
 *  - the refusal is SELF-RESCUING and offers no dead-end appeal (this is not
 *    a ship block, so `request_arbitration` cannot hear it at all).
 *  - a station LOOSER than the approved plan's is refused outright: the ship
 *    gate now reads that field, so confirming it would hand a child commands
 *    the user never authorized.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import {
  makeFakeWorld,
  replyText,
  twoTaskPlan,
} from "./helpers/fake-orchestration.ts";
import {
  PROXY_CROSSCHECK_MIN_CHARS,
  PROXY_CROSSCHECK_SKELETON,
  PROXY_CROSSCHECK_TOKENS,
  checkProxyCrosscheck,
  isDecliningProxyAnswer,
} from "../lib/orchestrator-answer-tools.ts";
import { ORCHESTRATOR_DIRECTIVE } from "../lib/orchestrator-directives.ts";

import type { FakeWorld } from "./helpers/fake-orchestration.ts";

/** A comparison that satisfies every rule, for task `t1`. */
const GOOD =
  "任务 t1：文件边界——它要动的文件都在 lib/a/ 之内，与该任务声明的 fileBoundaries 一致；" +
  "任务目标——草稿要做的就是 plan 里 t1 这条；交付站点——它声明的站点与 plan 一致。";

const GOAL_APPROVE = "认可，写入 .pi/loop-goal.md";
const GOAL_REJECT = "不认可，退回重谈";
const RESTATE_APPROVE = "理解正确，可以继续";
const RESTATE_REJECT = "理解有偏差，退回重述";

async function spawnT1(world: FakeWorld): Promise<string> {
  const reply = await world.call("orchestrator_spawn", { taskId: "t1", task: "开工" });
  const id = (reply.details as { childId?: string } | undefined)?.childId;
  assert.ok(id, `spawn must return a childId: ${replyText(reply)}`);
  return id!;
}

// ---------------------------------------------------------------------------
// The validator itself.

test("every spelling in the token table is accepted for its dimension", () => {
  // One canonical spelling per dimension, so each row below is the only
  // variable in its own case.
  const canonical = { boundary: "文件边界", goal: "任务目标", station: "交付站点" } as const;
  for (const { dimension, token } of PROXY_CROSSCHECK_TOKENS) {
    const parts = { ...canonical, [dimension]: token };
    const text =
      `任务 t1：${parts.boundary}——落在声明的范围内，没有越界，判断为一致；` +
      `${parts.goal}——与 plan 里那一条相同，没有跑偏；` +
      `${parts.station}——与 plan 批准的那一个相同。`;
    assert.ok(text.length >= PROXY_CROSSCHECK_MIN_CHARS, `fixture too short for ${token}`);
    const verdict = checkProxyCrosscheck(text, "t1");
    assert.equal(verdict.ok, true, `"${token}" must satisfy the ${dimension} dimension`);
  }
});

test("the table covers all three dimensions, in both Chinese and English", () => {
  const dimensions = new Set(PROXY_CROSSCHECK_TOKENS.map((t) => t.dimension));
  assert.deepEqual([...dimensions].sort(), ["boundary", "goal", "station"]);
  for (const dimension of ["boundary", "goal", "station"] as const) {
    const rows = PROXY_CROSSCHECK_TOKENS.filter((t) => t.dimension === dimension);
    assert.ok(rows.some((r) => /^[\x00-\x7F]+$/.test(r.token)),
      `${dimension} must accept an English spelling too — a manager writing in English is not wrong`);
    assert.ok(rows.some((r) => !/^[\x00-\x7F]+$/.test(r.token)),
      `${dimension} must accept a Chinese spelling`);
  }
});

test("what is missing is reported ITEM BY ITEM, never as a bare verdict", () => {
  const empty = checkProxyCrosscheck("", "t1");
  assert.equal(empty.ok, false);
  const missing = (empty as { missing: string[] }).missing;
  assert.equal(missing.length, 5, "task id + three dimensions + length");
  assert.ok(missing.some((m) => m.includes("t1")));
  assert.ok(missing.some((m) => m.includes("文件边界")));
  assert.ok(missing.some((m) => m.includes("任务目标")));
  assert.ok(missing.some((m) => m.includes("交付站点")));
  assert.ok(missing.some((m) => m.includes(String(PROXY_CROSSCHECK_MIN_CHARS))));

  // A comparison of the WRONG task is not a comparison of this one.
  const otherTask = checkProxyCrosscheck(GOOD, "t2");
  assert.equal(otherTask.ok, false);
  assert.ok((otherTask as { missing: string[] }).missing.some((m) => m.includes("t2")));

  // Long enough, names the task, but says nothing about the station.
  const twoThirds =
    "任务 t1：文件边界看过了，都在 lib/a/ 之内；任务目标也对得上 plan 里那一条，没有跑偏，可以批。".repeat(1);
  const partial = checkProxyCrosscheck(twoThirds, "t1");
  assert.equal(partial.ok, false);
  assert.deepEqual((partial as { missing: string[] }).missing.filter((m) => m.includes("交付站点")).length, 1);
});

test("the SKELETON does not pass when pasted unchanged", () => {
  // Round-1 reviewer P2: the refusal has to be copyable (that is what makes it
  // self-rescuing), but a blank form that satisfies the check is a rubber
  // stamp the gate hands out itself — it names the task, all three dimensions
  // and is long enough.
  const pasted = PROXY_CROSSCHECK_SKELETON.replace(/<taskId>/g, "t1");
  const verdict = checkProxyCrosscheck(pasted, "t1");
  assert.equal(verdict.ok, false, "the empty form must not be an approval");
  const missing = (verdict as { missing: string[] }).missing;
  assert.ok(missing.some((m) => m.includes("占位符")),
    `the refusal must say WHICH part is still blank: ${missing.join(" / ")}`);

  // Filling the blanks in is what makes it pass — the skeleton stays usable.
  assert.equal(checkProxyCrosscheck(GOOD, "t1").ok, true);

  // One unfilled blank is still an unfilled form.
  const halfFilled =
    "任务 t1：文件边界——都在 lib/a/ 之内，与 fileBoundaries 一致；" +
    "任务目标——就是 plan 里 t1 这条，没有跑偏；" +
    "交付站点：<它声明的交付站点与 plan 的 deliveryStation 是否一致——一句判断>";
  assert.equal(checkProxyCrosscheck(halfFilled, "t1").ok, false);
});


test("a decline is recognised in BOTH dialogs' reject rows, and no approve row looks like one", () => {
  assert.equal(isDecliningProxyAnswer(GOAL_REJECT), true);
  assert.equal(isDecliningProxyAnswer(RESTATE_REJECT), true);
  assert.equal(isDecliningProxyAnswer(GOAL_APPROVE), false);
  assert.equal(isDecliningProxyAnswer(RESTATE_APPROVE), false);
});

// ---------------------------------------------------------------------------
// Through the tool.

test("approving a child's GOAL without a crosscheck is refused, with both sides side by side", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childAsks(childId, {
    requestId: "goal-1",
    title: "认可这个 loop goal 吗？",
    options: [GOAL_APPROVE, GOAL_REJECT],
    payload: "# 目标\n只改 lib/a/ 下的东西",
    topic: "goal-approval",
  });

  const refused = await world.call("orchestrator_answer", { childId, answer: GOAL_APPROVE });
  assert.equal(refused.isError, true);
  const text = replyText(refused);
  assert.match(text, /必须给出 `crosscheck` 对照/);
  assert.match(text, /plan 任务 id「t1」/, "it names the exact missing item");
  assert.match(text, /lib\/a\//, "the plan side is quoted");
  assert.match(text, /只改 lib\/a\/ 下的东西/, "…next to the child's own draft");
  assert.ok(text.includes(PROXY_CROSSCHECK_SKELETON), "and the skeleton is there to copy");
  assert.doesNotMatch(text, /request_arbitration/,
    "this is not a ship block — the arbiter would refuse it, so offering it is a dead end");
  // …but "no appeal" must not read as "no way out" (user decision,
  // 2026-09-06). The route that actually works is the one the check never
  // touched: the USER approving in their own dialog, which this constraint was
  // never applied to. A manager that believes the check is wrong has to be
  // able to find it from the refusal alone.
  assert.match(text, /用户本人在他自己那个框里批/,
    "the refusal must name the escape that really exists");
  assert.match(text, /ask_user/, "…and how to reach the user for it");

  assert.equal(world.channelOf(childId).filter((r) => r.kind === "answer").length, 0,
    "nothing may be written into the channel while the approval is refused");
});

test("approving a child's RESTATEMENT goes through the same validator", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childAsks(childId, {
    requestId: "re-1",
    title: "这是 AI 对需求的反述——理解对了吗？",
    options: [RESTATE_APPROVE, RESTATE_REJECT],
    payload: "改之前：门禁不读站点；改之后：超站的 ship 命令被拦。",
    topic: "restatement",
    station: "precommit",
  });

  const refused = await world.call("orchestrator_answer", { childId, answer: RESTATE_APPROVE });
  assert.equal(refused.isError, true);
  assert.match(replyText(refused), /需求反述/, "the refusal says which of the two it is about");
  assert.match(replyText(refused), /必须给出 `crosscheck` 对照/);

  const ok = await world.call("orchestrator_answer", { childId, answer: RESTATE_APPROVE, crosscheck: GOOD });
  assert.equal(ok.isError, undefined, replyText(ok));
  const answers = world.channelOf(childId).filter((r) => r.kind === "answer");
  assert.equal(answers.length, 1, "a crosschecked confirmation is written to the channel");
});

test("DECLINING needs no crosscheck — a manager must always be able to say no", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childAsks(childId, {
    requestId: "goal-1",
    title: "认可这个 loop goal 吗？",
    options: [GOAL_APPROVE, GOAL_REJECT],
    payload: "# 目标",
    topic: "goal-approval",
  });
  const declined = await world.call("orchestrator_answer", {
    childId, answer: GOAL_REJECT, reason: "退出判据 3 不可机械核实",
  });
  assert.equal(declined.isError, undefined, replyText(declined));
  assert.equal(world.channelOf(childId).filter((r) => r.kind === "answer").length, 1);
});

test("a station LOOSER than the approved plan's is refused, a stricter one passes", async () => {
  // The plan the user approved stops at `commit`.
  const plan = { ...twoTaskPlan(), deliveryStation: "commit" as const };
  const world = makeFakeWorld({ plan, approvePlan: true });
  const childId = await spawnT1(world);
  world.childAsks(childId, {
    requestId: "re-wide",
    title: "这是 AI 对需求的反述——理解对了吗？",
    options: [RESTATE_APPROVE, RESTATE_REJECT],
    payload: "改之前 → 改之后",
    topic: "restatement",
    station: "pr",
  });
  const refused = await world.call("orchestrator_answer", { childId, answer: RESTATE_APPROVE, crosscheck: GOOD });
  assert.equal(refused.isError, true);
  const text = replyText(refused);
  assert.match(text, /交付站点是 `pr`/);
  assert.match(text, /plan 站点 `commit`/);
  assert.match(text, /orchestrator_plan/, "the legal route (raise the plan, re-approve) is named");
  assert.equal(world.channelOf(childId).filter((r) => r.kind === "answer").length, 0);

  // The same child asking for a STRICTER station is fine: tightening needs
  // nobody's permission.
  const strict = makeFakeWorld({ plan, approvePlan: true });
  const c2 = await spawnT1(strict);
  strict.childAsks(c2, {
    requestId: "re-strict",
    title: "这是 AI 对需求的反述——理解对了吗？",
    options: [RESTATE_APPROVE, RESTATE_REJECT],
    payload: "改之前 → 改之后",
    topic: "restatement",
    station: "precommit",
  });
  const ok = await strict.call("orchestrator_answer", { childId: c2, answer: RESTATE_APPROVE, crosscheck: GOOD });
  assert.equal(ok.isError, undefined, replyText(ok));
});

test("an ordinary question is untouched: no crosscheck, no station, no new refusal", async () => {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const childId = await spawnT1(world);
  world.childAsks(childId, { requestId: "q-1", title: "选哪个方案？", options: ["A", "B"] });
  const answered = await world.call("orchestrator_answer", { childId, answer: "B" });
  assert.equal(answered.isError, undefined, replyText(answered));
});

// ---------------------------------------------------------------------------
// What the project manager is TOLD. A mechanical requirement the standing
// directive still describes the old way is a requirement the manager walks
// into blind — the same "two stories" failure the gate keeps paying for.

test("the orchestrator's standing directive teaches the crosscheck, not the one-word approval", () => {
  assert.match(ORCHESTRATOR_DIRECTIVE, /crosscheck/,
    "the directive must name the parameter a proxy approval now requires");
  assert.match(ORCHESTRATOR_DIRECTIVE, /文件边界 \/ 任务目标 \/ 交付站点/,
    "…and the three judgements it has to contain");
  assert.match(ORCHESTRATOR_DIRECTIVE, /站点若宽于 plan|宽于 plan/,
    "…and that it may not widen the station on the user's behalf");
  assert.doesNotMatch(
    ORCHESTRATOR_DIRECTIVE,
    /代批它的 goal\*\* \| `orchestrator_answer\(\{ childId, answer \}\)`/,
    "the old 'answer and you are done' row must not survive next to the new rule",
  );
});

test("the directive tells the manager to restate BEFORE submitting the plan", () => {
  // `orchestrator_plan({action:"submit"})` refuses without a confirmed
  // restatement and renders no dialog — a manager that learns this by being
  // refused has already spent a turn on it.
  assert.match(ORCHESTRATOR_DIRECTIVE, /propose_restatement/);
  const restate = ORCHESTRATOR_DIRECTIVE.indexOf("propose_restatement");
  const submit = ORCHESTRATOR_DIRECTIVE.indexOf('action: "submit"');

  assert.ok(restate >= 0 && submit >= 0 && restate < submit,
    "the restatement step must be taught before the submit it gates");
});

