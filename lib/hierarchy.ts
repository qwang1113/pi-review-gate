/**
 * THE HIERARCHY — who opened which judge, and who may touch it.
 *
 * The call chain is strictly top-down (project manager → child session →
 * review, plus the manager's own plan review): whoever opened a judge OWNS
 * it, and anybody else's `wait` / `answer` / `close` / `recover` on it is a
 * cross-level call the gate refuses fail-closed. The refusal lives HERE, not
 * in each tool body, so there is exactly one place that decides what
 * "yours" means.
 *
 * Identity is a plain string on both sides: the opener is the opening
 * session's own id (or its orchestration id when it manages one), the judge
 * is addressed by its judge id (the same deterministic session id the pane
 * resumes by). The extension supplies both through the tool deps; this
 * module only judges the pair.
 *
 * Pure module: the table is a plain record, every function returns a new
 * table or a verdict — no clock, no filesystem, no tmux.
 */

import type { PendingAudit } from "./audit-round.ts";

 /** One judge pane the gate knows about. */
export interface JudgeEntry {
  /** The judge's id — also its pane's resume key. */
  judgeId: string;
  /** Who opened it: a session id or an orchestration id. Never changes. */
  openerId: string;
  /** reviewer | adviser | goal-auditor — informational, not part of the check. */
  role: string;
  /** Repo root the review belongs to. */
  repoRoot: string;
  /** tmux pane id, once the pane exists. */
  paneId?: string;
  /** Current round's findings stream, for the opener's wait receipt. */
  streamPath?: string;
  /** Newest report the opener already recorded — the wait's consumed cursor. */
  lastReportId?: string;
  /**
   * How many streamed findings the opener has already been shown — the
   * message-driven wait's OTHER cursor. Without it the finding that ended one
   * wait would end the next one instantly, and the loop would never advance.
   */
  lastFindingCount?: number;

  /** Round number the opener assigned this review's current round (judge_conclude stamps it on the report; one round concludes once). */
  roundSeq?: number;
  /** ISO timestamp of registration. */
  createdAt: string;
}

/** Opener registry: judge id → entry. */
export type HierarchyTable = Record<string, JudgeEntry>;

/** Empty registry. */
export function emptyHierarchy(): HierarchyTable {
  return {};
}

export type HierarchyVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Register a freshly opened judge.
 *
 * Re-registering the SAME judge id by the SAME opener is allowed (a new
 * round reusing one pane updates the entry); the same judge id claimed by a
 * DIFFERENT opener is refused — two parents for one judge is exactly the
 * cross-level shape this module exists to prevent.
 */
export function registerJudge(
  table: HierarchyTable,
  entry: JudgeEntry,
): { ok: true; table: HierarchyTable } | { ok: false; reason: string } {
  const judgeId = (entry.judgeId ?? "").trim();
  const openerId = (entry.openerId ?? "").trim();
  if (!judgeId) return { ok: false, reason: "judge id 为空，无法登记——这是一个门禁内部错误，请报给维护者。" };
  if (!openerId) return { ok: false, reason: "opener 为空，无法登记——调用者身份不明时不能开 review。" };
  const existing = table[judgeId];
  if (existing && existing.openerId !== openerId) {
    return {
      ok: false,
      reason: `review ${judgeId} 已属于 ${existing.openerId}，不能再登记给 ${openerId}——跨级开 review 被拒绝。`,
    };
  }
  return { ok: true, table: { ...table, [judgeId]: { ...entry, judgeId, openerId } } };
}

/**
 * May this caller operate this judge? The single gate every one of
 * `judge_wait` / `judge_answer` / `judge_close` / `judge_recover` passes
 * before doing anything else.
 *
 * Fail-closed in all three unknown directions: no caller identity, no such
 * judge, or a caller that is not the opener — each is a refusal, never a
 * silent pass.
 */
