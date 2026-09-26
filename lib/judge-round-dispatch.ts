/**
 * DISPATCH ONE JUDGE ROUND — the single place a judge process is ever
 * started, moved out of `extensions/review-gate.ts` (t7, wave 3 of the
 * split). The lane it runs in is resolved by lib/judge-lane-host.ts, what it
 * launches on by lib/judge-launch-host.ts, and the registry it writes is
 * lib/judge-registry-host.ts's.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { appendRecord, channelPathFor, judgeChannelTarget, newChannelId, type ChannelIO } from "./channel-io.ts";
import { projectChannel, readChannel } from "./channel-projection.ts";
import { paneCoordsOf, paneIdUsable, registerJudge, removeJudge, tmuxServerFrom } from "./hierarchy.ts";
import type { JudgeLaunch } from "./judge-launch-host.ts";
import type { createJudgeLanes } from "./judge-lane-host.ts";
import { judgeWorkDirFor } from "./judge-lifecycle.ts";
import { judgePaneAlive } from "./judge-pane.ts";
import { judgeSessionIdFor, shortRepoHash } from "./judge-process.ts";
import type { JudgeRegistry } from "./judge-registry-host.ts";
import { rotationHandoffTask } from "./judge-rotation.ts";
import type { LoopStage } from "./loop-stages.ts";
import { channelRecordCount, verifyJudgeBoot } from "./orchestrator-tool-kit.ts";
import type { TmuxRunner } from "./orchestrator-tmux.ts";
import { qualityStandingFor } from "./quality-round.ts";
import type { ReviewTarget } from "./review-target-host.ts";
import { dispatchFailureDetail, type RoundCancelLedger } from "./round-cancel-ledger.ts";
import { buildJudgePaneCommand, judgePaneDecor, openSessionWindow } from "./session-factory.ts";
import type { SessionHost } from "./session-host.ts";
import type { TmuxScope } from "./session-tmux-scope.ts";

/** What one dispatch of a judge round produced (or why it could not). */
export interface JudgeDispatch {
  ok: boolean;
  /** The role's session already had a transcript — this round continues it. */
  reused: boolean;
  sessionId?: string;
  sessionDir?: string;
  /** tmux pane the round lives in (open) or was queued into (reuse). */
  paneId?: string;
  /** Judge id — the hierarchy key and channel file name. */
  judgeId?: string;
  error?: string;
  /**
   * DID THIS ROUND'S TASK REACH ITS JUDGE? — the fact a FAILED dispatch has
   * to carry.
   *
   * Two failures keep a `paneId` and they mean OPPOSITE things (quality round
   * P2, 2026-09-16): a boot-check timeout means the task rode in on the pane's
   * argv and the round is under way (the opener may still wait on it), while a
   * failed channel write into a REUSED pane means the pane is alive and this
   * round's task was never delivered. A caller that decides "is the round
   * running?" from `paneId` alone therefore gets one of the two wrong — and
   * the one it gets wrong leaves a judge working on a round the agent was
   * told had failed. Absent on success (it is `ok`), and NEVER inferred:
   * each failure site says which it is.
   */
  delivered?: boolean;
}

/** Does this role's session dir already hold a transcript to continue? */
export function hasTranscript(sessionDir: string): boolean {
  try {
    return readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false; // no dir yet ⇒ nothing to continue
  }
}

type JudgeLanes = ReturnType<typeof createJudgeLanes>;

