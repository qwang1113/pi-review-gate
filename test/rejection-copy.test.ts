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
import { readFileSync, readdirSync } from "node:fs";
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
  // Every start anchor must be UNIQUE in its file — asserted below, because a
  // repeated anchor silently slices the WRONG window (round-2 quality P1:
  // `if (problems.length > 0) {` matched a model-config notice 5 000 lines
  // above the declare_done refusal and the case went green off judge_submit's
  // calls instead).
  const cases: Array<[string, string, string, string]> = [
    ["ask_user batch not conforming", "lib/user-interaction-tools.ts",
      "export async function doAskUser", "const { questions, trimmedOptions } = checked;"],
    ["judge_submit submission refused", "extensions/review-gate.ts",
      'name: "judge_submit"', "const progress = createProgressReporter("],
    ["declare_done refused", "extensions/review-gate.ts",
      "// ---------- declare_done tool ----------", 'progress.done("全部满足")'],
    ["goal refused (audit or hash)", "lib/loop-goal.ts",
      "export function buildGoalPrereviewRefusal", "export const LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK"],
    ["goal refused (loop goal not approved: L8 edit block)", "lib/loop-goal.ts",
      "export function loopGoalUnconfirmedEditBlock", "Pure decision behind the L8 edit gate"],
    ["goal / plan refused (no restatement)", "lib/restatement.ts",
      "export function buildRestatementMissingRefusal", "the consent surfaces"],
    ["edit/write blocked (sensitive file)", "lib/ship-gate-edit-guard.ts",
      "export function sensitiveEditBlock", "export async function evaluateEditCall"],
    ["edit/write blocked (no path)", "lib/ship-gate-edit-guard.ts",
      "export async function evaluateEditCall", "const absPath = path ? normalizeSensitivePath"],
    // Not one of the six goal-named refusal paths: this is the worktree
    // occupancy refusal raised at session start, and the same text doubles as
    // the L8 edit-block reason (extensions/review-gate.ts).
    ["session start refused (worktree held by a peer)", "lib/session-exclusivity.ts",
      "function refusalText", "Last path segment"],
    ["ship command blocked", "lib/ship-gate-copy.ts",
      "export function buildShipBlockReason", "return { recorded, shown };"],
  ];
  for (const [label, file, from, to] of cases) {
    const src = readFileSync(join(ROOT, file), "utf8");
    const anchors = src.split(from).length - 1;
    assert.equal(anchors, 1,
      `${label}: the start anchor must be UNIQUE in ${file} (found ${anchors}) — a repeated anchor slices the wrong window`);
    const start = src.indexOf(from);
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
  // The NAME promises exclusivity, so the two assertions above are only half of
  // it: they prove the renderer writes the shape correctly and say nothing
  // about a second, hand-rolled copy at a call site (quality round P2,
  // 2026-09-17 — the name was promising a scan that never happened).
  //
  // The pattern is anchored at the START of a line and lets only a quote char
  // precede the label, because legitimate prose CONTAINS these words: a report
  // line `- 下一步：${handOffNote}`, an answer's `（原因：${reason}）`, the
  // recorder's `不选，原因：${reason}`. Banned is a line that BUILDS the shape —
  // in EITHER of the two forms an author actually types: the template literal
  // (`原因：${why}`) and the concatenation (`"原因：" + why`). A label assembled
  // from variables is out of scope; the two above are what a second copy looks
  // like (reviewer Nit, 2026-09-17: the first version matched the template
  // form only, while the assertion claimed to catch any hand-rolled copy).
  const SHAPE = /^\s*[`"']?(原因|下一步)：([`"']\s*\+|\$\{)/m;
  // Self-proof on BOTH banned shapes: a pattern matching only the renderer's
  // own form would let the concatenated copy through.
  assert.match(renderer, SHAPE, "…matches the template literal the renderer writes");
  assert.match("    \"原因：\" + why,", SHAPE, "…and the double-quoted concatenation");
  assert.match("    '下一步：' + next,", SHAPE, "…and the single-quoted one");
  const offenders: string[] = [];
  let scanned = 0;
  for (const dir of ["lib", "extensions"]) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (!name.endsWith(".ts")) continue;
      const rel = `${dir}/${name}`;
      if (rel === "lib/rejection-copy.ts") continue;
      scanned += 1;
      if (SHAPE.test(readFileSync(join(ROOT, dir, name), "utf8"))) offenders.push(rel);
    }
  }
  assert.ok(scanned > 30, `the scan must see the source tree, not an empty listing (saw ${scanned})`);
  assert.deepEqual(offenders, [], "no second file may hand-roll the labelled shape (template literal or concatenation)");
});
