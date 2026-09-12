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

import type { PendingAudit } from "./audit-round-specs.ts";
import type { ModelHealth } from "./model-health.ts";

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
  /**
   * Human-facing label for wait receipts and health snapshots.
   *
   * It, `sessionDir` and `spawnedAt` came from the extension's in-memory
   * `childSessions` Map, which held the SAME facts as this table and was
   * hand-written beside it on every dispatch. One registry now (哲学三): the
   * Map is gone, so an entry has to carry everything its readers need.
   */
  title: string;
  /** Directory pi writes this judge's transcript jsonl into (stable per role+repo+opener). */
  sessionDir: string;
  /** tmux pane id, once the pane exists. */
  paneId?: string;
  /**
   * WHICH tmux server issued that pane id (`<socket>,<server pid>` from $TMUX).
   *
   * A pane id is only meaningful inside the server that minted it: after a
   * tmux server restart ids are handed out from `%0` again, so a PERSISTED
   * `%7` can name a completely unrelated pane — a user's editor, say. That
   * did not matter while the registry lived in memory (a restart emptied it);
   * now that the table survives the process, `paneId` alone is not enough to
   * kill by.
   */
  tmuxServer?: string;
  /** Current round's findings stream, for the opener's wait receipt. */
  streamPath?: string;
  /** Newest report the opener already recorded — the wait's consumed cursor. */
  lastReportId?: string;
  /** How many model-failure events this opener has already acted on. */
  lastModelEventCount?: number;
  /**
   * How many streamed findings the opener has already been shown — the
   * message-driven wait's OTHER cursor. Without it the finding that ended one
   * wait would end the next one instantly, and the loop would never advance.
   */
  lastFindingCount?: number;

  /** Round number the opener assigned this review's current round (judge_conclude stamps it on the report; one round concludes once). */
  roundSeq?: number;
  /**
   * When this judge's CURRENT pane/round was registered.
   *
   * ONE timestamp, not two: `childSessions` carried a `spawnedAt` that every
   * dispatch wrote at the same instant as this table's registration time, so
   * the merge keeps the Map's name and drops the duplicate. Readers use it for
   * both jobs it already did — "since when has this judge been running"
   * (activeJudgeWait) and the foreign-spawn grace (foreignSpawnSettled).
   */
  spawnedAt: string;

  /**
   * THE REUSE LANE this judge is running in (lib/judge-rotation.ts): which
   * review object it serves, which generation of that object's transcript, how
   * many rounds have been dispatched under the object, and what the judge last
   * reported about its own context.
   *
   * All four are OPTIONAL, and an entry may legitimately carry none of them:
   * this extension loads from source with no build step, so an entry written
   * by an older opener has no lane at all. A missing lane degrades to "first
   * round of this object" — never to an exception, and never to a guess.
   *
   * `objectId` is the FULL id (a goal/plan content hash). The path and the
   * session id carry only its 8-hex prefix; the lazy release-point comparison
   * is made HERE, against the full value.
   */
  objectId?: string;
  generation?: number;
  /** Rounds DISPATCHED under this object, abandoned ones included. */
  roundsInObject?: number;
  /** The judge's own context reading (percent) at the end of its last round. */
  contextPercent?: number;
  /**
   * The model spec this judge was LAUNCHED on (the slot the dispatch picked).
   *
   * Recorded because "which model actually ran this round" is asked at settle
   * time, when the dispatch's local variable is long gone — and because a
   * rotation mid-round (lib/judge-model-rotation.ts) reports itself against
   * this starting point. Informational: never part of the opener check.
   */
  modelSpec?: string;
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

/**
 * The judge a role is CURRENTLY running in for this opener and repo — the
 * lane lookup behind rotation (lib/judge-rotation.ts).
 *
 * The registry is keyed by judge id, and a judge id now contains its lane, so
 * "the same role's previous transcript" can no longer be found by deriving an
 * id: the previous lane's id is precisely the one this dispatch may be about
 * to stop using. Hence a scan of THIS table rather than a second table —
 * whose only job would have been to answer this one question, and which would
 * then have to be kept true beside this one.
 *
 * Newest wins when several lanes of one role linger (a rotation leaves the
 * old entry in place until the dispatch closes it): `spawnedAt` is an ISO
 * string, so lexicographic order is chronological order.
 */
export function findJudgeLane(
  table: HierarchyTable,
  query: { role: string; repoRoot: string; openerId: string },
): JudgeEntry | undefined {
  const role = (query.role ?? "").trim();
  const repoRoot = (query.repoRoot ?? "").trim();
  const openerId = (query.openerId ?? "").trim();
  if (!role || !repoRoot || !openerId) return undefined;
  let best: JudgeEntry | undefined;
  for (const entry of Object.values(table)) {
    if (entry.role !== role || entry.repoRoot !== repoRoot || entry.openerId !== openerId) continue;
    if (!best || (entry.spawnedAt ?? "") > (best.spawnedAt ?? "")) best = entry;
  }
  return best;
}

