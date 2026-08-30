/**
 * Judge lifecycle decisions — the pure core behind `judge_submit`.
 *
 * WHY THIS MODULE EXISTS (2026-08-29, "heavy gate, light agent"). Three
 * process facts used to live in the agent's hands: where a judge's session
 * files go, when a judge is done, and whether an audit verdict blocks. Each
 * one cost a measured failure:
 *
 *  - B5: the work dir was derived from the ROUND's title, so every round got
 *    a new `--session-dir` and pi started the "resumed" session from zero.
 *    The dir must be a function of role + repo, exactly like the session id.
 *  - The main session waited on a hand-written bash triple, whose jsonl
 *    criterion could never fire (the fence is escaped inside the transcript).
 *  - B2: a goal audit returning READY with P2 findings sent the agent into a
 *    re-audit loop, because nothing mechanical said "non-blocking means pass".
 *
 * Everything here is a pure function over injected facts: no filesystem, no
 * clock, no process. The extension supplies the observations.
 */

/** Root of the gate's judge session tree, relative to the repo. */
export const JUDGE_SESSIONS_RELDIR = ".pi/judge-sessions";

/** Upper bound for `judge_wait`'s blocking window (goal criterion 1). */
export const JUDGE_WAIT_MAX_TIMEOUT_MS = 10 * 60 * 1000;

/** Default blocking window when the caller does not pick one. */
export const JUDGE_WAIT_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The work dir of one judge role in one repo — STABLE across rounds (B5).
 *
 * Same role + same repo ⇒ same dir ⇒ pi appends to the same transcript when
 * the next round spawns with the same session id. The round's own artifacts
 * (task file, stdout, pid) live under `runs/<ts>/`, which is where the
 * per-round variation belongs; a title never enters the path.
 */
export function judgeWorkDirFor(role: string, repoHash: string): string {
  return `${JUDGE_SESSIONS_RELDIR}/${safePathPart(role)}-${safePathPart(repoHash)}`;
}

/** Directory name for ONE round under `<workDir>/runs/`. */
export function judgeRunDirName(at: Date, rand: string): string {
  return `${at.toISOString().replace(/[:.]/g, "-")}-${safePathPart(rand)}`;
}

/**
 * One path segment, safe by construction: dots are dropped along with every
 * other non-word character, so no input can ever produce a `..` component.
 */
function safePathPart(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "judge";
}

/** What the gate knows about a role before it dispatches a round to it. */
export interface JudgeDispatchSituation {
  /** Is a process of this role still running in this repo? */
  aliveSameRole: boolean;
  /** Did the caller ask to discard the incumbent? */
  fresh: boolean;
  /** Does the role's session dir already hold a transcript? */
  hasTranscript: boolean;
}

export interface JudgeDispatchDecision {
  /**
   * `refuse-busy`  the role is mid-round and CANNOT be handed this one;
   * `kill-and-spawn`  discard the incumbent, then start the round;
   * `spawn`  start the round (continuing the session when one exists).
   */
  action: "refuse-busy" | "kill-and-spawn" | "spawn";
  /** Will this round continue an existing conversation? */
  continuesSession: boolean;
}

/**
 * Decide what dispatching a round to a role means right now.
 *
 * THE RULE THIS ENCODES (round-1 P1): a round is either DELIVERED or REFUSED —
 * never silently dropped. A non-interactive judge reads its task once, at
 * spawn, so a running one cannot receive anything; answering "submitted"
 * there left the agent waiting on a round that was never handed over, and the
 * previous round's exit then looked like this round's completion.
 *
 * Reuse of CONTEXT is a separate question and does not depend on a live
 * process: it comes from the transcript the session id re-opens.
 */
export function decideJudgeDispatch(situation: JudgeDispatchSituation): JudgeDispatchDecision {
  const continuesSession = situation.hasTranscript;
  if (situation.aliveSameRole) {
    return situation.fresh
      ? { action: "kill-and-spawn", continuesSession }
      : { action: "refuse-busy", continuesSession };
  }
  return { action: "spawn", continuesSession };
}


