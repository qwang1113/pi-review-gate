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

/**
 * One path segment, safe by construction: dots are dropped along with every
 * other non-word character, so no input can ever produce a `..` component.
 */
function safePathPart(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "judge";
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
 * Mechanical wait discipline: blocking is the LAST resort, not the reflex.
 */
export const WAIT_DISCIPLINE_HINT =
  "等待纪律：还有确定性工作（代码/测试/文档/其他 repo 事务）就先做掉，别在这里空等——" +
  "pane 没有完成信号，完成以 channel report 落盘为准；门禁用标准报告唤醒，阻塞等待只是最后手段。";



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
