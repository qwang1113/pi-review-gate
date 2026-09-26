/**
 * THE JUDGE REGISTRY HOST — the opener's table of pane judges, its per-repo
 * persistence, the identity it is keyed by and the model health it carries,
 * moved out of `extensions/review-gate.ts` (t6,
 * wave 2 of the split).
 *
 * The RULES stay in the pure modules — the table's shape and liveness
 * predicate (lib/hierarchy.ts), the cooldown arithmetic (lib/model-health.ts),
 * the round binding (lib/audit-round-report.ts), the reclaim policy
 * (lib/judge-lifecycle.ts). What is here is the session-bound state those
 * rules are applied to, reached through the SessionHost seam.
 *
 * THE DEPS ARE FIXED ON PURPOSE: dispatch, settlement and verdict recording
 * all read this registry, so its surface is the one thing later waves build
 * on — it asks for exactly four facts the session cannot derive here.
 */

import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";

import { channelPathFor, judgeChannelTarget, type ChannelIO } from "./channel-io.ts";
import { HEARTBEAT_STALE_MS, projectChannel, readChannel } from "./channel-projection.ts";
import type { ChannelRecord } from "./channel-records.ts";
import {
  emptyHierarchy,
  judgeLive,
  listByOpener,
  loadHierarchySliceOnce,
  parseHierarchySnapshot,
  tmuxServerFrom,
  type HierarchyTable,
  type JudgeEntry,
} from "./hierarchy.ts";
import { listServerPanes } from "./judge-pane.ts";
import type { TmuxRunner } from "./orchestrator-tmux.ts";
import { selfPaneOwner } from "./orchestrator-pane-decor.ts";
import { readJudgeSideEnv } from "./judge-side.ts";
import { nextRoundSeq } from "./judge-conclude.ts";
import { roundHasReported, type RoundBinding } from "./audit-round-report.ts";
import type { PendingAudit } from "./audit-round-specs.ts";
import { SESSION_STATE_VARIANT } from "./loop-goal-host.ts";
import {
  clearModelFailure,
  modelKeyOf,
  pruneModelHealth,
  recordModelFailure,
  type ModelEvent,
  type ModelHealth,
} from "./model-health.ts";
import { ORCHESTRATION_ID_ENV } from "./orchestration-id.ts";
import { readInheritance } from "./session-inheritance.ts";
import { writeHierarchySlice, type HierarchySlice } from "./judge-hierarchy-store.ts";
import type { SessionHost } from "./session-host.ts";

/** File holding one repo's judges + pendings (under `.pi/`, git-ignored like all gate state). */
export const HIERARCHY_FILENAME = "judge-hierarchy.json";

/** A pane-less foreign entry older than this is not a concurrent spawn. */
const FOREIGN_SPAWN_GRACE_MS = 10 * 60 * 1000;

/** What the registry needs from the session beyond the shared host — fixed. */
export interface JudgeRegistryDeps {
  /** The session's (declaration-carrying) tmux runner — pane liveness only. */
  runTmux: TmuxRunner;
  /** The channel file I/O the whole session shares. */
  channelIO: ChannelIO;
  /** THIS round's report binding for one judge (the settlement's own rule). */
  roundBindingOf(judge: { judgeId: string; role: string; repoRoot: string }): RoundBinding;
  /** When a `copilot_review` call started blocking on GitHub, if it is. */
  copilotWaitSince(): number | undefined;
}

export type JudgeRegistry = ReturnType<typeof createJudgeRegistry>;