/** What the extension can observe about a running judge round. */
export interface JudgeWaitProbe {
  /** Does the recorded process still exist? */
  processAlive: boolean;
  /** Has the round written its `exit-code` file? */
  exitCodeExists: boolean;
  /** Tail of the round's `stdout.log` (plain text — the fence is NOT escaped here). */
  stdoutTail: string;
}

export type JudgeWaitReason =
  /** The `exit-code` file landed: the session finished and said how. */
  | "exit-code"
  /** The process is gone without an exit-code (crash) — still finished. */
  | "process-gone"
  /** A verdict or question fence is already in stdout, before the exit. */
  | "fence"
  /** None of the three criteria hit yet. */
  | "pending";

export interface JudgeWaitOutcome {
  done: boolean;
  reason: JudgeWaitReason;
}

/**
 * The three independent "this round is over" criteria, in one decision.
 *
 * Any single hit ends the wait. The fence criterion is what makes waiting
 * cheap: a judge that already printed its verdict is done for our purposes
 * even if its process takes another minute to tear down. It reads STDOUT, not
 * the transcript jsonl — inside the jsonl the fence is JSON-escaped, which is
 * why the old grep criterion never fired.
 */
export function evaluateJudgeWait(probe: JudgeWaitProbe): JudgeWaitOutcome {
  if (probe.exitCodeExists) return { done: true, reason: "exit-code" };
  if (!probe.processAlive) return { done: true, reason: "process-gone" };
  if (hasJudgeFence(probe.stdoutTail)) return { done: true, reason: "fence" };
  return { done: false, reason: "pending" };
}

/** A verdict fence (`"gate": "READY"`) or a question fence, in plain text. */
export function hasJudgeFence(text: string): boolean {
  if (!text) return false;
  return /"gate"\s*:\s*"(READY|BLOCKED|NEEDS_HUMAN)"/.test(text) || /"question"\s*:\s*"/.test(text);
}

/** Clamp a caller-supplied wait window into the tool's allowed range. */
export function clampWaitTimeout(requestedMs: number | undefined): number {
  if (typeof requestedMs !== "number" || !Number.isFinite(requestedMs) || requestedMs <= 0) {
    return JUDGE_WAIT_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(requestedMs), JUDGE_WAIT_MAX_TIMEOUT_MS);
}

/**
 * Mechanical wait discipline, returned by `judge_wait` itself (goal criterion
 * 6): blocking is the LAST resort, not the reflex.
 */
export const WAIT_DISCIPLINE_HINT =
  "等待纪律：还有确定性工作（代码/测试/文档/其他 repo 事务）就先做掉，别在这里空等——" +
  "judge 完成会自动唤醒本会话，judge_wait 只用于「确实没有别的可做」时阻塞取结论。";

/** Trailing stdout lines a `judge_wait` reply carries, in either branch. */
export const WAIT_STDOUT_TAIL_LINES = 40;
/** Newest streamed findings a `judge_wait` progress reply carries. */
export const WAIT_FINDINGS_SHOWN = 5;

/** The last `n` lines of `text` (empty stays empty). */
export function tailLines(text: string, n: number): string {
  if (!text) return "";
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.length <= n ? lines.join("\n") : lines.slice(-n).join("\n");
}

/** Everything `judge_wait` knows when its window closes. */
export interface JudgeWaitReport {
  role: string;
  done: boolean;
  reason: JudgeWaitReason;
  /** How long this call actually blocked, in ms. */
  waitedMs: number;
  /** Tail of THIS round's stdout log (raw — the caller does not trim it). */
  stdoutTail: string;
  /** The judge's own conclusion, read once the round is over. */
  conclusion?: { text?: string; hasVerdict: boolean };
  /** The newest findings the judge streamed, one summary line each. */
  findings: readonly string[];
}