/**
 * The tmux server this process talks to, as `<socket>,<server pid>`.
 *
 * `$TMUX` is `<socket path>,<server pid>,<session index>`; the first two
 * fields identify the SERVER, and the third (which session of it we are in)
 * is irrelevant to whether a pane id is comparable. `undefined` outside tmux.
 */
export function tmuxServerFrom(env: NodeJS.ProcessEnv): string | undefined {
  const raw = (env.TMUX ?? "").trim();
  if (!raw) return undefined;
  const [socket, pid] = raw.split(",");
  return socket && pid ? `${socket},${pid}` : undefined;
}

/**
 * Is this judge's pane still running? — for "am I waiting on somebody?".
 *
 * MISSING INFORMATION NEVER KILLS: an unreadable pane list (`panes ===
 * undefined`: no tmux, a failed probe) leaves the entry alive, because
 * reporting a working judge as gone sends its opener off to read a conclusion
 * that does not exist yet. A pane the current server does not list IS gone,
 * and so is an entry minted by a DIFFERENT tmux server — after a restart its
 * id names someone else's pane, which is not this judge under any reading.
 */
export function judgeLive(
  entry: Pick<JudgeEntry, "paneId" | "tmuxServer">,
  panes: readonly string[] | undefined,
  currentServer: string | undefined,
): boolean {
  if (entry.paneId === undefined) return false;
  if (!paneIdComparable(entry, currentServer)) return false;
  return panes === undefined || panes.includes(entry.paneId);
}

/**
 * May the gate CLOSE this pane by its recorded id? — the opposite default.
 *
 * Here missing information must not ACT: killing by a pane id minted by
 * another tmux server would close whatever now holds that number (2026-09-05,
 * adviser P1). An entry whose server is unknown, or that predates the field,
 * is therefore not closable — the caller still drops the entry and reclaims
 * its scratch, it just does not send `kill-pane`.
 */
export function paneClosable(
  entry: Pick<JudgeEntry, "paneId" | "tmuxServer">,
  currentServer: string | undefined,
): boolean {
  if (entry.paneId === undefined) return false;
  if (entry.tmuxServer === undefined || currentServer === undefined) return false;
  return entry.tmuxServer === currentServer;
}

/**
 * Shared by both: can this recorded pane id be compared to live ids at all?
 *
 * Only the KNOWN-DIFFERENT case is a refusal. An entry with no recorded server
 * stays comparable so that "is it live" keeps its never-kill-on-missing-info
 * default; `paneClosable` applies the stricter rule itself.
 */
function paneIdComparable(
  entry: Pick<JudgeEntry, "tmuxServer">,
  currentServer: string | undefined,
): boolean {
  if (entry.tmuxServer === undefined || currentServer === undefined) return true;
  return entry.tmuxServer === currentServer;
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
  /**
   * Which model slots are cooling down in this repo (lib/model-health.ts).
   *
   * It travels with the judge registry because it is the SAME audience: a
   * dispatch needs it to skip a slot that just failed, whoever opened the
   * judge that found out — and the registry file is the one thing every
   * opener in a repo already reads and writes.
   */
  modelHealth?: ModelHealth;
}

/**
 * Is this a COMPLETE entry?
 *
 * Every field the merged registry's readers need is required, `title` /
 * `sessionDir` / `spawnedAt` included: a file written before the merge carries
 * none of them, and half-adopting such an entry would put a judge into the
 * table that the wait receipt, the health snapshot and the cascade-close each
 * read differently. Only the new format is read (哲学三, no compatibility
 * layer) — a dropped entry simply re-runs its round, the same fail-closed
 * outcome every other miss here has.
 */
function isJudgeEntry(value: unknown): value is JudgeEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.judgeId === "string" && v.judgeId.length > 0 &&
    typeof v.openerId === "string" && v.openerId.length > 0 &&
    typeof v.role === "string" &&
    typeof v.repoRoot === "string" &&
    typeof v.title === "string" &&
    typeof v.sessionDir === "string" &&
    typeof v.spawnedAt === "string"
  );
}

/** Parse the persisted model-health map, dropping anything malformed. */
function parseModelHealth(raw: unknown): ModelHealth | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: ModelHealth = {};
  for (const [spec, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.at !== "number" || !Number.isFinite(v.at)) continue;
    out[spec] = { at: v.at, ...(typeof v.error === "string" ? { error: v.error } : {}) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
    const health = parseModelHealth(value.modelHealth);
    if (health) out.modelHealth = health;
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
