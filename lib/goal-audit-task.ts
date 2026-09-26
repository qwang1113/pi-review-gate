/**
 * The goal-auditor's TASK TEXT — built by the gate, never by the agent.
 *
 * Split out of lib/loop-goal.ts (which keeps the audit RECORD and the pass
 * decision): this module renders a re-audit's carryover, the mechanical
 * draft delta and the complete audit task (dispatched by
 * lib/advisory-prepare-tools.ts).
 */

import { JUDGE_COMPLETION_DISCIPLINE } from "./gate-modes.ts";
import { composeWithUntrustedData } from "./untrusted-data.ts";
import type { GoalPrereviewRecord } from "./loop-goal.ts";

/**
 * The carryover block shown when an audit REPLACES a record for a DIFFERENT
 * draft: the previous verdict and its findings, so the agent can hand them to
 * the auditor on the re-audit (plus what changed since — which only the agent
 * knows). Undefined when there is no previous record at all. A prior audit
 * with zero parsed findings still carries its VERDICT — an unqualified PASS
 * or FAIL is itself a conclusion worth not re-deriving. Pure so the shape is
 * testable.
 */
export function formatGoalPrereviewCarryover(prev: GoalPrereviewRecord): string | undefined {
  const findings = prev.findings ?? [];
  const lines = [
    "Goal-auditor re-audit carryover — the PREVIOUS audit judged a DIFFERENT draft of this goal:",
    `- Previous verdict: ${prev.verdict} (${findings.length} finding(s), ${prev.at}).`,
    ...(findings.length
      ? [
          "- Previous findings, one by one — the revised draft must address each:",
          ...findings.map((f) => `  - ${f.severity}: ${f.issue}`),
        ]
      : ["- The previous audit reported no findings — confirm that still holds."]),
    // The previous draft is AGENT-authored text, so it does NOT ride inside
    // this gate-authored block any more (round 5): buildGoalAuditTask puts it
    // in the untrusted data region, after the instructions.
    ...(prev.draft
      ? ["- The PREVIOUS draft (judged then) is in the <previous_goal_draft> data block below."]
      : []),
    "- Also tell the auditor what changed in the draft since that audit.",
  ];
  return lines.join("\n");
}

/**
 * Line-level diff between two drafts: which lines were removed and which
 * were added (in order, best-effort alignment). Enough to tell a re-auditor
 * mechanically WHAT changed in the draft — the previous draft, its findings
 * and this delta are the whole carryover contract. Pure so it is testable.
 */
export function diffDraftLines(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  const removed: string[] = [];
  const added: string[] = [];
  // Two-pointer scan with a small lookahead for insertions/deletions in the
  // middle of a block — an exact LCS is overkill for drafts a few KB long.
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    // Look ahead: is the next b-line the current a-line (an insertion)?
    if (a[i] === b[j + 1]) { added.push(b[j]!); j++; continue; }
    if (b[j] === a[i + 1]) { removed.push(a[i]!); i++; continue; }
    removed.push(a[i]!);
    added.push(b[j]!);
    i++;
    j++;
  }
  for (; i < a.length; i++) removed.push(a[i]!);
  for (; j < b.length; j++) added.push(b[j]!);
  return { removed, added };
}

/**
 * The ready-made task text for a goal-auditor audit, built by the gate.
 *
 * Goal criterion 2 (mechanically injected re-audit): the gate dispatches the
 * auditor with this COMPLETE task template. The carryover block (previous
 * verdict + findings + previous draft) and the mechanically computed draft
 * delta ride along, so the auditor is told what changed without anyone
 * hand-writing it; the fresh-context transcript pointer is included too.
 * The first audit of a goal (no previous record) gets the plain template.
 */
export function buildGoalAuditTask(
  draft: string,
  opts: {
    carryover?: string;
    prevDraft?: string;
    sessionDir?: string;
    sessionId?: string;
  } = {},
): string {
  // ORDER MATTERS (round 5, 2026-09-05). Everything the GATE wrote comes
  // first; the draft, the previous draft and the mechanical delta — all
  // agent-authored — follow as untrusted data blocks, because a draft that
  // opens the task frames the audit before the auditor has read its job.
  const instructions = [
    "You are goal-auditor. Audit the draft loop goal in the data block below as the exit contract for this session.",
    "",
    "You run in your own tmux pane (same deterministic session id across rounds): your own session, with none of the main",
    "repository and the transcript pointer below.",
    "",
    ...(opts.carryover ? [opts.carryover, ""] : []),
    "审计标准: 退出标准是否可检查(falsifiable)、是否覆盖用户核心诉求、Non-goals 是否明确、有无内部矛盾或与仓库现状冲突的表述。",
    "真实验收方案(P1): 草稿必须写明「真实验收方案」（正向真实调用 / 反向验证 / 环境前提），" +
      "或者写明「本轮无真实验收（理由）」并给出理由；缺这一段、方案不可执行（没有真实的调用与观察，只写「跑测试」之类的话），" +
      "或声明无验收却不给理由是 P1。",
    "最小化检查(引用 `docs/coding-standards.md` Section 5——实质条文只在那里，不在此复述): 用户没要的工作(顺手重构、推测性开关、凑数的验收标准)是 P1；真正需要的多条标准不算多——最小指必要，不指条数少。",
    ...(opts.sessionDir && opts.sessionId
      ? [
          "",
          `You do NOT inherit the main session's conversation — if the audit needs it, read it on demand from ${opts.sessionDir} (file named <timestamp>_${opts.sessionId}.jsonl).`,
        ]
      : []),
    "",
    "以 judge_conclude 交卷(verdict READY|BLOCKED,findings 每条 severity P0|P1|P2 + issue,能给证据就填 evidence):",
    "READY 仅当草稿无未解决 P0/P1 异议。findings 为空表示无异议。本角色的签名里没有 notes 参数,传了会被拒——结论请写进 findings。",
    // Round-17 (user ask), tightened 2026-09-04: the auditor has no prose
    // field at all, so there is nowhere for output beyond the conclude call.
    "输出纪律:交卷即停 —— 调完 judge_conclude 就结束本轮,不写复述、不写自评、不写过程说明。",
    "",
    JUDGE_COMPLETION_DISCIPLINE,
  ].join("\n");
  return composeWithUntrustedData(instructions, [
    { tag: "goal_draft", label: "===== 待审计的 goal 草稿 =====", text: draft },
    ...(opts.prevDraft
      ? [
          {
            tag: "previous_goal_draft",
            label: "===== 上一版草稿（上一轮审计判过的） =====",
            text: opts.prevDraft,
          },
          {
            tag: "goal_draft_delta",
            label: "===== 与上一版草稿的机械差异 (diff vs previous draft) =====",
            text: formatDraftDelta(opts.prevDraft, draft),
          },
        ]
      : []),
  ]);
}

/** The delta block's body: which lines the draft lost and gained. */
function formatDraftDelta(prevDraft: string, draft: string): string {
  const { removed, added } = diffDraftLines(prevDraft, draft);
  const parts: string[] = [];
  if (removed.length) parts.push("Removed lines:", ...removed.map((l) => `  - ${l}`));
  if (added.length) parts.push("Added lines:", ...added.map((l) => `  + ${l}`));
  if (!parts.length) parts.push("(no line-level changes detected)");
  return parts.join("\n");
}