export function createJudgeRegistry(host: SessionHost, deps: JudgeRegistryDeps) {
  const { channelIO, roundBindingOf } = deps;
  const runTmux = (argv: readonly string[]) => deps.runTmux(argv);

  /**
   * THE registry of pane judges — one table, `judgeHierarchy` (lib/hierarchy.ts).
   *
   * There used to be two. An in-memory `childSessions` Map held the same facts
   * (id, role, pane, opener, stream) for THIS session's own judges, and every
   * dispatch hand-wrote both; `judgeChildByRole` read the Map while
   * `settleFinishedRounds` read the table, and the audit chain carried a
   * "the registry does not know the judge I just spawned" branch that was
   * nothing but the drift confessing itself. The Map is deleted (哲学三: the
   * new path replaces the old one, no toggle, no compatibility layer).
   *
   * WHAT THE MERGE CHANGED FOR READERS. The Map only ever held judges THIS
   * process opened; the table also holds entries restored from disk and
   * entries belonging to OTHER openers. So every reader that meant "my own
   * judges" now says so explicitly through `ownJudges()` — the filter is not
   * decoration, it is the Map's old scope made mechanical.
   */
  let judgeHierarchy: HierarchyTable = emptyHierarchy();

  /**
   * WHICH MODEL SLOTS ARE BAD, per repo (lib/model-health.ts).
   *
   * Read at every dispatch (the chain head is skipped while it cools down),
   * written when a judge pane reports that its model failed. Persisted in the
   * repo's hierarchy snapshot — the same file that already records which
   * judges exist, and the one file EVERY opener in the repo shares.
   */
  const modelHealthByRoot = new Map<string, ModelHealth>();

  /**
   * THE audit this repo dispatched and has not recorded yet — one per repo.
   *
   * A verdict binds to the CONTENT it judged (a goal to its draft's sha256, a
   * plan to its canonical hash), so the gate has to remember what it sent; the
   * auditor's output alone cannot say what it audited. Goal and plan share one
   * `goal-auditor` judge per repo, so at most one of them can be in flight —
   * which is why this is ONE map and not two (2026-09-05, user decision). The
   * two-map shape could represent a state the system cannot be in, and paid
   * for it with a self-heal branch that guessed which pending to drop.
   */
  const pendingAudits = new Map<string, PendingAudit>();
  /** Repos whose hierarchy slice is already merged this session. */
  const hierarchyLoadedRoots = new Set<string>();
  /** Repos with a hierarchy file on disk (for pruning emptied slices). */
  const hierarchyFileRoots = new Set<string>();
  /**
   * What each repo's FILE held when this session last read or wrote it — the
   * `base` of the three-way merge (lib/judge-hierarchy-store.ts). Only what
   * this session changed since then is written back; everything else is the
   * file's, because other processes in the same checkout write it too.
   */
  const diskBase = new Map<string, HierarchySlice>();

  /**
   * Who THIS session is for opener checks: the orchestration id when this
   * session manages one, else its own session id. Unknown ⇒ fail-closed.
   */
  function callerIdentity(): string | undefined {
    const state = host.state();
    const orch = process.env[ORCHESTRATION_ID_ENV]?.trim();
    if (state.taskMode === "orchestrator" && orch) return orch;
    return state.sessionId ?? undefined;
  }

  /**
   * WHO THIS SESSION IS on a pane border — the `@<owner>` half of every judge
   * pane this session opens (2026-09-18).
   *
   * Read from the session's own facts and never from a tool parameter: the
   * child id it was spawned with (`RG_STATE_VARIANT`), the mode it runs in, and
   * nothing else. It is NOT `callerIdentity()` — that one answers "may I touch
   * this judge" and is an opaque session/orchestration id; this one answers
   * "what should a human read", and an opaque id is exactly what the border
   * must not print.
   */
  function paneOwnerIdentity(): string {
    return selfPaneOwner({
      stateVariant: SESSION_STATE_VARIANT,
      orchestrator: host.state().taskMode === "orchestrator",
    });
  }
  /**
   * The judges THIS session owns — the deleted `childSessions` Map's scope.
   *
   * The merged table is wider than the Map was in two directions, and the two
   * are NOT the same problem:
   *
   *  - OTHER openers' entries (loaded from the shared file). Reading one as
   *    "mine" would let this session cascade-close a live peer's review, so
   *    the opener filter is mandatory, never an optimization.
   *  - MY OWN entries restored from a previous process. Those really are this
   *    opener's judges — but their panes usually died with that process, so
   *    the callers that ask "is a judge RUNNING" filter further through
   *    `ownLiveJudges()`; the ones that ask "what do I own" (cascade-close)
   *    want them, which is how a restart stops stranding panes.
   *
   * Unknown identity yields NOTHING (fail-closed): an unidentifiable session
   * owns no judge, and must not act on one.
   */
  /**
   * EVERY identity whose judges this session is responsible for.
   *
   * Normally one — the orchestration id, or its own session id. A SUCCESSOR
   * adds the identity it replaces (2026-09-14, measured on the loop path): a
   * judge's channel is keyed by `<openerId>/<judgeId>`, so a handover that
   * changes the opener's session id would otherwise strand every judge the
   * predecessor had already dispatched — the round's verdict would land in a
   * channel nobody reads, and the successor would wait forever on a review
   * that had already concluded.
   *
   * Uncertain identity still yields NOTHING (fail-closed): an unidentifiable
   * session owns no judge, and must not act on one.
   */
  function callerIdentities(): string[] {
    const ids: string[] = [];
    const own = callerIdentity();
    if (own) ids.push(own);
    const inherited = readInheritance().predecessorSession;
    if (inherited && !ids.includes(inherited)) ids.push(inherited);
    return ids;
  }

  function ownJudges(): JudgeEntry[] {
    const mine: JudgeEntry[] = [];
    for (const id of callerIdentities()) mine.push(...listByOpener(judgeHierarchy, id));
    return mine;
  }

  /**
   * The panes this session's tmux SERVER has, or undefined when unreadable.
   *
   * SERVER-WIDE since 2026-09-25: a judge is no longer a pane of this window,
   * and asking about the window would answer "none" for every live one — the
   * name says SERVER precisely because the old name (`listOwnWindowPanes`) read
   * as the question it no longer asks (quality round P2).
   */
  function listServerPanesForThisSession(): string[] | undefined {
    try { return listServerPanes((argv) => runTmux(argv)); }
    catch { return undefined; }
  }

  /**
   * Own judges whose pane is not KNOWN to be gone — "is one still running?".
   *
   * The predicate itself is lib/hierarchy.ts's `judgeLive`, shared with the
   * health snapshot so there is ONE answer to that question (哲学二): missing
   * information keeps an entry alive, and a pane id minted by a DIFFERENT tmux
   * server is not comparable at all.
   */
  function ownLiveJudges(): JudgeEntry[] {
    const panes = listServerPanesForThisSession();
    const server = tmuxServerFrom(process.env);
    return ownJudges().filter((e) => judgeLive(e, panes, server));
  }

  /**
   * Is a JUDGE this session dispatched still running, and since when?
   *
   * This is the fact that turns silence into a statement. The gate is the one
   * that opened the judge, so it does not have to infer anything: the pane
   * is in its own registry, and a listed pane id is liveness (probed from
   * its window when it matters).
   *
   * `ownLiveJudges()` and not `ownJudges()`: the registry is now the PERSISTED
   * table, so it also offers back this opener's judges from a previous
   * process, whose panes died with it. Reporting one of those as "a judge is
   * running" would leave the session waiting forever on a pane nobody can
   * answer from — the Map this replaced could not say that because a restart
   * emptied it.
   */
  function activeJudgeWait(): { role: string; since: number } | undefined {
    for (const judge of ownLiveJudges()) {
      // A pane id on record is intent, not liveness: a dead pane stays
      // listed until it is recovered or closed. The channel decides — a
      // report newer than the spawn means this round is over.
      if (judgeRoundReported(judge)) continue;
      const since = Date.parse(judge.spawnedAt);
      return { role: judge.role, since: Number.isFinite(since) ? since : Date.now() };
    }
    // A `copilot_review` call blocking on GitHub is the same kind of fact: a
    // wait the gate itself owns, not a stop.
    const copilotWaitSince = deps.copilotWaitSince();
    if (copilotWaitSince !== undefined) return { role: "copilot", since: copilotWaitSince };
    return undefined;
  }

  /**
   * Has this judge answered the round it is CURRENTLY on?
   *
   * It used to be "a report newer than the pane's spawn", which is the second
   * timestamp comparison the round binding exists to delete — and it was wrong
   * in the ordinary case: the pane outlives the round, so round 1's leftover
   * report is newer than the spawn and made a judge that had just been handed
   * round 2 read as finished (reviewer P2, 2026-09-05). The question is the
   * engine's, so the answer is too.
   */
  function judgeRoundReported(judge: JudgeEntry): boolean {
    try {
      const target = judgeChannelTarget(judge.openerId, judge.judgeId);
      const read = readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home));
      return roundHasReported(
        read.records,
        roundBindingOf({ judgeId: judge.judgeId, role: judge.role, repoRoot: judge.repoRoot }),
        judge.lastReportId,
      );
    } catch {
      return false;
    }
  }

  /** Newest channel activity for one judge, or undefined when unreadable. */
  function channelLastActivity(judge: JudgeEntry): string | undefined {
    try {
      const target = judgeChannelTarget(judge.openerId, judge.judgeId);
      const read = readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home));
      return projectChannel(read.records).lastActivityAt;
    } catch {
      return undefined;
    }
  }

  /**
   * Assign the opener table and persist it — the single funnel for table
   * writes. Returns whether the change reached the file (see
   * `persistJudgeHierarchy`); the table in memory is updated either way.
   */
  function setHierarchy(next: HierarchyTable): boolean {
    judgeHierarchy = next;
    return persistJudgeHierarchy();
  }

  /** Forget this repo's pending audit and persist. */
  function dropAudits(root: string): void {
    pendingAudits.delete(root);
    persistJudgeHierarchy();
  }

  /**
   * Persist judges + pendings, sliced per repo. Restarting must not strand
   * live panes (unaddressable judges) nor fork a second pi onto one session
   * id — the process era's pid-file takeover, reborn as a file per repo.
   *
   * MERGED, NEVER OVERWRITTEN (2026-09-27): the file is shared by every
   * opener in the checkout, so only what THIS session changed since it last
   * saw the file is written back (lib/judge-hierarchy-store.ts). Returns false
   * when some slice could not be written (the lock stayed held by a live
   * peer): the change stays in memory, is still a diff against the old base,
   * and goes out with the next persist. Callers for whom a late write is a
   * failure — a freshly opened judge must be on file before it concludes —
   * act on the false; the rest may ignore it.
   */
  function persistJudgeHierarchy(): boolean {
    const slices = new Map<string, HierarchySlice>();
    const slice = (root: string) => {
      let s = slices.get(root);
      if (!s) { s = { judges: {} }; slices.set(root, s); }
      return s;
    };
    for (const [id, e] of Object.entries(judgeHierarchy)) slice(e.repoRoot).judges[id] = e;
    for (const [root, v] of pendingAudits) slice(root).audit = v;
    // Pruned on the way out, so a dead model id can never be immortal in a file.
    const now = Date.now();
    for (const [root, health] of modelHealthByRoot) {
      const live = pruneModelHealth(health, now);
      if (Object.keys(live).length === 0) modelHealthByRoot.delete(root);
      else slice(root).modelHealth = live;
    }
    for (const root of hierarchyFileRoots) slice(root);
    for (const root of diskBase.keys()) slice(root);
    let allWritten = true;
    for (const [root, mine] of slices) {
      hierarchyFileRoots.add(root);
      const merged = writeHierarchySlice(pathJoin(root, ".pi", HIERARCHY_FILENAME), diskBase.get(root), mine);
      if (!merged) {
        allWritten = false;
        host.log(`review-gate[judge-registry] ${root}/.pi/${HIERARCHY_FILENAME} 没写成（锁被占用或写盘失败）—— 本次改动留在内存里，下次写盘再合并`);
        continue;
      }
      diskBase.set(root, merged);
      // The table now mirrors the file for this repo: peers' entries arrive,
      // entries a peer removed leave. The pending audit is NOT adopted — it is
      // one slot per repo, and a peer's in-flight audit is not this session's.
      for (const [id, e] of Object.entries(judgeHierarchy)) {
        if (e.repoRoot === root && !merged.judges[id]) delete judgeHierarchy[id];
      }
      Object.assign(judgeHierarchy, merged.judges);
      if (merged.modelHealth) modelHealthByRoot.set(root, merged.modelHealth);
      else modelHealthByRoot.delete(root);
    }
    return allWritten;
  }

  /**
   * Merge one repo's durable slice into this session. Memory (this session)
   * wins on conflict; a corrupt file is ignored. Idempotent per root.
   */
  function ensureHierarchyLoaded(root: string): void {
    const snap = loadHierarchySliceOnce(hierarchyLoadedRoots, root, () => {
      try { return readFileSync(pathJoin(root, ".pi", HIERARCHY_FILENAME), "utf8"); } catch { return undefined; }
    });
    if (!snap) return;
    hierarchyFileRoots.add(root);
    diskBase.set(root, {
      judges: { ...snap.judges },
      ...(snap.audit === undefined ? {} : { audit: snap.audit }),
      ...(snap.modelHealth === undefined ? {} : { modelHealth: snap.modelHealth }),
    });
    for (const [id, e] of Object.entries(snap.judges)) {
      if (!judgeHierarchy[id]) judgeHierarchy[id] = e;
    }
    if (!pendingAudits.has(root) && snap.audit) pendingAudits.set(root, snap.audit);
    // Model health is the one thing that must SURVIVE this session: the next
    // dispatch (by this opener or the next session) skips a slot that just
    // failed, which is what makes an in-round rotation stick.
    if (!modelHealthByRoot.has(root) && snap.modelHealth) modelHealthByRoot.set(root, snap.modelHealth);
  }

  /**
   * Re-read the persisted judge table, MERGING IN IDS THIS SESSION HAS NEVER
   * SEEN — the one thing a judge's handover changes under its opener's feet.
   *
   * A judge that runs out of room opens the next generation ITSELF (it owns no
   * registry, but the table is a file in the repo it is already reviewing), and
   * the new session's channel is keyed by the NEW id: without this merge the
   * opener would keep reading the retired session's channel and never see the
   * round's conclusion. Known ids are never overwritten — this session's own
   * rows are newer for every judge IT opened.
   */
  function reloadJudgeHierarchy(root: string): void {
    try {
      const snap = parseHierarchySnapshot(readFileSync(pathJoin(root, ".pi", HIERARCHY_FILENAME), "utf8"));
      if (!snap) return;
      const base = diskBase.get(root) ?? { judges: {} };
      for (const [id, e] of Object.entries(snap.judges)) {
        if (judgeHierarchy[id]) continue;
        judgeHierarchy[id] = e;
        // Adopted as-is from the file, so it is not a change of ours.
        base.judges = { ...base.judges, [id]: e };
      }
      diskBase.set(root, base);
      hierarchyFileRoots.add(root);
    } catch { /* unreadable ⇒ keep what we have */ }
  }

  /** The live (pruned) model health of one repo. */
  function judgeModelHealth(root: string): ModelHealth {
    return pruneModelHealth(modelHealthByRoot.get(root) ?? {}, Date.now());
  }

  /**
   * Remember that one model slot failed in this repo, and persist it.
   *
   * Called when a judge pane reports its own model failure and when the
   * opener's wait ends a round with an exhausted chain — the two facts that
   * decide which slot the NEXT round starts on.
   */
  function recordJudgeModelFailure(root: string, spec: string, error?: string): void {
    modelHealthByRoot.set(root, recordModelFailure(modelHealthByRoot.get(root) ?? {}, spec, Date.now(), error));
    persistJudgeHierarchy();
  }

  /** One model proved itself again (a rotation moved onto it and it ran). */
  function clearJudgeModelFailure(root: string, spec: string): void {
    const next = clearModelFailure(modelHealthByRoot.get(root) ?? {}, spec, Date.now());
    if (Object.keys(next).length === 0) modelHealthByRoot.delete(root);
    else modelHealthByRoot.set(root, next);
    persistJudgeHierarchy();
  }

  /**
   * Read what a pane said about its own models and act on it.
   *
   * The pane cannot write repo state (judge panes report, they do not
   * enforce), so the opener is the one that turns its channel records into a
   * cooldown, a warning and a cursor advance. Called at settle (a round ended)
   * and at dispatch (a round ended badly and nobody settled it — an exhausted
   * chain never produces a report).
   */
  function absorbJudgeModelEvents(root: string, judgeId: string): void {
    const entry = judgeHierarchy[judgeId];
    // NO ENTRY, NO ABSORB (reviewer round 1, 2026-09-10). Without a registry
    // row there is no cursor, and "read the whole channel" would re-record a
    // HISTORICAL failure with a fresh timestamp every time this runs — a
    // cooldown that can never expire. The channel outlives its entries (a close
    // removes the row, the records stay), so the cursor is the only thing that
    // says what has already been acted on; the dispatch seeds it at the
    // channel watermark when it registers a fresh entry.
    if (!entry) return;
    let events: readonly ModelEvent[];
    try {
      const target = judgeChannelTarget(entry.openerId, judgeId);
      events = projectChannel(readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home)).records).modelEvents;
    } catch { return; }
    const fresh = events.slice(entry.lastModelEventCount ?? 0);
    if (fresh.length === 0) return;
    for (const event of fresh) {
      recordJudgeModelFailure(root, event.spec, event.error);
      // A successful switch is proof the destination works; keeping an older
      // failure on record would bench a healthy model for the rest of the TTL.
      if (event.to) clearJudgeModelFailure(root, event.to);
    }
    setHierarchy({ ...judgeHierarchy, [judgeId]: { ...entry, lastModelEventCount: events.length } });
    const lines = fresh.map((event) => {
      const why = event.error ? `（${event.error}）` : "";
      if (!event.exhausted) {
        return `${modelKeyOf(event.spec)} 失败${why} → 切到 ${event.to ? modelKeyOf(event.to) : "?"}`;
      }
      // The per-slot reasons are what make this line actionable — a banner that
      // says only "链上已无可用槽" cannot tell a rate limit from a bad model id.
      const tried = event.tried ?? [];
      const detail = tried.length === 0
        ? ""
        : "：" + tried.map((t) => `${modelKeyOf(t.spec)}（${t.reason}）`).join("、");
      return `${modelKeyOf(event.spec)} 失败${why}，链上已无可用槽${detail}`;
    });
    try { host.ctx()?.ui.notify(`review-gate: judge 模型 fallback —— ${lines.join("；")}`, "warning"); } catch { /* headless */ }
  }

  /**
   * THIS pane's current round number, read from the registry FILE.
   *
   * Deliberately not `judgeHierarchy`: this session's in-memory copy is loaded
   * once and "memory wins on conflict", so it would keep reporting the round
   * the pane opened with while the opener bumps the real one on every
   * dispatch. The inspection observer stamps each action with this, and
   * `judge_conclude` compares it against the round it is concluding — that is
   * what keeps an ABANDONED round's reads from being credited to the next one.
   * Undefined when the file is missing or unreadable (the evidence then
   * carries no round and the comparison cannot refuse anything).
   */
  function judgeCurrentRound(): number | undefined {
    const judgeId = readJudgeSideEnv(process.env)?.judgeId;
    if (!judgeId) return undefined;
    const cwd = host.repos().cwd;
    try {
      const raw = readFileSync(pathJoin(cwd, ".pi", HIERARCHY_FILENAME), "utf8");
      const snap = JSON.parse(raw) as { judges?: Record<string, { roundSeq?: unknown }> };
      const seq = snap?.judges?.[judgeId]?.roundSeq;
      return typeof seq === "number" && Number.isFinite(seq) ? Math.floor(seq) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Drop foreign entries nobody can still be driving: pane dead (or never
   * recorded) AND channel silent past the heartbeat budget. A live pane or a
   * fresh heartbeat keeps the strict refusal — that is a possibly-live peer,
   * which is what the cross-level rule protects. Own entries are never
   * touched; an unreadable pane list touches nothing (missing info never
   * kills). A pane-less entry younger than the spawn grace is kept: it may be
   * a concurrent spawn that has not recorded its pane yet.
   *
   * WHY DROP, NOT ADOPT: judge ids are opener-scoped, so a new opener never
   * shares an id with a dead entry — adopting it would only resurrect a review
   * whose transcript the new session must never read. Dropped entries lose
   * registry protection and their dirs fall to the TTL/legacy reclaim.
   */
  function dropDeadForeignJudges(): void {
    const caller = callerIdentity();
    if (!caller) return;
    const panes = listServerPanesForThisSession();
    let changed = false;
    for (const [id, e] of Object.entries(judgeHierarchy)) {
      if (e.openerId === caller) continue;
      if (e.paneId !== undefined) {
        if (panes === undefined) continue;
        if (panes.includes(e.paneId)) continue;
        if (channelFresh(e)) continue;
      } else if (!foreignSpawnSettled(e)) continue;
      delete judgeHierarchy[id];
      changed = true;
    }
    if (changed) persistJudgeHierarchy();
  }

  /** A pane-less foreign entry counts as settled once older than the grace. */
  function foreignSpawnSettled(e: JudgeEntry): boolean {
    const at = Date.parse(e.spawnedAt ?? "");
    return Number.isFinite(at) && Date.now() - at > FOREIGN_SPAWN_GRACE_MS;
  }

  /**
   * Number this judge's next round: above both the persisted entry and every
   * report already in the channel (a close→spawn keeps the old reports, so the
   * entry alone would restart at 1 and collide with them). Best-effort: an
   * unreadable channel still numbers above the entry.
   */
  function nextJudgeRound(openerId: string, judgeId: string): number {
    let records: ChannelRecord[] = [];
    try {
      const target = judgeChannelTarget(openerId, judgeId);
      records = readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home)).records;
    } catch { /* the entry alone still numbers above */ }
    return nextRoundSeq(judgeHierarchy[judgeId]?.roundSeq, records);
  }

  /** Fresh heartbeat within budget ⇒ someone may still drive this judge. */
  function channelFresh(e: JudgeEntry): boolean {
    try {
      const target = judgeChannelTarget(e.openerId, e.judgeId);
      const read = readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home));
      const last = projectChannel(read.records).lastActivityAt;
      if (!last) return false;
      const at = Date.parse(last);
      return Number.isFinite(at) && Date.now() - at <= HEARTBEAT_STALE_MS;
    } catch {
      return false;
    }
  }

  return {
    /** The current table — READ it through this every time (it is reassigned). */
    judgeHierarchy: (): HierarchyTable => judgeHierarchy,
    pendingAudits,
    setHierarchy,
    dropAudits,
    persistJudgeHierarchy,
    ensureHierarchyLoaded,
    reloadJudgeHierarchy,
    callerIdentity,
    callerIdentities,
    paneOwnerIdentity,
    ownJudges,
    ownLiveJudges,
    listServerPanesForThisSession,
    activeJudgeWait,
    judgeRoundReported,
    channelLastActivity,
    judgeModelHealth,
    absorbJudgeModelEvents,
    judgeCurrentRound,
    dropDeadForeignJudges,
    nextJudgeRound,
  };
}
