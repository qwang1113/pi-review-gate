/**
 * Polish-gate decision logic (round-18, user ask: B-tier "need a reason +
 * leave a trace").
 *
 * A session that has been PASSING for a while tends to keep polishing: the
 * reviewer says READY three rounds in a row, the agent keeps "improving" a
 * file that was already accepted, and every round costs a full review. The
 * user chose the middle tier: once the gate is demonstrably met, the NEXT
 * `prepare_review` must carry an explicit `reason` saying why this round is
 * worth it — otherwise it is refused. The reason is persisted and shown to the
 * NEXT reviewer, so a round that exists only because the agent wanted another
 * round is visible to the independent judge.
 *
 * TWO independent triggers (either is enough):
 *
 *  1. READY STREAK — the last two RECORDED rounds both verdict READY.
 *     (A READY verdict already implies no unresolved P0/P1 — the verdict
 *     parser downgrades READY-with-P0/P1 to BLOCKED — so the streak is the
 *     whole condition.)
 *
 *  2. FILE POLISH — the SAME file shows up in P2/Nit findings in three
 *     consecutive recorded rounds (counted by finding severity + file, never
 *     by code-line volume). A round where the file has no P2/Nit finding, or
 *     where the file itself carries a P0/P1 finding, resets that file's
 *     counter to zero.
 *
 * Pure logic, no I/O: the extension feeds it the recorded rounds and the
 * parsed findings, and it answers "must this round carry a reason?".
 */

import type { RoundRecord } from "./gate-state.ts";

/** Consecutive READY rounds that arm the reason requirement. */
export const READY_STREAK_TRIGGER = 2;

/** Consecutive rounds with the same file in P2/Nit that arm the requirement. */
export const FILE_STREAK_TRIGGER = 3;

/** Severities that count as "worth re-checking" for the file streak. */
const POLISH_SEVERITIES = new Set(["P2", "NIT"]);

export interface PolishTrigger {
  /** True when this round MUST carry a non-empty `reason`. */
  required: boolean;
  /**
   * Human-readable explanation of WHY (shown in the refusal, and in the
   * reviewer task when a reason was supplied).
   */
  why: string;
}

export interface RecordedFindings {
  /** Normalized file paths that had P2/Nit findings this round (may be empty). */
  polishFiles: string[];
  /** Normalized file paths that had P0/P1 findings this round (may be empty). */
  blockingFiles: string[];
}

/**
 * Per-round polish data, derived ONCE at record_review time from the raw
 * reviewer output and attached to the RoundRecord.
 */
export function recordedFindingsFrom(
  findings: ReadonlyArray<{ severity: string; file: string }>,
): RecordedFindings {
  const polish = new Set<string>();
  const blocking = new Set<string>();
  for (const f of findings) {
    const sev = (f.severity ?? "").trim().toUpperCase();
    const file = (f.file ?? "").trim();
    if (!file) continue;
    if (POLISH_SEVERITIES.has(sev)) polish.add(file);
    else if (sev === "P0" || sev === "P1") blocking.add(file);
  }
  return { polishFiles: [...polish], blockingFiles: [...blocking] };
}

/**
 * Count how many CONSECUTIVE rounds (up to `limit`) a file has been polished.
 *
 * Walking the rounds oldest → newest, per file: a round with the file in
 * polishFiles and NOT in blockingFiles advances the count; any other round
 * (no P2/Nit on the file, or the file itself blocked) resets it to zero.
 * The returned map has only files with count >= 1.
 */
export function polishStreaks(
  rounds: readonly RoundRecord[],
  limit: number = FILE_STREAK_TRIGGER,
): Map<string, number> {
  const streaks = new Map<string, number>();
  for (const round of rounds) {
    const polish = round.polishFiles ?? [];
    const blocking = round.blockingFiles ?? [];
    const seen = new Set<string>();
    for (const file of polish) {
      if (blocking.includes(file)) continue; // a P0/P1 on the file resets it
      const next = (streaks.get(file) ?? 0) + 1;
      seen.add(file);
      streaks.set(file, next);
    }
    // Files not polished this round reset — even if they were polished before.
    for (const [file, count] of streaks) {
      if (!seen.has(file)) streaks.set(file, 0);
    }
    // Drop zeroed entries to keep the map small.
    for (const [file, count] of [...streaks]) {
      if (count === 0) streaks.delete(file);
    }
  }
  return streaks;
}

/**
 * Decide whether the NEXT `prepare_review` must carry a reason.
 *
 * `nextRound` is the round number that is about to be recorded (rounds.length
 * + 1), used only for the message; the decision itself is over the RECORDED
 * rounds plus the caller's context.
 */
export function polishReasonRequired(
  rounds: readonly RoundRecord[],
  opts: { readyStreak?: number; fileStreak?: number } = {},
): PolishTrigger {
  const readyTrigger = opts.readyStreak ?? READY_STREAK_TRIGGER;
  const fileTrigger = opts.fileStreak ?? FILE_STREAK_TRIGGER;

  // Trigger 1: READY streak.
  let streak = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const r = rounds[i]!;
    if (r.verdict === "READY") streak++;
    else break;
  }
  if (streak >= readyTrigger) {
    return {
      required: true,
      why:
        `最近连续 ${streak} 个已记录 review round 的 verdict 均为 READY` +
        `（阈值 ${readyTrigger}）——门禁已达标。这一轮必须说明“为什么还值得审”`,
    };
  }

  // Trigger 2: same-file P2/Nit streak.
  const streaks = polishStreaks(rounds, fileTrigger);
  const hit = [...streaks.entries()].find(([, count]) => count >= fileTrigger);
  if (hit) {
    return {
      required: true,
      why:
        `文件 ${hit[0]} 已在连续 ${hit[1]} 个已记录 review round 的 P2/Nit findings 中出现` +
        `（阈值 ${fileTrigger}）——同一文件反复打磨。这一轮必须说明“为什么还值得审”`,
    };
  }

  return { required: false, why: "" };
}
