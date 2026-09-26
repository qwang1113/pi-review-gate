/**
 * THE SESSION LIFECYCLE — `session_start` (re-derive where the session works,
 * restore its state, arm what must be armed), `session_shutdown` (stop every
 * clock this instance owns) and `session_compact` (re-inject the loop's state).
 * Moved out of `extensions/review-gate.ts` (t8, 2026-09-26, wave 4 of the split).
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { computeFingerprint } from "./fingerprint.ts";
import { showToUser } from "./gate-dialogs.ts";
import { armingFromFacts } from "./gate-arming.ts";
import { STATE_VARIANT_ENV } from "./gate-state-io.ts";
import { FINGERPRINT_MIGRATION_NOTICE } from "./gate-state-load.ts";
import { unmetRequirements } from "./gate-state-requirements.ts";
import { buildGitMemory } from "./git-memory.ts";
import { blockedMarkerPath, reconcileBlockedMarker } from "./blocked-marker.ts";
import { readJudgeSideEnv } from "./judge-side.ts";
import { sessionSidecarPath } from "./loop-goal-host.ts";
import { loadProjectConfig } from "./project-config.ts";
import { commitsAheadOfBase, currentBranch } from "./repo-facts.ts";
import { gitRootOfDir } from "./repo-resolve.ts";
import type { SessionCells } from "./session-cells.ts";
import { gateStateWriteSkip } from "./session-exclusivity.ts";
import { isEnforcedMode, requestedModeFromEnv, type TaskMode, type TaskModeSource } from "./task-mode.ts";
import { mayNotifyUser } from "./user-notify.ts";
import { readWorkerSideEnv } from "./worker-side.ts";
import { isProtectedBranch } from "./workspace-branch.ts";
import { changedFiles } from "./worktree-changes.ts";

export interface SessionLifecycleDeps {
  pi: Pick<ExtensionAPI, "sendMessage">;
  restore(ctx: ExtensionContext, sessionId: string | null): void;
  persist(ctx?: ExtensionContext): void;
  setTaskMode(mode: TaskMode, source: TaskModeSource, ctx: ExtensionContext): void;
  ensureModelLayersRendered(ctx: ExtensionContext): void;
  /** The judge registry's two startup calls. */
  ensureHierarchyLoaded(root: string): void;
  dropDeadForeignJudges(): void;
  /** Widget + child heartbeat (status strip / child side). */
  armUiRefreshTimer(): void;
  disarmUiRefreshTimer(): void;
  updateWidget(ctx: ExtensionContext): void;
  startChildHeartbeat(ctx: ExtensionContext): void;
  stopChildHeartbeat(): void;
  reportChildState(ctx: ExtensionContext, note?: string, opts?: { force?: boolean }): void;
  /** Worktree presence (lib/worktree-presence-host.ts). */
  applySessionExclusivity(ctx: ExtensionContext): void;
  releaseWorktree(): void;
  stopExclusivityRecheck(): void;
  /** The runtime clocks, read at call time (created after this module). */
  runtime(): {
    stopSupervisionTimer(): void;
    stopRevivalTimer(): void;
    startSessionNamingHeartbeat(): void;
    stopSessionNamingHeartbeat(): void;
    startPaneState(): void;
  };
  cancelChildWaitTimer(): void;
  notify: { startHint(): string; markCleanShutdown(): void };
  naming: {
    onSessionStart(): { adopted?: string; sweep: { reaped: Array<{ name: string; sessionId: string; sessionKilled?: boolean }> } };
    release(): unknown;
  };
  /** Close this session's own tmux session on a non-`declare_done` exit (lib/session-scope-exit.ts). */
  closeScopeOnExit(): void;
  log(text: string): void;
}

