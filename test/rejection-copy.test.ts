/**
 * The refusal renderer — one shape for every "no" the gate says to an agent
 * (user decision, 2026-09-16).
 *
 * WHAT IS PINNED, AND WHY EXACTLY THESE THREE THINGS:
 *  - the SHAPE: a labelled 原因 line and a labelled 下一步 line. The whole
 *    point is that a refused agent never has to guess which half it is holding
 *    ("why" or "what now"), so the labels are asserted literally, in order;
 *  - the ACTORS: `by` is what turns "怎么改" into "谁能解". Every value must
 *    render, and must render DIFFERENTLY — a renderer that collapses them
 *    silently drops the one fact the spec added;
 *  - the CALL SITES: a renderer nobody calls is worth nothing. The six
 *    high-frequency paths an agent actually hits are asserted structurally, so
 *    removing one from the renderer is a red test rather than a quiet drift
 *    back to prose.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRejection, type RejectionActor } from "../lib/rejection-copy.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("buildRejection renders the phenomenon, the reason and the next step — in that order", () => {
  const text = buildRejection({
    what: "judge_submit 被拒 —— task 是空的",
    why: "task 就是这一轮的送审说明，是 reviewer 看到的全部改动上下文。",
    by: "agent",
    next: "写清这轮改了什么、为什么，再调用一次。",
  });
  const lines = text.split("\n");
  assert.equal(lines.length, 3, "the shape is three lines — no blank padding, no extra stanza");
  assert.equal(lines[0], "review-gate: judge_submit 被拒 —— task 是空的");
  assert.equal(lines[1], "原因：task 就是这一轮的送审说明，是 reviewer 看到的全部改动上下文。");
  assert.equal(lines[2], "下一步：你 —— 写清这轮改了什么、为什么，再调用一次。");
});

test("every actor renders, and renders differently (agent / user / gate)", () => {
  const actors: RejectionActor[] = ["agent", "user", "gate"];
  const rendered = actors.map((by) => buildRejection({ what: "现象", why: "原因", by, next: "动作" }));
  assert.equal(new Set(rendered).size, actors.length, "two actors must not render identically");
  assert.match(rendered[0]!, /下一步：你 —— 动作$/);
  assert.match(rendered[1]!, /下一步：用户 —— 动作$/);
  assert.match(rendered[2]!, /下一步：门禁 —— 动作$/);
  // The agent reads Chinese labels; the field names are the CODE's vocabulary
  // and must never leak into the message.
  for (const text of rendered) assert.doesNotMatch(text, /\b(what|why|by|next)\b/);
});

test("a multi-line next step stays INSIDE the third part", () => {
  // Refusals that hand over a recovery path (the restatement skeleton, a
  // `git worktree` command) are multi-line; the labels must still lead.
  const text = buildRejection({
    what: "propose_loop_goal 被拒",
    why: "还没有经用户确认的需求反述。",
    by: "agent",
    next: "照抄这个调用：\npropose_restatement({...})",
  });
  assert.ok(text.startsWith("review-gate: propose_loop_goal 被拒\n原因："));
  assert.ok(text.includes("\n下一步：你 —— 照抄这个调用：\npropose_restatement({...})"));
});

// ---------------------------------------------------------------------------
// The paths an agent actually hits. A refusal renderer that the high-frequency
// refusals never reach is the second copy this module exists to prevent.

test("every high-frequency refusal path renders through buildRejection", () => {
  // [what the path is, file, slice start, slice end]. The call must be INSIDE
  // the slice: `assert.match(src, /buildRejection\()/` would go green from any
  // single call anywhere in the file, which is exactly how the path it claims
  // to cover drifts back to hand-written prose unnoticed. Each end anchor is
  // the next declaration, so the window is the refusal site itself.
  const cases: Array<[string, string, string, string]> = [
    ["ask_user batch not conforming", "lib/user-interaction-tools.ts",
      "export async function doAskUser", "const { questions, dropped: droppedQuestions"],
    ["judge_submit submission refused", "extensions/review-gate.ts",
      'name: "judge_submit"', "const progress = createProgressReporter("],
    ["declare_done refused", "extensions/review-gate.ts",
      "if (problems.length > 0) {", "progress.done("],
    ["goal refused (audit or hash)", "lib/loop-goal.ts",
      "export function buildGoalPrereviewRefusal", "export const GOAL_CONFIRM_TITLE"],
    ["goal refused (loop goal not approved: L8 edit block)", "lib/loop-goal.ts",
      "export function loopGoalUnconfirmedEditBlock", "Pure decision behind the L8 edit gate"],
    ["goal / plan refused (no restatement)", "lib/restatement.ts",
      "export function buildRestatementMissingRefusal", "the consent surfaces"],
    ["edit/write blocked (sensitive file)", "lib/ship-gate-edit-guard.ts",
      "export function sensitiveEditBlock", "export async function evaluateEditCall"],
    ["edit/write blocked (no path)", "lib/ship-gate-edit-guard.ts",
      "export async function evaluateEditCall", "const absPath = path ? normalizeSensitivePath"],
    ["edit/write blocked (worktree held by a peer)", "lib/session-exclusivity.ts",
      "function refusalText", "Last path segment"],
    ["ship command blocked", "lib/ship-gate-bash.ts",
      "export function buildShipBlockReason", "export async function evaluateShipCommand"],
  ];
  for (const [label, file, from, to] of cases) {
    const src = readFileSync(join(ROOT, file), "utf8");
    const start = src.indexOf(from);
    assert.ok(start > 0, `${label}: the start anchor is gone from ${file} — fix the anchor, do not delete the case`);
    const end = src.indexOf(to, start);
    assert.ok(end > start, `${label}: the end anchor must follow the start anchor in ${file}`);
    assert.match(src.slice(start, end), /\bbuildRejection\(/,
      `${label}: ${file} must render this refusal through the shared renderer`);
  }
});

test("the shape is written in exactly ONE file", () => {
  // `buildRejection` is the only place allowed to WRITE the labelled shape.
  // (Plenty of messages say 下一步 as a sentence — the report a round ends
  // with does, deliberately. What must not exist twice is the renderer.)
  const renderer = readFileSync(join(ROOT, "lib", "rejection-copy.ts"), "utf8");
  assert.match(renderer, /原因：\$\{parts\.why\}/);
  assert.match(renderer, /下一步：\$\{ACTOR_LABEL\[parts\.by\]\} —— \$\{parts\.next\}/);
});