export function checkCaller(
  table: HierarchyTable,
  judgeId: string,
  callerId: string | undefined,
): HierarchyVerdict {
  const id = (judgeId ?? "").trim();
  const caller = (callerId ?? "").trim();
  if (!caller) {
    return { ok: false, reason: "无法确认调用者身份——身份不明时不能操作任何 review。" };
  }
  if (!id) {
    return { ok: false, reason: "judge id 为空——不知道要操作哪个 review。" };
  }
  const entry = table[id];
  if (!entry) {
    return { ok: false, reason: `review ${id} 不在登记表里——它可能已被回收，或从不是本会话开的。` };
  }
  if (entry.openerId !== caller) {
    return {
      ok: false,
      reason: `review ${id} 属于 ${entry.openerId}，调用者 ${caller} 无权操作——跨级调用被拒绝，只能由 opener 自己操作。`,
    };
  }
  return { ok: true };
}

/** Forget a judge (reclaimed pane, abandoned round). Unknown ids are a no-op. */
export function removeJudge(table: HierarchyTable, judgeId: string): HierarchyTable {
  const id = (judgeId ?? "").trim();
  if (!id || !(id in table)) return table;
  const next = { ...table };
  delete next[id];
  return next;
}

/** Every judge one opener owns — what `declare_done` cascade-closes. */
export function listByOpener(table: HierarchyTable, openerId: string): JudgeEntry[] {
  const opener = (openerId ?? "").trim();
  if (!opener) return [];
  return Object.values(table).filter((entry) => entry.openerId === opener);
}

/** All judge ids one opener owns. */
export function judgeIdsByOpener(table: HierarchyTable, openerId: string): string[] {
  return listByOpener(table, openerId).map((entry) => entry.judgeId);
}

/**
 * One repo's durable slice: its judges plus AT MOST ONE pending audit.
 *
 * One, not one per kind (2026-09-05, user decision): goal and plan audits
 * share a single `goal-auditor` judge per repo, so two of them can never be in
 * flight together. The old two-field shape could represent that impossible
 * state, and the code paid for it with a self-heal branch that guessed which
 * pending to drop. A file still carrying the old `goalAudit` / `planAudit`
 * fields is not read (no compatibility layer, 哲学三): the audit it named
 * simply re-runs, which is the same fail-closed outcome every other miss has.
 */
export interface HierarchySnapshot {
  version: 1;
  judges: Record<string, JudgeEntry>;
  audit?: PendingAudit;
}

function isJudgeEntry(value: unknown): value is JudgeEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.judgeId === "string" && v.judgeId.length > 0 &&
    typeof v.openerId === "string" && v.openerId.length > 0 &&
    typeof v.role === "string" &&
    typeof v.repoRoot === "string" &&
    typeof v.createdAt === "string"
  );
}

/**
 * Parse a persisted snapshot, fail-closed: anything malformed (wrong
 * version, wrong shapes, unparseable JSON) yields undefined and the caller
 * keeps its in-memory table — a corrupt file must never strand live judges.
 */
export function parseHierarchySnapshot(raw: unknown): HierarchySnapshot | undefined {
  try {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value !== "object" || value === null || value.version !== 1) return undefined;
    if (typeof value.judges !== "object" || value.judges === null) return undefined;
    const judges: Record<string, JudgeEntry> = {};
    for (const [id, entry] of Object.entries(value.judges as Record<string, unknown>)) {
      if (isJudgeEntry(entry) && entry.judgeId === id) judges[id] = entry;
    }
    const out: HierarchySnapshot = { version: 1, judges };
    const audit = value.audit as Record<string, unknown> | undefined;
    if (audit && typeof audit.startedAt === "string") {
      if (audit.kind === "goal" && typeof audit.draft === "string") {
        out.audit = { kind: "goal", draft: audit.draft, startedAt: audit.startedAt };
      } else if (
        audit.kind === "plan" &&
        typeof audit.hash === "string" &&
        typeof audit.planText === "string"
      ) {
        out.audit = {
          kind: "plan",
          hash: audit.hash,
          planText: audit.planText,
          startedAt: audit.startedAt,
        };
      }
    }
    return out;
  } catch {
    return undefined;
  }
}