export function createSessionLifecycle(cells: SessionCells, deps: SessionLifecycleDeps) {
  async function onSessionStart(ctx: ExtensionContext): Promise<void> {
    cells.cwd = ctx.cwd ?? process.cwd();
    const cwd = cells.cwd;
    // P-multi: re-derive the primary repo and reset per-repo tracking for the
    // new session (a switched session may target a different checkout).
    // `gitRootOfDir` already silences git's stderr, so this never leaks the
    // "fatal: not a git repository" noise.
    cells.sessionInGit = gitRootOfDir(cwd) !== null;
    cells.primaryRepoRoot = gitRootOfDir(cwd) ?? cwd;
    const primaryRepoRoot = cells.primaryRepoRoot;
    cells.activeRepoRoot.current = primaryRepoRoot;
    cells.sessionRepos.clear();
    cells.sessionRepos.add(primaryRepoRoot);
    cells.repoStateCache.clear();
    // USER REQUIREMENT: "no changes" for the first classification means THIS
    // session — a new session starts with a clean edit slate even if the
    // worktree carries pre-existing changes (they still arm the ship gate via
    // the P0-2 detection below).
    cells.sessionEdited = false;
    // In-memory pause/lock hygiene for a fresh (or switched) session.
    cells.lastRunAborted = false;
    cells.scopeLimitDeclined = false;
    cells.sessionEditedPaths.clear();
    // A new/switched session inherits NO sensitive-file authorization.
    cells.sensitiveGrants = [];
    cells.sensitiveDeclinedPaths.clear();
    let sessionId: string | null = null;
    try { sessionId = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId?.() ?? null; } catch { /* */ }
    deps.restore(ctx, sessionId);
    const state = cells.state;
    state.sessionId = sessionId;
    // P-multi: re-arm the repo set from the persisted list — a same-session
    // resume keeps the repos it edited, and a RELAY SUCCESSOR inherits the
    // predecessor's. Only repos whose sidecar still exists are re-added.
    //
    // IT HAS TO LAND ABOVE THE FIRST persist() (quality round P1, 2026-09-16):
    // `persist` writes `state.sessionReposPaths` FROM this in-memory set, and a
    // relay successor ALWAYS persists early.
    for (const r of state.sessionReposPaths ?? []) {
      if (r !== primaryRepoRoot && existsSync(sessionSidecarPath(r))) cells.sessionRepos.add(r);
    }
    // Take over previous sessions' pane judges: merge their registry + pendings
    // so live panes stay addressable. Judge panes themselves skip this.
    if (!readJudgeSideEnv(process.env)) {
      for (const root of new Set([primaryRepoRoot, ...cells.sessionRepos])) deps.ensureHierarchyLoaded(root);
      deps.dropDeadForeignJudges();
    }
    // A new session negotiates its OWN goal: whatever audit rounds a previous
    // session spent on its draft do not carry into this one's count.
    delete state.goalAuditRound;

    // Per-project overrides (sd0x-dev-flow R6): maxRounds is clamped to [3,50]
    // by the loader. Anchored at the repo ROOT.
    cells.projectConfig = loadProjectConfig(primaryRepoRoot);
    state.maxRounds = cells.projectConfig.maxRounds;
    // Publish-path fallback for the model-config layers: idempotent, fail-soft.
    deps.ensureModelLayersRendered(ctx);
    // The session runtime was just (re)bound — re-arm the widget-refresh timer
    // with the fresh ctx (session_shutdown disarmed the old one).
    deps.armUiRefreshTimer();
    // THE SUPERVISION HEARTBEAT (round-4 P0): armed here, for every session
    // that has an orchestration address, independent of the agent.
    deps.startChildHeartbeat(ctx);
    deps.reportChildState(ctx, undefined, { force: true });
    // THE TMUX SIDEBAR'S PANE STATE (s1): every pi session, git or not — so it
    // starts BEFORE the non-git short-circuit below.
    deps.runtime().startPaneState();

    // Reflect the precommit config source in the status bar right away.
    deps.updateWidget(ctx);

    // NON-GIT DIRECTORY SHORT-CIRCUIT (2026-09-02, user decision): in a
    // directory that is not inside a git repository the whole gate steps
    // aside — normal mode is the honest classification; the language
    // directive (L4) stays.
    if (!cells.sessionInGit) {
      deps.setTaskMode("normal", "auto", ctx);
      if (ctx.hasUI) {
        try {
          ctx.ui.notify("review-gate: 非 git 目录 —— 门禁不介入（无仓库可审查/提交）。", "info");
        } catch { /* headless */ }
      }
      return; // skip P0-2 arming, protected-branch notice, heartbeat-state report
    }
    // PROTECTED-BRANCH NOTICE (2026-09-07, user decision; wording 2026-09-12):
    // a protected-branch checkpoint is refused outright, and this notice is
    // the only thing the user reads before hitting that wall.
    const startBranch = currentBranch(primaryRepoRoot);
    if (startBranch && isProtectedBranch(startBranch) && ctx.hasUI) {
      showToUser(
        ctx as unknown as ExtensionContext,
        "───────── 当前在受保护分支 ─────────",
        `本会话在 ${startBranch} 上开始。checkpoint 会直接提交到当前分支；` +
        "在受保护分支上 checkpoint 与 `git commit` 都会被**直接拒绝**（不弹确认框）。" +
        "若这不是你的意图，先切换分支。",
      );
    }
    // USER REQUIREMENT — a session that cannot show a dialog runs in normal
    // mode, period: every enforced mode depends on dialogs.
    if (!ctx.hasUI) deps.setTaskMode("normal", "auto", ctx);

    // SAY IT ONCE WHEN THE BANNER CHANNEL IS DEAD (user decision, 2026-09-17),
    // only for a session that WOULD be allowed to raise one.
    if (
      ctx.hasUI &&
      mayNotifyUser({ taskMode: cells.state.taskMode, stateVariant: process.env[STATE_VARIANT_ENV] }) &&
      deps.notify.startHint()
    ) {
      try { ctx.ui.notify(deps.notify.startHint(), "info"); } catch { /* headless */ }
    }

    // A SPAWNER may hand a session its starting mode (RG_GATE_MODE): a child
    // opened by `orchestrator_spawn` is an ordinary loop session, and a relay
    // successor is an orchestrator. It applies only to a session that is still
    // UNDECIDED and interactive, and only for the two enforced modes.
    //
    // THE ONE NON-ENFORCED REQUEST THAT IS HONOURED: a WORKER pane asking for
    // `explore` (2026-09-21) — the only honest description of a session that
    // reads and reports. The worker identity is required.
    if (ctx.hasUI && cells.state.taskMode === undefined) {
      const requestedBySpawner = requestedModeFromEnv();
      if (isEnforcedMode(requestedBySpawner) && requestedBySpawner !== undefined) {
        if (requestedBySpawner !== "orchestrator" || process.env.TMUX) {
          deps.setTaskMode(requestedBySpawner, "auto", ctx);
        }
      } else if (requestedBySpawner === "explore" && readWorkerSideEnv(process.env)) {
        deps.setTaskMode("explore", "auto", ctx);
      }
    }

    // A restored pause survives the restart: keep auto-continuation disarmed
    // until the user's next message clears it (input handler).
    if (cells.state.pausedQuestion) cells.loopArmed = false;

    // A same-session resume keeps this session's edit attribution: re-seed
    // the in-memory set from the persisted lists.
    for (const f of cells.state.sessionEditedFiles ?? []) cells.sessionEditedPaths.add(f);
    for (const f of cells.state.scopeLimit?.sessionFiles ?? []) cells.sessionEditedPaths.add(f);
    if (cells.sessionEditedPaths.size > 0) cells.sessionEdited = true;

    // P0-2: detect pre-existing changes — worktree AND branch commits. A
    // user-granted scope limit exempts exactly the files still in its
    // snapshot; new dirty files still arm the gate (fail-closed). Branch-commit
    // arming is suspended while the grant stands.
    // ONLY the headless force above may skip arming: a no-UI normal session
    // keeps the git hooks fully enforced (source "auto"), so arming here would
    // block exactly the commit that mode promises to allow. An INTERACTIVE
    // normal session still arms, so a later switch to loop finds the
    // pre-existing changes inside the fence.
    const st = cells.state;
    const headlessNormal = st.taskMode === "normal" && !ctx.hasUI;
    if (!headlessNormal && !st.hasCodeChange && !st.hasDocChange && !st.bypass.active) {
      const exempt = new Set(st.scopeLimit?.preexistingFiles ?? []);
      const allFiles = changedFiles(cwd);
      const files = st.scopeLimit && allFiles ? allFiles.filter((f) => !exempt.has(f)) : allFiles;
      // ONE RULE, ONE IMPLEMENTATION (drill F1): `turn_end` asks the same
      // question of the same facts.
      const armed = armingFromFacts({
        files: files ?? [],
        commitsAhead: st.scopeLimit ? 0 : commitsAheadOfBase(cwd),
      });
      if (armed.hasCodeChange || armed.hasDocChange) {
        if (armed.hasCodeChange) st.hasCodeChange = true;
        if (armed.hasDocChange) st.hasDocChange = true;
        st.review.verdict = "PENDING";
        st.precommit.verdict = "NOT_RUN";
      }
    }

    // Reclaim orphan .blocked owners (ours, plus any session silent past the
    // concurrent-session window) — never an unconditional unlink. Done here as
    // well as in persist() because an early return can mean persist() never
    // runs this turn. …but NOT as a judge, and not while refused (reviewer P1,
    // 2026-09-05): this is the one gate-state write outside persist().
    if (!gateStateWriteSkip(process.env) && !st.exclusivityRefusal) {
      reconcileBlockedMarker(blockedMarkerPath(sessionSidecarPath(cwd)), { sessionId: st.sessionId });
    }

    // Explain an invalidated binding instead of letting READY silently become
    // PENDING after an upgrade (see migrateFingerprintVersion).
    if (cells.fingerprintMigrated) {
      try { ctx.ui.notify(FINGERPRINT_MIGRATION_NOTICE, "warning"); } catch { /* headless */ }
      cells.fingerprintMigrated = false;
    }

    // ONE gate session per worktree: refuse, or take the claim — decided from
    // a heartbeat, not guessed (哲学三).
    deps.applySessionExclusivity(ctx);

    deps.persist(ctx);

    // ── THE NAME, AT STARTUP (t2, 2026-09-25) ── re-adopt the registration
    // this session id already holds, and SWEEP what dead sessions left behind
    // (judged in lib/session-registry.ts, fires only on provable death).
    const namingStart = deps.naming.onSessionStart();
    if (namingStart.adopted !== undefined) {
      deps.log(`review-gate[session-name] 本会话沿用已登记的名字 ${namingStart.adopted}`);
    }
    for (const reaped of namingStart.sweep.reaped) {
      deps.log(
        `review-gate[session-name] 回收孤儿：${reaped.name}（${reaped.sessionId}）` +
        `${reaped.sessionKilled ? "，已 kill 它的专属 tmux session" : ""}`,
        // NO “已清 inbox” HERE (2026-09-25, reviewer P1 twice): the sweep does
        // not delete a dead holder's mail — see lib/session-orphan-sweep.ts.
      );
    }
    deps.runtime().startSessionNamingHeartbeat();
  }

  function onSessionShutdown(event: SessionShutdownEvent): void {
    // A CLEAN SHUTDOWN IS NOT A FAILURE (user decision, 2026-09-17): every
    // reason pi reports here is the user ending or restarting the session.
    deps.notify.markCleanShutdown();
    // Round-18: stop the referenced child-wait watchdog with the session.
    deps.cancelChildWaitTimer();
    // Every ctx this instance captured is now stale and THROWS on access, so
    // the widget-refresh timer must stop ticking it (a stale tick after a
    // resume took pi down). session_start re-arms it with the fresh ctx.
    cells.lastUiCtx.current = undefined;
    deps.disarmUiRefreshTimer();
    // Timers this session owns — a leaked one would keep waking (or reviving,
    // or reporting on behalf of) a session that is gone.
    const runtime = deps.runtime();
    runtime.stopSupervisionTimer();
    runtime.stopRevivalTimer();
    deps.stopChildHeartbeat();
    // Let go of the worktree (only OUR OWN claim) and stop watching somebody
    // else's heartbeat. Judge children survive the session by design.
    deps.releaseWorktree();
    deps.stopExclusivityRecheck();

    // ── THE NAME AT SHUTDOWN (t2; quality round 2 P1) ── the renewal clock
    // always stops; the NAME goes back unless this is a `reload` (which keeps
    // the SAME session id and re-adopts the registration). `new` / `resume` /
    // `fork` REPLACE the session while the pane and pid stay, so without this
    // release the old registration would keep looking live.
    runtime.stopSessionNamingHeartbeat();
    if (event.reason !== "reload") {
      deps.naming.release();
      // ── AND ITS OWN TMUX SESSION (t4, 2026-09-26) ── a session replaced or
      // quit here never reaches declare_done, and nothing else would reclaim
      // the judge / worker windows it opened. `reload` keeps the session id.
      deps.closeScopeOnExit();
    }
  }

  async function onSessionCompact(): Promise<void> {
    const state = cells.state;
    // Explore/normal have no enforced loop to resume.
    if (state.taskMode === "explore" || state.taskMode === "normal") return;
    // Paused for a user question: re-inject the waiting state so the compacted
    // model does not lose the fact that it is waiting for the user's answer.
    if (state.pausedQuestion) {
      deps.pi.sendMessage({
        customType: "review-gate-resume",
        content:
          "[REVIEW_GATE_PAUSED] Context compacted. The review loop is PAUSED (ask_user), " +
          `awaiting the user's answer to: "${state.pausedQuestion.question.slice(0, 500)}"\n` +
          "Do not resume the loop on your own — wait for the user's reply (it clears the pause automatically). " +
          "Ship commands remain blocked while gates are unmet.",
        display: true,
      }, { deliverAs: "followUp", triggerTurn: false });
      return;
    }
    const fp = computeFingerprint(cells.cwd);
    const problems = unmetRequirements(state, fp.digest, fp.unavailable, { requireDocSync: cells.projectConfig.docSync });
    if (problems.length === 0 || state.bypass.active) return;
    // R9 (git memory, default on): filtered git snapshot so the model recovers
    // its working context after compaction without re-exploring the repo.
    const gitContext = cells.projectConfig.gitMemory ? buildGitMemory(cells.cwd) : "";
    deps.pi.sendMessage({
      customType: "review-gate-resume",
      content:
        "[REVIEW_GATE_RESUME] Context compacted. Gate state survived:\n" +
        `- review: ${state.review.verdict}\n- precommit: ${state.precommit.verdict}\n` +
        `- round: ${state.rounds.length}/${state.maxRounds}\n` +
        "Unmet:\n" + problems.map((p) => `- ${p}`).join("\n") + "\nResume the loop." +
        (gitContext ? "\n\n" + gitContext : ""),
      display: true,
    }, { deliverAs: "followUp", triggerTurn: false });
  }

  return { onSessionStart, onSessionShutdown, onSessionCompact };
}
