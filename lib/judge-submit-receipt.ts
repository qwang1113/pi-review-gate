/**
 * THE TWO RECEIPTS `judge_submit` HANDS BACK once its chain ran — the one for a
 * round that dispatched nobody (every judge stage switched off) and the one
 * naming every judge it started. Pure text over the chain's facts; split out of
 * lib/judge-submit-tool.ts (t8, 2026-09-26) so the tool body stays about the dispatch.
 */

import { QUALITY_ROLE } from "./quality-round.ts";

export interface CheckpointFacts {
  sha: string;
  files: string[];
  leftOut: string[];
}

/** One judge the submission started, as it was ACCEPTED. */
export interface AcceptedJudge {
  role: string;
  judgeId: string;
  paneId: string;
  sessionDir: string;
  reused: boolean;
  streamPath?: string;
}

/**
 * A RELEASED STAGE DISPATCHES NOBODY (2026-09-22). No judge stage is due, so
 * there is no pane to open — and the receipt still names what the chain DID do
 * (precommit, the checkpoint), because "nothing was submitted" and "nothing
 * needed submitting" are different facts.
 *
 * Only ever reached with the review stage OFF (quality round P2, 2026-09-22):
 * the ONE thing that hands back `role: null` is `submitForReview` on a released
 * review stage — a session with review off but quality on gets QUALITY_ROLE.
 * So the reviewer line is stated unconditionally.
 */
export function noJudgesReceipt(facts: {
  qualityStageOn: boolean;
  qualityStandingNote: string | undefined;
  skipNote: string | undefined;
  checkpointFacts: CheckpointFacts | undefined;
}) {
  const { qualityStageOn, qualityStandingNote, skipNote, checkpointFacts } = facts;
  return {
    content: [{
      type: "text" as const,
      text: [
        "review-gate: 本轮没有派任何 judge。",
        "- 功能审查 reviewer：环节已关闭 —— ship 时该卡点视为满足。",
        ...(qualityStageOn ? [] : ["- 代码质量审查 quality-auditor：环节已关闭 —— 不派质量轮。"]),
        ...(qualityStandingNote === undefined ? [] : [`- ${qualityStandingNote}`]),
        ...(skipNote === undefined ? [] : [`- 质量轮跳过：${skipNote}`]),
        ...(checkpointFacts === undefined
          ? []
          : [`- checkpoint ${checkpointFacts.sha.slice(0, 12)} 已冻结 ${checkpointFacts.files.length} 个文件。`]),
        // ONLY WHEN THE QUALITY STAGE IS OFF: the review switch is always
        // off here, so the only remaining reason to say “re-open the
        // switches” is a quality stage the user turned off.
        ...(qualityStageOn
          ? []
          : ["要恢复哪个环节，就再调一次 `choose_loop_stages`（用户重新勾选，门禁自己弹框）。"]),
      ].join("\n"),
    }],
    details: {
      submitted: true,
      judges: [],
      // A CONSTANT, BECAUSE THIS BRANCH HAS ONE CAUSE THAT ALWAYS HOLDS
      // (quality round P2, 2026-09-22): the field says “a stage is off”, never
      // “every stage is off”; the quality stage's own state is the prose above.
      stageOff: true,
    },
  };
}

/**
 * THE REPLY NAMES EVERY JUDGE THIS SUBMISSION STARTED (2026-09-16). The
 * parallel path starts two, and naming only the routed one while printing the
 * OTHER's id/pane is how a receipt ends up describing a judge that is not the
 * one it points at. `routed` keeps the detail fields honest for the same
 * reason: they are matched by ROLE, never by position.
 */
