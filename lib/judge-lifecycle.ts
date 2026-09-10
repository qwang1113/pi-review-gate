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

import { laneSuffix, shortOpenerHash, type JudgeLane } from "./judge-process.ts";
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
export function judgeWorkDirFor(role: string, repoHash: string, openerId: string, lane?: JudgeLane): string {
  return `${JUDGE_SESSIONS_RELDIR}/${judgeWorkDirBasename(role, repoHash, openerId, lane)}`;
}

/**
 * Basename of the opener-scoped work dir (the reclaim registry compares basenames).
 *
 * The optional LANE is rendered by the same `laneSuffix` the session id uses,
 * so a judge's dir and its transcript id always name the same lane. Omitting
 * it reproduces the pre-lane basename byte for byte.
 */
export function judgeWorkDirBasename(role: string, repoHash: string, openerId: string, lane?: JudgeLane): string {
  return `${safePathPart(role)}-${safePathPart(repoHash)}-${shortOpenerHash(openerId)}${laneSuffix(lane)}`;
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
 * The CURRENT dir shape, in one place: `<role>-<repoHash>-<openerHash>`,
 * optionally followed by a LANE (`-<objectHash>-g<generation>`).
 *
 * The lane tail had to be recognised here the moment rotation started minting
 * it: an unrecognised shape is "not ours", and a rotated-away dir that is not
 * ours would never be reclaimed — "archived in place" would quietly mean
 * "kept forever". Both hashes are 8 hex by construction (`shortRepoHash`,
 * `shortOpenerHash`, `shortObjectId`), so the shape stays fail-closed: only
 * these two forms are ever eligible for deletion.
 */
const CURRENT_JUDGE_DIR_RE = /-([0-9a-f]{8})-([0-9a-f]{8})(?:-([0-9a-f]{8})-g(\d+))?$/;

/**
 * Is this a PRE-OPENER dir (`<role>-<repoHash>` with no opener segment)?
 *
 * New dirs end with TWO trailing `-<8hex>` segments (repo hash + opener hash),
 * plus an optional lane tail; legacy dirs end with exactly ONE. Anything else
 * (e.g. `archive`) is not ours and never qualifies — deletion fail-closed:
 * only recognised shapes are reclaimed.
 */
export function isLegacyJudgeSessionDirName(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  if (CURRENT_JUDGE_DIR_RE.test(base)) return false;
  return /-([0-9a-f]{8})$/.test(base);
}

/**
 * Is this a CURRENT (opener-scoped) dir — `<role>-<repoHash>-<openerHash>`,
 * with or without a rotation lane (`-<objectHash>-g<n>`)?
 *
 * Only these shapes are eligible for TTL reclaim. Anything else that is not
 * legacy (e.g. `archive/`) is not ours and is NEVER reclaimed — deletion
 * fail-closed. A rotated-away lane is reclaimed exactly like any other dir
 * with no live owner: left in place, swept after the TTL.
 */
export function isCurrentJudgeSessionDirName(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  return CURRENT_JUDGE_DIR_RE.test(base);
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

/** The part of a wait's reply this decision reads — reason, and whether it failed. */
export interface RoundWaitReply {
  isError?: boolean | undefined;
  details?: { reason?: unknown } | undefined;
}

/** Reasons that mean the ROUND is over — everything else is a mid-round message. */
const ROUND_ENDING_REASONS = new Set(["report", "pane-dead", "model-exhausted"]);

/**
 * Minimum spacing between two calls of the wait — the anti-spin floor.
 *
 * The waiting tool normally blocks for minutes, so this costs nothing in the
 * healthy case; it exists for the case where it returns instantly, forever.
 */
export const ROUND_WAIT_MIN_GAP_MS = 1_000;


/**
 * Wait for a round to END, on top of a wait that returns on every MESSAGE.
 *
 * WHY BOTH EXIST (P0, 2026-09-05). `judge_wait` is message-driven, which is
 * right for an agent: a streamed finding or a question is exactly what an
 * opener wants the moment it happens. The gate's OWN audit chains are the
 * opposite case — one synchronous call inside `propose_loop_goal` /
 * `orchestrator_plan`, with nobody there to act on a finding, and both treat
 * "anything but a report" as an unfinished audit. Every auditor streams its
 * findings before it concludes, so a message-driven return would have closed
 * the auditor mid-round and made any draft with findings fail closed forever.
 *
 * So this keeps calling the SAME wait (哲学三: never a second waiting loop)
 * until the round really ends. It terminates for three independent reasons:
 * the wait's own cursors mean a given message ends at most one call, the whole
 * sequence shares ONE budget, and — because the first of those belongs to
 * SOMEBODY ELSE — a call that returned instantly is followed by a minimum gap.
 * That last one is not theoretical: if the cursor write is skipped (a judge
 * with no registry entry), the same mid-round message ends every call, and a
 * measured 354k spins burned the budget with a tmux probe and two file reads
 * each (round-2 P2). Liveness must not depend on another module's write.
 */
export async function awaitRoundReport(input: {
  /** One call of the waiting tool, given the window it may block for. */
  wait: (timeoutMs: number) => Promise<RoundWaitReply>;
  now: () => number;
  /** Total budget across all calls (default: the tool's own hard cap). */
  budgetMs?: number;
  /** The caller's ESC. */
  aborted?: () => boolean;
  /** Injectable pause, so a test drives the anti-spin gap without waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Minimum spacing between two calls (default 1s). */
  minGapMs?: number;
}): Promise<RoundWaitReply> {
  const deadline = input.now() + (input.budgetMs ?? JUDGE_WAIT_MAX_TIMEOUT_MS);
  const minGapMs = input.minGapMs ?? ROUND_WAIT_MIN_GAP_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const startedAt = input.now();
    const remaining = deadline - startedAt;
    const reply = await input.wait(Math.max(1_000, remaining));
    const reason = reply.details?.reason;
    if (reply.isError === true) return reply;
    if (typeof reason === "string" && ROUND_ENDING_REASONS.has(reason)) return reply;
    if (input.aborted?.() === true || input.now() >= deadline) return reply;
    const elapsed = input.now() - startedAt;
    if (elapsed < minGapMs) await sleep(minGapMs - elapsed);
  }
}



// (THE wait discipline moved to lib/agent-directives.ts, 2026-09-05: the
// project-manager side needs the SAME three sentences with its own waiting
// tool named, and two copies of a wording is how two of them start drifting.
// `buildWaitDiscipline("judge_wait")` is what used to live here.)





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
