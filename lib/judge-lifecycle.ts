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

import { shortOpenerHash } from "./judge-process.ts";
/** Root of the gate's judge session tree, relative to the repo. */
export const JUDGE_SESSIONS_RELDIR = ".pi/judge-sessions";

/** Upper bound for `judge_wait`'s blocking window (goal criterion 1). */
export const JUDGE_WAIT_MAX_TIMEOUT_MS = 10 * 60 * 1000;

/** Default blocking window when the caller does not pick one. */
export const JUDGE_WAIT_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The work dir of one judge role in one repo in one OPENER session — STABLE across rounds of the same opener (B5).
 *
 * Same role + same repo + same opener ⇒ same dir ⇒ pi appends to the same transcript when
 * the next round spawns with the same session id. A different opener gets a different dir,
 * so its transcript starts fresh and never reads a previous session's files. The round's own
 * artifacts (task file, stdout, pid) live under `runs/<ts>/`, which is where the per-round
 * variation belongs; a title never enters the path.
 */
export function judgeWorkDirFor(role: string, repoHash: string, openerId: string): string {
  return `${JUDGE_SESSIONS_RELDIR}/${judgeWorkDirBasename(role, repoHash, openerId)}`;
}

/** Basename of the opener-scoped work dir (the reclaim registry compares basenames). */
export function judgeWorkDirBasename(role: string, repoHash: string, openerId: string): string {
  return `${safePathPart(role)}-${safePathPart(repoHash)}-${shortOpenerHash(openerId)}`;
}

/**
 * Basename of the PRE-OPENER work dir. RECLAIM GUARD ONLY — never derive a
 * live path from it. It exists so the sweep can protect a possibly-live legacy
 * peer (an old-code session still running) from immediate reclaim.
 */
export function legacyJudgeWorkDirBasename(role: string, repoHash: string): string {
  return `${safePathPart(role)}-${safePathPart(repoHash)}`;
}

/**
 * One path segment, safe by construction: dots are dropped along with every
 * other non-word character, so no input can ever produce a `..` component.
 */
function safePathPart(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "judge";
}

/** Judge session dirs with no known owner older than this are reclaimed. */
export const JUDGE_SESSION_DIR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Is this a PRE-OPENER dir (`<role>-<repoHash>` with no opener segment)?
 *
 * New dirs end with TWO trailing `-<8hex>` segments (repo hash + opener hash);
 * legacy dirs end with exactly ONE. Anything else (e.g. `archive`) is not ours
 * and never qualifies — deletion fail-closed: only recognised shapes are reclaimed.
 */
export function isLegacyJudgeSessionDirName(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  if (/-([0-9a-f]{8})-([0-9a-f]{8})$/.test(base)) return false;
  return /-([0-9a-f]{8})$/.test(base);
}

/**
 * Is this a CURRENT (opener-scoped) dir (`<role>-<repoHash>-<openerHash>`)?
 *
 * Only this shape is eligible for TTL reclaim. Anything else that is not legacy
 * (e.g. `archive/`) is not ours and is NEVER reclaimed — deletion fail-closed.
 */
export function isCurrentJudgeSessionDirName(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  return /-([0-9a-f]{8})-([0-9a-f]{8})$/.test(base);
}

/** One entry of the `.pi/judge-sessions/` listing for the reclaim decision. */
export interface JudgeSessionDirEntry {
  /** Basename of the dir (not the full path). */
  name: string;
  /** Directory mtime, ms since epoch; non-finite means "age unknown". */
  mtimeMs: number;
}

/**
 * Which judge session dirs to reclaim. Pure so the policy is unit-testable:
 *
 *  - a dir the registry still references (any format, possibly a live peer's)
 *    is never reclaimed;
 *  - a legacy (pre-opener) dir nobody references is reclaimed IMMEDIATELY —
 *    a new opener must never read its transcript, so keeping it only risks
 *    cross-session pollution;
 *  - any other CURRENT-FORMAT unreferenced dir is reclaimed once older than the TTL;
 *    anything of unrecognised shape is never reclaimed (fail-closed).
 */
export function selectStaleJudgeSessionDirs(
  entries: ReadonlyArray<JudgeSessionDirEntry>,
  knownNames: ReadonlySet<string>,
  nowMs: number,
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (knownNames.has(entry.name)) continue;
    if (isLegacyJudgeSessionDirName(entry.name)) {
      out.push(entry.name);
      continue;
    }
    if (
      isCurrentJudgeSessionDirName(entry.name) &&
      Number.isFinite(entry.mtimeMs) &&
      nowMs - entry.mtimeMs > JUDGE_SESSION_DIR_TTL_MS
    ) {
      out.push(entry.name);
    }
  }
  return out;
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