export function acceptedReceipt(facts: {
  accepted: AcceptedJudge[];
  dispatchRole: string | null;
  parallelReviewerStarted: boolean;
  skipNote: string | undefined;
  checkpointFacts: CheckpointFacts | undefined;
  streamPath: string | undefined;
}) {
  const { accepted, dispatchRole, parallelReviewerStarted, skipNote, checkpointFacts, streamPath } = facts;
  const routed = accepted.find((a) => a.role === dispatchRole) ?? accepted[accepted.length - 1];
  const lines = [
    `review-gate: 已受理本轮任务 — ${accepted.map((a) => `${a.role}（judge ${a.judgeId}）`).join(" + ")}。`,
    ...accepted.map((a) => `- ${a.role}: pane ${a.paneId} · transcript ${a.sessionDir}`),
    // EVERY JUDGE'S STREAM, MATCHED BY ROLE (B1, 2026-09-18). The text used
    // to name only the ROUTED judge's stream, so the functional reviewer's
    // path — the one the agent fixes findings from while both judges are
    // still working — was nowhere on the receipt nor in `details`.
    ...accepted.flatMap((a) =>
      a.streamPath === undefined ? [] : [`- ${a.role} 的 findings 流（边审边修）: ${a.streamPath}`]),
    // The routing is the gate's, so the gate says which way it went —
    // otherwise "the reviewer is running" and "the quality judge is
    // running beside it" look the same to the agent.
    ...(dispatchRole === QUALITY_ROLE
      ? [
          ...(!parallelReviewerStarted
            // QUALITY ALONE (2026-09-22): the user switched the functional
            // stage off, so the receipt must not promise a reviewer that
            // was never started.
            ? [
                "- 本轮**只**跑质量轮（功能审查环节已关闭，用户设定的环节开关）：质量轮审代码本身" +
                  "（哲学/架构/正确性/性能，再看简洁可读可维护，判定表 `docs/code-quality-rules.md`），" +
                  "外加按开关运行的 precommit。你不需要为这一轮再调 judge_submit；要恢复功能审查，" +
                  "让用户重开开关（`choose_loop_stages`）。",
              ]
            : [
                "- 本轮**同时**跑两个 judge：质量轮（审代码本身：哲学/架构/正确性/性能，再看简洁可读可维护，" +
                  "判定表 `docs/code-quality-rules.md`）与功能轮 reviewer（审需求符合度/测试覆盖/文档同步），" +
                  "外加与它们并行的全量 precommit。你不需要为这一轮再调 judge_submit。",
                "- 谁先判不过由门禁收口：质量轮非 READY ⇒ 终止 reviewer 与 precommit；reviewer 非 READY ⇒ 终止质量轮与 precommit；" +
                  "precommit FAIL ⇒ 只终止 reviewer，质量轮继续。reviewer 先交卷 READY 而质量轮未交卷时，那份 READY 会被**扣下**，等质量轮结论落地再补记。",
              ]),
        ]
      : []),
    ...(skipNote ? [`- 质量轮跳过：${skipNote}`] : []),
    // THE COMMIT THIS ROUND JUDGES, AND WHAT WENT INTO IT (drill F4). The
    // receipt named panes, transcripts and streams but not the reviewed
    // unit itself — the only place the agent looks.
    ...(checkpointFacts === undefined
      ? []
      : [
          `- checkpoint ${checkpointFacts.sha.slice(0, 12)} 已冻结 ${checkpointFacts.files.length} 个文件：` +
            `${checkpointFacts.files.slice(0, 12).join(", ")}${checkpointFacts.files.length > 12 ? " …" : ""}`,
          ...(checkpointFacts.leftOut.length === 0
            ? []
            : [
                `- **未提交（${checkpointFacts.leftOut.length}）**：${checkpointFacts.leftOut.slice(0, 12).join(", ")}` +
                  `${checkpointFacts.leftOut.length > 12 ? " …" : ""}` +
                  " —— 未被 gitignore、也不是本会话用 edit/write 写过的文件；若其中有本轮改动，用它重写一遍再送下一轮。",
              ]),
        ]),
    "- 本轮结束（通道 report 落盘）即完成；门禁会用标准报告唤醒你（结论、证据位置、记录情况、待答问题）。现在别等，先做别的确定性工作。",
  ];
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      submitted: true,
      role: dispatchRole,
      /** Did THIS submission route to the quality judge? (diagnostic) */
      qualityRound: dispatchRole === QUALITY_ROLE,
      /**
       * EVERY judge this submission started, in dispatch order — each with
       * its own `streamPath` when it has one, so `details` carries BOTH
       * streams of a parallel round, not just the routed one.
       */
      judges: accepted,
      ...(checkpointFacts === undefined ? {} : { checkpoint: checkpointFacts }),
      // THE ROUTED JUDGE'S OWN FIELDS, MATCHED BY ROLE (quality round P2,
      // 2026-09-16): position would drift the moment the order changes; the
      // role cannot.
      reused: routed.reused,
      paneId: routed.paneId,
      judgeId: routed.judgeId,
      sessionDir: routed.sessionDir,
      streamPath,
    },
  };
}