export function createJudgeRoundDispatch(
  host: SessionHost,
  deps: {
    registry: Pick<
      JudgeRegistry,
      | "judgeHierarchy"
      | "setHierarchy"
      | "dropAudits"
      | "callerIdentity"
      | "paneOwnerIdentity"
      | "absorbJudgeModelEvents"
      | "nextJudgeRound"
      | "dropDeadForeignJudges"
    >;
    lanes: Pick<JudgeLanes, "resolveJudgeLane" | "rotationCarryoverFacts" | "closeJudgePaneOf" | "reapReviewScratch">;
    reviewTargets: Map<string, ReviewTarget>;
    stageIsOn(stage: LoopStage, root?: string): boolean;
    runTmux: TmuxRunner;
    channelIO: ChannelIO;
    tmuxScope: TmuxScope;
    cancelLedger: RoundCancelLedger;
    resolveJudgeLaunch(root: string, role: string, workDir: string, title: string, judgeId: string): JudgeLaunch;
    sweepStaleJudgeSessionDirs(root: string): void;
  },
) {
  const {
    judgeHierarchy, setHierarchy, dropAudits, callerIdentity, paneOwnerIdentity,
    absorbJudgeModelEvents, nextJudgeRound, dropDeadForeignJudges,
  } = deps.registry;
  const { resolveJudgeLane, rotationCarryoverFacts, closeJudgePaneOf, reapReviewScratch } = deps.lanes;
  const {
    reviewTargets, stageIsOn, runTmux, channelIO, tmuxScope, cancelLedger, resolveJudgeLaunch, sweepStaleJudgeSessionDirs,
  } = deps;
  const stateForRepo = (root: string) => host.stateFor(root);

  /**
   * Dispatch ONE round to a judge role — the single place a judge process is
   * ever started, and the only owner of its identity.
   *
   * Identity is a function of role + repo, never of the round: the session id
   * (the resume key) and the WORK DIR (B5 — a title-derived dir gave pi a new
   * `--session-dir` every round, so the "resumed" session started from zero)
   * both come from `role + repoHash + opener`. The title is a display label, and only
   * reaches `--name` and diagnostics.
   *
   * Reuse is the default and is what carries a judge's context across rounds:
   * an alive same-role process is left running and simply re-watched; a
   * finished one is dropped and re-spawned under the SAME session id, so pi
   * appends to the same transcript. `fresh` kills the incumbent first.
   */
  async function dispatchJudgeRound(opts: {
    root: string;
    role: string;
    title: string;
    task: string;
    fresh?: boolean;
    /** This round's findings stream, recorded on the child for judge_wait. */
    streamPath?: string;
    /**
     * THE ONE WAY PAST THE QUALITY PRECONDITION (2026-09-16): the caller
     * dispatched THIS ROUND's quality judge itself, a line above, and the
     * standing is checked when the verdict is recorded instead. Only
     * `judge_submit`'s parallel path may pass it — it is never derived from the
     * registry, because that would make the gate unfalsifiable (the quality
     * pane is reused and stays alive).
     */
    qualityRoundDispatched?: boolean;
  }): Promise<JudgeDispatch> {
    const { root, role } = opts;
    dropDeadForeignJudges();
    // A new round of the role: whatever cancelled the previous one is history,
    // and a tombstone present after this line was written DURING this dispatch.
    cancelLedger.forget(root, role);
    // THE QUALITY PRECONDITION (2026-09-15). This is the mechanical fact that
    // makes the quality round unbypassable rather than a convention: no
    // registered target, or no quality standing bound to its head, and the
    // reviewer is NOT dispatched.
    //
    // IT NO LONGER GATES THE PARALLEL PATH (2026-09-16): the one submission that
    // starts both judges passes `qualityRoundDispatched`, because it dispatched
    // the quality judge itself and the standing is checked at RECORD time
    // instead (`decideQualityHold` — a functional READY is held until the
    // quality verdict stands). That flag is an explicit argument from that one
    // call site, NEVER inferred from the registry: inferring it would turn the
    // mechanical guarantee into an always-true condition.
    //
    // Two exemptions remain, and both live in the rule (lib/quality-round.ts):
    // a round that carries no code at all (recorded as a skip), and a pass
    // already bound to this head (a re-submission after a dead pane).
    if (role === "reviewer" && opts.qualityRoundDispatched !== true) {
      const target = reviewTargets.get(root);
      if (!target) {
        return { ok: false, reused: false, error: "没有登记在案的审查范围（prepare 未跑）—— 不能派 reviewer。" };
      }
      const standing = qualityStandingFor({
        head: target.head,
        // Absent means "unknown", and unknown is treated as code-bearing —
        // never as "nothing to judge" (lib/quality-round.ts).
        files: target.files,
        quality: stateForRepo(root).quality,
        stageOn: stageIsOn("quality", root),
      });
      if (!standing.ok) {
        return { ok: false, reused: false, error: `质量轮还没有放行这一轮 —— ${standing.reason}` };
      }
    }
    const title = opts.title.replace(/[^A-Za-z0-9._-]/g, "-") || role;
    const opener = callerIdentity();
    if (!opener) {
      return { ok: false, reused: false, error: "无法确认调用者身份——身份不明时不能派 review。" };
    }
    sweepStaleJudgeSessionDirs(root);
    // THE LANE this round runs in, resolved ONCE (lib/judge-rotation.ts) and
    // handed to every derivation below. The session id, the work dir and the
    // registry row all render from this one value, which is the only way they
    // cannot end up naming different lanes.
    const rotation = resolveJudgeLane(root, role, opener);
    const lane = rotation.decision.lane;
    const sessionId = judgeSessionIdFor(role, shortRepoHash(root), opener, lane);
    const judgeId = sessionId;
    // STABLE per role+repo+opener+lane (B5) — identity, not a per-round path.
    const workDir = pathJoin(root, judgeWorkDirFor(role, shortRepoHash(root), opener, lane));
    const sessionDir = pathJoin(workDir, "sessions");
    const continuesSession = hasTranscript(sessionDir);
    const ownPane = process.env.TMUX_PANE?.trim() || undefined;
    const run = (argv: readonly string[]) => runTmux(argv);
    // Stamped on every entry that records a pane, and checked before any use
    // of a recorded one (lib/hierarchy.ts `windowClosable` for a close,
    // `paneIdUsable` for a repaint — the two ask slightly different questions
    // on purpose).
    const tmuxServer = tmuxServerFrom(process.env);


    // The task text a rotated round is sent with: the history is gone, so the
    // hand-off (rendered by lib/review-carryover.ts, never re-written here)
    // travels in the task itself. A normal round passes through untouched.
    const task = rotationHandoffTask({
      role,
      task: opts.task,
      decision: rotation.decision,
      ...rotationCarryoverFacts(root, role, rotation.decision),
    });

    // Opener-scoped ids do not collide across sessions by construction: a second
    // opener derives a different id and opens its own review. Cross-opener protection
    // still lives in lib/hierarchy.ts (registration refuses two parents for one id).
    // The lookup IS that derivation: the registry is keyed by judge id, so
    // "same role, same session id in this repo" needs no scan of a second table.
    const existing = judgeHierarchy()[judgeId];
    // FIRST, before the entry below is replaced: what the pane said about its
    // own model belongs to THIS decision (an exhausted chain never settles, so
    // a dispatch is the only reader such events ever get), and the cursor they
    // must be read against lives on the entry that is about to be rewritten.
    absorbJudgeModelEvents(root, judgeId);

    // THE LANE BOOKKEEPING every registration below writes, so the next
    // dispatch can make the same decision from the registry alone.
    // `roundsInObject` is counted at DISPATCH (abandoned rounds included), and
    // the judge's last context reading survives a REUSE but never a rotation:
    // a new transcript starts empty, and carrying the old number forward would
    // rotate the new one immediately.
    const laneFields = {
      objectId: lane.objectId,
      generation: lane.generation,
      roundsInObject: rotation.decision.roundsInObject,
      ...(rotation.decision.rotated || existing?.contextPercent === undefined
        ? {}
        : { contextPercent: existing.contextPercent }),
    };

    // A recorded pane is probed only when its id is still comparable: an entry
    // restored from disk may have been minted by a tmux server that has since
    // restarted, and `%7` would then be a stranger's pane — reusing it would
    // send this round's task into it. Not comparable ⇒ treat as dead, which
    // falls through to a fresh open below (transcript continues by id).
    // `paneIdUsable`, NOT `windowClosable`: this asks whether the recorded PANE
    // is still comparable (may I reuse it / am I waiting on it), while
    // `windowClosable` answers the narrower "may I kill it" — inside
    // `closeJudgePaneOf`. Judging reuse with the kill's rule made a live judge
    // pane from before the window topology look dead, and the dispatch opened a
    // SECOND window for the same judge id (2026-09-25, quality round P2).
    const paneUsable = existing !== undefined && paneIdUsable(existing, tmuxServer);
    const paneAlive = paneUsable && existing?.paneId ? judgePaneAlive(run, existing.paneId) : undefined;
    // A living pane takes the round through its channel: the pane is the
    // CARRIER, the round is the task. No busy refusal exists anymore — a pane judge
    // reads every round via its drain; only a one-shot process read once.
    if (existing?.paneId && paneAlive === true && !opts.fresh) {
      // THE ROUND NUMBER IS COMPUTED BEFORE THE RECORD IS WRITTEN, and that
      // order is half the fix (2026-09-16). The entry used to be numbered at
      // the END of this block, while the task sat queued on the wire — so a
      // pane finishing its PREVIOUS round in that window read the NEW number
      // and stamped the OLD conclusion with it: the old verdict landed on the
      // new round, and the real new one was then refused as a duplicate
      // (measured: a quality round's BLOCKED verdict booked as round 2, and
      // round 2's own conclusion dropped). Sending the number WITH the task is
      // what makes "which round am I concluding" a fact the judge owns.
      const roundSeq = nextJudgeRound(opener, judgeId);
      try {
        appendRecord(channelIO, judgeChannelTarget(opener, judgeId), {
          kind: "instruct",
          // `from` names the OPENER side of the file — planes differ by key.
          from: "orchestrator",
          at: new Date().toISOString(),
          instructId: newChannelId("in", Date.now()),
          // INTERRUPT, not followUp (user decision 2026-09-16): a re-dispatch
          // means the content under review CHANGED, so waiting for the round
          // in flight means waiting out a verdict on code that is already gone
          // — and that wait was also the window the numbering raced in.
          // `interrupt` stops it and delivers this task now.
          mode: "interrupt",
          roundSeq,
          text: task,
        });
      } catch (err) {
        // NOT DELIVERED: the reuse wrote nothing, so this round's task never
        // reached the judge — the pane being alive says nothing about it.
        return { ok: false, reused: true, delivered: false, sessionId, sessionDir, paneId: existing.paneId, judgeId, error: `本轮任务写不进通道 —— ${(err as Error).message}` };
      }
      // ONE write, not two: the Map used to be mutated here (streamPath,
      // spawnedAt) and the table registered right after, which is exactly how
      // the two drifted apart.
      // The wait cursors survive a re-dispatch: already-consumed reports must
      // not end the new round's wait (stale-report P0 — a wiped cursor ends
      // every fresh wait on the previous round's report instantly). The
      // FINDING cursor survives too, but only while the round writes to the
      // SAME stream file: a new stream starts at zero, and a reused one (a
      // re-audit of the same draft) must not replay what was already shown.
      const keptCursor = existing.lastReportId;
      const keptFindings = existing.streamPath === opts.streamPath
        ? existing.lastFindingCount
        : undefined;
      // `existing` was captured BEFORE this dispatch's absorb (which runs above,
      // on entry) — so its cursors can be one step behind the table. Reading the
      // entry again here is what keeps the absorb's cursor advance from being
      // rolled back by this registration (P1, reviewer round 2): a rolled-back
      // cursor hands the SAME events to the next round, and re-recording them
      // with `Date.now()` makes the cooldown永不过期.
      const live = judgeHierarchy()[judgeId] ?? existing;
      const reg = registerJudge(judgeHierarchy(), {
        judgeId, openerId: opener, role, repoRoot: root, title, sessionDir,
        // WHERE THE LIVE PANE IS, carried forward as one value (`paneCoordsOf`):
        // a re-registration that copies only some of these fields leaves an
        // entry its own close path must then refuse — the pane is alive, on
        // screen, and unaddressable (2026-09-25, quality round P1).
        ...paneCoordsOf(live),
        roundSeq,
        // The pane's model does not change because a new round was queued into
        // it — the entry keeps saying what the RUNNING pane was launched on.
        ...(live.modelSpec === undefined ? {} : { modelSpec: live.modelSpec }),
        // The MODEL-EVENT cursor survives for the same reason the report cursor
        // does: the channel is append-only across rounds, so a reset cursor
        // would hand this round the PREVIOUS round's events — and a stale
        // `exhausted` one would end a perfectly healthy round on its first
        // probe (the audit chains end with it too).
        ...(live.lastModelEventCount === undefined ? {} : { lastModelEventCount: live.lastModelEventCount }),
        ...(keptCursor === undefined ? {} : { lastReportId: keptCursor }),
        ...(keptFindings === undefined ? {} : { lastFindingCount: keptFindings }),
        ...(opts.streamPath === undefined ? {} : { streamPath: opts.streamPath }),
        ...laneFields,
        spawnedAt: new Date().toISOString(),
      });
      if (reg.ok) setHierarchy(reg.table);
      // The replacement lane is registered — only now may the lane it replaces
      // be closed and forgotten (a no-op on the normal reuse path, where the
      // "previous" lane IS this one).
      rotation.retirePrevious();
      return { ok: true, reused: true, sessionId, sessionDir, paneId: existing.paneId, judgeId };
    }
    // fresh:true kills the living pane FIRST (singleton per role+repo).
    // A dead record falls through to a fresh open below (the transcript
    // continues by session id, so the review never starts from zero).
    if (existing) {
      if (existing.paneId && paneAlive === true && opts.fresh) {
        // FIFTH CLOSE PATH (reviewer, 2026-09-05). A `fresh` round kills the
        // incumbent and re-opens immediately, so the border line would come
        // straight back — and the re-open can FAIL (no model chain, tmux
        // gone), which is why this close also drops the registry row. It used
        // to hand that failure to a label-bar judgement so the bar would not
        // be stranded; there is nothing to strand any more (2026-09-17: the
        // bar is turned on and left on).
        closeJudgePaneOf(existing, { ownPane, tmuxServer, run });
      }
      if (paneAlive === false) reapReviewScratch(sessionId);
      // One removal, one table.
      setHierarchy(removeJudge(judgeHierarchy(), judgeId));
      // The killed round's audited draft dies with it: leaving it behind
      // would let a LATER report record a verdict against a draft that round
      // never judged.
      if (existing.role === "goal-auditor") dropAudits(root);
    }
    if (!ownPane) {
      return { ok: false, reused: continuesSession, sessionId, sessionDir, error: "当前会话不在 tmux 里，开不出 review pane——在 tmux 中重开本会话后重试；门禁不会退回旧的进程壳子。" };
    }
    try {
      const launch = resolveJudgeLaunch(root, role, workDir, title, judgeId);
      if (!launch.ok) {
        return { ok: false, reused: continuesSession, sessionId, sessionDir, error: launch.error };
      }
      const files = { sysPromptPath: launch.sysPromptPath, model: launch.spec };
      // "Reused" is a fact about the SESSION, not about the pane: the
      // transcript decided it above, before this round could add to it.
      mkdirSync(sessionDir, { recursive: true });
      const taskPath = pathJoin(sessionDir, `task-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.md`);
      writeFileSync(taskPath, task, "utf8");
      // fresh:true starts a NEW review object: everything the channel holds so
      // far belongs to an older object and must never end this round's wait.
      // Seed the cursor at the channel's current newest report (best-effort —
      // an unreadable channel leaves it unset, and the round check at record
      // time still refuses old rounds). Read BEFORE the pane opens, so a fast
      // judge's first record cannot land inside the read.
      const freshTarget = judgeChannelTarget(opener, judgeId);
      const judgeChannelPath = channelPathFor(freshTarget.orchestrationId, freshTarget.childId, freshTarget.home);
      let freshCursor: string | undefined;
      let freshModelEventCount: number | undefined;
      try {
        const freshProjection = projectChannel(readChannel(channelIO, judgeChannelPath).records);
        freshCursor = freshProjection.lastReport?.reportId;
        // The SAME watermark rule for the model events: the channel is
        // append-only, so a fresh entry that started at zero would replay every
        // old failure — including an `exhausted` event that would end this
        // round's very first probe.
        freshModelEventCount = freshProjection.modelEvents.length;
      } catch { freshCursor = undefined; freshModelEventCount = undefined; }
      // A judge's channel OUTLIVES its panes, so only a record ABOVE this
      // watermark proves that the pane opened below actually came up.
      const baselineRecords = channelRecordCount(channelIO, judgeChannelPath);
      // REGISTERED ON FILE BEFORE THE JUDGE STARTS (2026-09-27). The judge
      // reads its own entry from the shared file when it concludes, and its
      // task rides in on argv — so an entry that has not reached the file when
      // the pane opens is a round whose verdict may be refused (measured
      // 2026-09-26: 「登记表里没有本 review」). The pane coordinates are added
      // once the window exists; that second write is not critical, the entry
      // is already on file.
      const keptFindingCount = judgeHierarchy()[judgeId]?.streamPath === opts.streamPath
        ? judgeHierarchy()[judgeId]?.lastFindingCount
        : undefined;
      const entryFields = {
        judgeId,
        openerId: opener,
        role,
        repoRoot: root,
        title,
        sessionDir,
        roundSeq: nextJudgeRound(opener, judgeId),
        ...(tmuxServer === undefined ? {} : { tmuxServer }),
        ...(freshCursor === undefined ? {} : { lastReportId: freshCursor }),
        ...(freshModelEventCount === undefined ? {} : { lastModelEventCount: freshModelEventCount }),
        // Which model this pane was launched on — the round's receipt says
        // who actually ran it (the pane may rotate later; that reports
        // itself through the channel).
        modelSpec: launch.spec,
        // Same rule as the reuse path: a re-run over the SAME stream file keeps
        // its finding cursor, so nothing already shown is shown again.
        ...(keptFindingCount === undefined ? {} : { lastFindingCount: keptFindingCount }),
        ...(opts.streamPath === undefined ? {} : { streamPath: opts.streamPath }),
        ...laneFields,
        spawnedAt: new Date().toISOString(),
      };
      const pre = registerJudge(judgeHierarchy(), entryFields);
      if (!pre.ok) return { ok: false, reused: continuesSession, sessionId, sessionDir, error: pre.reason };
      if (!setHierarchy(pre.table)) {
        return {
          ok: false,
          reused: continuesSession,
          sessionId,
          sessionDir,
          error: `登记表 .pi/judge-hierarchy.json 没写成（另一个进程一直占着它的锁）—— ${role} 没有启动，本轮没有派出；稍后重试`,
        };
      }
      const opened = await openSessionWindow(run, {
        scope: tmuxScope,
        cwd: root,
        layout: "own-session-window",
        role: {
          kind: "judge",
          openerId: opener,
          judgeId,
          role,
          ...(opts.streamPath === undefined ? {} : { streamPath: opts.streamPath }),
        },
        command: buildJudgePaneCommand({
          sessionId,
          taskPath,
          sessionDir,
          sysPromptPath: files.sysPromptPath,
          model: files.model,
        }),
        decor: judgePaneDecor(judgeId, role, paneOwnerIdentity()),
        register: (coords) => {
          const reg = registerJudge(judgeHierarchy(), {
            ...entryFields,
            paneId: coords.paneId,
            // The window and its session, recorded with the pane id: they are
            // what closes this judge (`kill-window -t <session>:<@window>`),
            // and the session half is what keeps the kill inside ours.
            ...(coords.windowId === undefined ? {} : { windowId: coords.windowId }),
            ...(coords.sessionName === undefined ? {} : { tmuxSession: coords.sessionName }),
          });
          if (reg.ok) setHierarchy(reg.table);
        },
        // EARN the receipt for a judge too: a judge that never boots leaves its
        // opener waiting forever, which is the one silence nobody can break.
        verify: () => verifyJudgeBoot(
          { channelIO: () => channelIO, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) },
          { channelPath: judgeChannelPath, baselineRecordCount: baselineRecords },
        ),
      });
      // No pane at all: the pre-registration names nothing and goes.
      if (!opened.ok && opened.deliveryFailed !== true) setHierarchy(removeJudge(judgeHierarchy(), judgeId));
      if (!opened.ok) {
        // A delivery failure KEEPS the pane and the registration (it may only
        // be slow), so the opener can still wait on it; anything else means no
        // pane exists at all.
        const detail = dispatchFailureDetail(cancelLedger, root, role, opened);
        // A pane that EXISTS (delivery failure) is a registered replacement
        // lane, so the old one is finished either way; a pane that never
        // opened leaves the previous lane alone, and the next dispatch decides
        // the same rotation again from a registry that still has it.
        if (opened.deliveryFailed) rotation.retirePrevious();
        // `deliveryFailed` is NOT "the task was lost": the pane exists and
        // was KEPT, and what failed is the BOOT VERIFICATION — the judge task
        // itself rode in on argv (lib/session-factory.ts). So a pane that
        // never acknowledged is still a delivered round the opener may wait
        // on, which is exactly what `delivered: true` means here (quality
        // round P2, 2026-09-16: the inverted-looking line needs to say so).
        return { ok: false, reused: continuesSession, delivered: opened.deliveryFailed === true, sessionId, sessionDir, error: detail, ...(opened.paneId === undefined ? {} : { paneId: opened.paneId }), judgeId };
      }
      // The new pane is up and registered: the lane it replaces is now safe to
      // close and forget (idempotent, and a no-op when nothing changed).
      rotation.retirePrevious();
      return { ok: true, reused: continuesSession, sessionId, sessionDir, paneId: opened.paneId, judgeId };
    } catch (err) {
      return { ok: false, reused: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { dispatchJudgeRound };
}