/**
 * What `judge_wait` RETURNS (user decision 6.2) — the final tool result, which
 * is a different channel from the live `onUpdate` progress: the progress
 * snapshots are for the human watching the call, this text is what the agent
 * reads afterwards, so neither replaces the other.
 *
 *  - round over  ⇒ the conclusion PLUS the stdout tail (the conclusion alone
 *    hides a judge that died mid-sentence, or answered outside a fence);
 *  - still running / timed out ⇒ the CURRENT progress: the same stdout tail
 *    plus the newest streamed findings, so a caller that gave up waiting still
 *    leaves with what the judge has produced so far — not just "not done yet".
 */
export function formatJudgeWaitReply(report: JudgeWaitReport): string {
  const tail = tailLines(report.stdoutTail, WAIT_STDOUT_TAIL_LINES);
  const parts: string[] = [
    report.done
      ? `review-gate: ${report.role} 本轮已结束（判据：${report.reason}）。`
      : `review-gate: ${report.role} 仍在运行（等待 ${Math.round(report.waitedMs / 1000)}s 未命中任一判据）。`,
  ];
  if (report.done) {
    parts.push(
      report.conclusion?.text
        ? `--- 结论（${report.conclusion.hasVerdict ? "含 verdict fence" : "无 fence，可能只是收尾语"}）---\n${report.conclusion.text}`
        : "--- 该会话没有留下结论文本 ---",
    );
  }
  parts.push(tail
    ? `--- stdout 尾部（最后 ${WAIT_STDOUT_TAIL_LINES} 行）---\n${tail}`
    : "--- stdout 尚无输出 ---");
  if (!report.done) {
    const shown = report.findings.slice(-WAIT_FINDINGS_SHOWN);
    parts.push(shown.length
      ? `--- findings 最近 ${shown.length} 条 ---\n${shown.join("\n")}`
      : "--- findings 流暂无内容 ---");
  }
  parts.push(WAIT_DISCIPLINE_HINT);
  return parts.join("\n");
}

/** One finding as a judge wrote it. */
export interface SeverityFinding {
  severity: string;
  issue: string;
}

export interface GoalAuditAdjudication {
  /** PASS ⇔ the verdict is READY and no P0/P1 finding is open. */
  pass: boolean;
  blocking: SeverityFinding[];
  nonBlocking: SeverityFinding[];
  /** The mechanical sentence the agent reads — it decides, not the agent. */
  message: string;
}

/**
 * Adjudicate a goal audit — the mechanical answer to B2 ("whack-a-mole").
 *
 * The rule is one line: only P0/P1 block. A READY carrying P2/Nit findings is
 * a PASS, and the message says so in the imperative, because the failure mode
 * was never the parser — it was an agent that saw a non-empty `findings` array
 * and volunteered another audit round.
 */
export function adjudicateGoalAudit(input: {
  verdict: "READY" | "BLOCKED" | "NEEDS_HUMAN";
  findings: SeverityFinding[];
  round: number;
}): GoalAuditAdjudication {
  const blocking = input.findings.filter((f) => isBlockingSeverity(f.severity));
  const nonBlocking = input.findings.filter((f) => !isBlockingSeverity(f.severity));
  const pass = input.verdict === "READY" && blocking.length === 0;
  const round = `第 ${Math.max(1, Math.floor(input.round))} 轮审计`;
  const message = pass
    ? `PASS（${round}）—— 含 ${nonBlocking.length} 条非阻塞 findings，只有 P0/P1 阻塞；` +
      "禁止仅因非阻塞 findings 再审一轮。可直接 propose_loop_goal；非阻塞意见按需一次吸收。"
    : `BLOCKED（${round}）—— ${blocking.length} 条阻塞 findings（P0/P1）必须先修，` +
      `另有 ${nonBlocking.length} 条非阻塞项。修完再审，改后的文本需要它自己的 PASS。`;
  return { pass, blocking, nonBlocking, message };
}

/** P0/P1 block; everything else (P2, Nit, prose) is advice. */
export function isBlockingSeverity(severity: string): boolean {
  return /^P[01]\b/i.test(severity.trim());
}
