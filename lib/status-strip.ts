/**
 * THE STATUS STRIP AND THE CONTRACT READOUT — the session's display half,
 * moved out of `extensions/review-gate.ts` (t5, wave 1).
 *
 * Display-only, by contract: nothing here feeds an enforcement path, every
 * render is crash-proofed, and the per-tick facts are CHEAP (in-memory state,
 * one `symbolic-ref`, one goal/plan file read on demand — never a
 * fingerprint). The pure renderers live in lib/ui-widget.ts; this module owns
 * the wiring around them: which facts, when to push, and the 5s refresh timer.
 */

import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  buildContractReadout,
  buildGateWidget,
  planContractRows,
  showsRoundReading,
  type ContractFacts,
  type GateWidgetFacts,
} from "./ui-widget.ts";
import { LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK } from "./loop-goal.ts";
import { parseGoalCriteria } from "./loop-goal-directives.ts";
import { stagesOff, stagesSummary } from "./loop-stages.ts";
import { readPlanFile } from "./orchestrator-wiring.ts";
import { currentBranch } from "./repo-facts.ts";
import { isEnforcedMode } from "./task-mode.ts";
import { rendererModeNoticeDue, RENDERER_MODE_NOTICE, type RendererMode } from "./renderer-mode.ts";
import type { Ref, SessionHost } from "./session-host.ts";

/** What the strip needs from the session beyond the shared host. */
export interface StatusStripDeps {
  goalStageSatisfied(): boolean;
  /** Is the goal stage switched on (lib/loop-stages.ts)? */
  goalStageOn(): boolean;
  isJudgePane(): boolean;
  /** The round a judge pane's task named, when it named one. */
  judgeTaskRound(): number | undefined;
  /** Has THIS session edited anything (the flag, or a recorded path)? */
  sessionEdited(): boolean;
  /** Is there a goal file for this repo at all (approved or not)? */
  loopGoalPresent(root: string): boolean;
  loopGoalPath(root: string): string;
  /** The last UI context a render reached — the refresh timer's target. */
  lastUiCtx: Ref<ExtensionContext | undefined>;
}

export interface StatusStrip {
  gateWidgetFacts(): GateWidgetFacts;
  contractReadout(): { lines: string[]; absent?: string };
  updateWidget(ctx: ExtensionContext): void;
  armUiRefreshTimer(): void;
  disarmUiRefreshTimer(): void;
}

export function createStatusStrip(host: SessionHost, deps: StatusStripDeps): StatusStrip {
  const { lastUiCtx } = deps;
  // Content is built by pure functions in lib/ui-widget.ts and only pushed to
  // the TUI when it actually changed (pi re-renders on every setWidget call).
  let lastAgentsWidget = "";

  /**
   * Has this session been told about its renderer? At most once per session.
   * In-memory on purpose: a restart is a new session with a new terminal, and
   * the answer can differ.
   */
  let rendererModeNoticeShown = false;

  /**
   * Say something when this session is on the renderer that CANNOT scroll a
   * tall dialog, and stay silent otherwise.
   *
   * The value comes from `TUI.mode` (see `lib/renderer-mode.ts` for why a
   * re-derivation from `--tui-mode` + settings files would be a copy that gets
   * the corners wrong).
   *
   * THE FLAG IS SET ONLY AFTER THE NOTICE IS OUT (round-1 quality P1,
   * 2026-09-16): the first version marked the session as told and then called
   * `latestCtx?.ui.notify`, which at probe time is not set yet — so the notice
   * could never reach anybody. A host that cannot notify must not consume the
   * session's one chance to say it.
   */
  function noteRendererMode(mode: RendererMode | undefined, ctx: ExtensionContext): void {
    if (!rendererModeNoticeDue(mode, rendererModeNoticeShown)) return;
    try {
      ctx.ui.notify(RENDERER_MODE_NOTICE, "warning");
      rendererModeNoticeShown = true;
    } catch { /* headless — a later probe may still succeed */ }
  }

  /**
   * The gate facts the belowEditor widget renders: mode, branch, edited flag,
   * and whether the loop goal is confirmed.
   *
   * 2026-09-16 — DELIBERATELY CHEAP (input-lag fix): this used to call
   * `computeFingerprint()` on every 5s tick — a full shadow-index materialize
   * + two `git add` passes that took ~3.2s in a 13k-file repo and ran on
   * pi's main event loop, freezing the editor while typing. The widget now
   * shows ONLY state that needs no git work: the in-memory gate state, the
   * branch (one `symbolic-ref`), and the loop-goal confirmation. The unmet-
   * requirements count is gone from the strip; it lives in `/gate-status`.
   * Display-only: this never feeds an enforcement path.
   */
  function gateWidgetFacts(): GateWidgetFacts {
    const state = host.state();
    const { inGit: sessionInGit, primary: primaryRepoRoot } = host.repos();
    const completion: string[] = [];
    // NON-GIT SHORT-CIRCUIT: the loop goal is a per-REPO contract — outside
    // a repository there is no repo to bind it to, so it must not surface
    // as an unmet requirement either (2026-09-02, user decision).
    if (sessionInGit && !deps.goalStageSatisfied()) completion.push(LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
    // ROUND READING (2026-09-17, user decision): how many rounds THIS session
    // SENT OUT — a loop session's own submissions, a judge pane's own round
    // number. Both are already in memory (no git, no fingerprint, so the
    // cheap-by-contract rule above holds). Sessions that never send anything
    // (orchestrator / explore / normal) do not show the segment at all —
    // `showsRoundReading` is the one place that rule lives, and a judge pane
    // whose task never named a round shows nothing rather than a 0 it cannot
    // back up.
    const judgePane = deps.isJudgePane();
    const roundReading = judgePane ? deps.judgeTaskRound() : (state.sentReviewRounds ?? 0);
    return {
      mode: state.taskMode,
      nonGit: !sessionInGit,
      // NON-GIT SHORT-CIRCUIT: `currentBranch` would run git and, outside a
      // repository, leak "fatal: not a git repository" to the terminal.
      // The user decision (2026-09-02): in a non-git directory, do not call
      // git at all — no branch is shown.
      branch: sessionInGit ? currentBranch(primaryRepoRoot) ?? "(detached)" : undefined,
      edited: deps.sessionEdited() || state.hasCodeChange || state.hasDocChange,
      ...(sessionInGit && roundReading !== undefined &&
          showsRoundReading({ mode: state.taskMode, judge: judgePane })
        ? { rounds: roundReading }
        : {}),
      // THE STAGE SWITCHES, visible on the strip whenever anything is OFF
      // (2026-09-22, user decision: a released checkpoint must be readable at a
      // glance). All-on renders nothing, which keeps today's strip unchanged;
      // this is in-memory state, so the cheap-by-contract rule above holds.
      ...(stagesOff(state.stages).length > 0 ? { stages: stagesSummary(state.stages) } : {}),
      unmet: completion,
    };
  }

  /**
   * The CONTRACT the `/gate-contract` command shows (2026-09-18): a project
   * manager shows its plan, a loop session (standalone or an orchestrated
   * child) shows the exit criteria of ITS OWN approved goal.
   *
   * On demand, so this runs when the user asks, not on a tick. It is still
   * CHEAP BY CONTRACT in the same sense as the status strip: one plan file read
   * or one goal file read, no git, no fingerprint, and nothing here is an
   * enforcement input.
   *
   * ONE PLACE DECIDES BOTH HALVES (quality round P2, 2026-09-19). The empty
   * cases and their explanations used to be written TWICE — a chain of bare
   * `return { rows: [] }` here and a mirrored chain of `absent(...)` in
   * `contractReadout` — so a new empty case could be added to one half and
   * silently not the other, and the command would then print a reason that
   * sounds right and is wrong (the mirroring was mechanical: 4 returns against
   * 6 branches, and the test only fed a fake readout). `absent` now travels
   * WITH the facts; the readout's job is to print what it is handed.
   */
  function contractFacts(): { facts: ContractFacts; absent?: string } {
    const state = host.state();
    const { inGit: sessionInGit, primary: primaryRepoRoot } = host.repos();
    const none = (absent: string): { facts: ContractFacts; absent: string } => ({
      facts: { rows: [] },
      absent,
    });
    if (!sessionInGit) return none("这里不是 git 仓库 —— 契约（goal / plan）都是按仓库谈的");
    if (deps.isJudgePane()) return none("judge 会话审的是别人的契约，自己不持有一份");
    if (state.taskMode === "orchestrator") {
      // Absent file, unreadable JSON and an archived plan all answer the same
      // way here: no plan ⇒ no rows.
      const rows = planContractRows(readPlanFile(primaryRepoRoot).plan?.tasks);
      return rows.length > 0
        ? { facts: { kind: "plan", rows } }
        : none("没有可显示的 plan：.pi/orchestrator-plan.json 不在、不是合法 JSON，或已被归档");
    }
    if (!isEnforcedMode(state.taskMode)) {
      return none(`本会话模式是 ${state.taskMode ?? "未初始化"}，它不持有 plan/goal 契约`);
    }
    if (!deps.goalStageSatisfied()) {
      return none(
        deps.goalStageOn()
          ? (deps.loopGoalPresent(primaryRepoRoot)
            ? "goal 还是一份草稿：用户没批准过这段文本（批准了才有退出标准可看）"
            : "还没有 goal 文件 —— 先反述需求、让用户批准一份退出契约")
          : "goal 环节已关闭（用户设定的环节开关）—— 本会话不持有 goal 契约",
      );
    }
    const rows = goalCriteriaRows();
    return rows.length > 0
      ? { facts: { kind: "goal", rows } }
      : none("已批准的 goal 里解析不出「退出标准」小节的条目");
  }

  /**
   * The approved goal's criteria as contract rows, read from the RAW FILE.
   *
   * NOT `LoopGoal.text`: that copy is capped at LOOP_GOAL_MAX_CHARS for the
   * prompt, and 15 of this repo's 48 goal files have criteria running past the
   * cut (measured while writing this). A file that cannot be read is no rows —
   * the same answer as a goal whose criteria section is empty, which is the
   * case `contractFacts` explains.
   */
  function goalCriteriaRows(): ContractFacts["rows"] {
    try {
      return parseGoalCriteria(readFileSync(deps.loopGoalPath(host.repos().primary), "utf8"))
        .map((text) => ({ text, state: "pending" }));
    } catch {
      return [];
    }
  }

  /**
   * What `/gate-contract` prints: the contract lines, and — when there are none
   * — WHY, in the gate's own words.
   *
   * Which situation this is, and what it is called, is `contractFacts`' own
   * answer; the pairing of an empty list with its reason is
   * `buildContractReadout`'s (lib/ui-widget.ts) — an empty list can never
   * reach the command unexplained.
   */
  function contractReadout(): { lines: string[]; absent?: string } {
    const { facts, absent } = contractFacts();
    return buildContractReadout(facts, absent);
  }

  function updateWidget(ctx: ExtensionContext) {
    // Idempotent re-arm (round-2 P2: the session_shutdown comment promised
    // this and it did not exist): every widget-refresh path — the 5s timer
    // tick, session_start, an explicit updateWidget call — guarantees the
    // timer is running, so a later session_shutdown cannot leave the widget
    // frozen. The tick calls updateWidget, which calls armUiRefreshTimer,
    // which no-ops when the timer already exists — no recursion hazard.
    armUiRefreshTimer();
    lastUiCtx.current = ctx;
    let hasUI: boolean;
    try {
      hasUI = ctx.hasUI;
    } catch {
      // Stale ctx: the session was replaced or reloaded (resume / switch /
      // fork) and this captured ctx now THROWS on any access (pi hard-
      // asserts). Drop it — the next session_start installs a fresh one.
      // This must never escape as an uncaught exception: the 5s refresh
      // timer ticked a stale ctx right after resume, threw inside the timer,
      // and killed the whole pi process — the resumed session died before
      // it could come back.
      lastUiCtx.current = undefined;
      return;
    }
    if (!hasUI) return;
    // belowEditor — the gate status strip. Content-compared so pi only
    // re-renders when something actually changed.
    try {
      const lines = buildGateWidget(gateWidgetFacts());
      const key = lines.join("\n");
      // THE RENDERER PROBE — invisible, and removed the moment it has
      // answered. The `setWidget` FACTORY form is the only place the host hands
      // an extension the real TUI, and `tui.mode` is the only honest answer to
      // "is this session on the renderer that can scroll a tall dialog?" (a
      // config re-derivation would be a copy that gets the corners wrong —
      // lib/renderer-mode.ts).
      //
      // A PROBE, and not the widget itself (round-1 quality P0/P2,
      // 2026-09-16): a factory component must wrap its own lines (`render(width)`),
      // while the string[] form is what wraps each line through pi-tui's
      // `Text` — and pi's RPC host ignores component factories entirely, so
      // making the status strip a factory would delete it there.
      //
      // RE-PROBED when the status strip changes (round-2/3 P2, same day): the
      // mode can change mid-session — `/settings` applies immediately — and the
      // probe is the only place that reads it. It used to run on EVERY widget
      // update, which is every 5s from the refresh timer plus every persist
      // (round-3 P1); moving it inside the content-changed branch keeps the
      // reading while making its cost follow real changes. The residual corner
      // is named: a mode flipped while the strip's content stays identical
      // mid-session is not noticed until that content moves. The NOTICE stays
      // once-per-session (`rendererModeNoticeShown`).
      if (key !== lastAgentsWidget) {
        lastAgentsWidget = key;
        ctx.ui.setWidget("review-gate-renderer-probe", (tui) => {
          noteRendererMode(tui.mode, ctx);
          return { render: () => [], invalidate: () => {} };
        }, { placement: "belowEditor" });
        ctx.ui.setWidget("review-gate-renderer-probe", undefined);
        ctx.ui.setWidget("review-gate-agents", lines, { placement: "belowEditor" });
      }
    } catch { /* display-only */ }
  }

  // Refresh the TUI widgets periodically while sub-agents run: agent_settled
  // only fires for the MAIN session, so a turn spent waiting on a sub-agent
  // would otherwise freeze the running-agents list. One cheap dir scan + a few
  // small file reads every 5s, content-compared inside updateWidget; .unref()
  // so the timer never keeps the process alive. Display-only — no gate reads
  // this state.
  //
  // The timer is owned by the CURRENT session instance: session_shutdown
  // disarms it, session_start (and updateWidget, idempotently) re-arms it.
  // A tick against a captured ctx from a replaced/reloaded session throws on
  // `ctx.hasUI`; before this guard that uncaught exception killed pi right
  // after every resume. The body is additionally crash-proofed: a stale ctx
  // is dropped, never re-thrown.
  let uiRefreshTimer: ReturnType<typeof setInterval> | undefined;
  function armUiRefreshTimer(): void {
    if (uiRefreshTimer) return;
    uiRefreshTimer = setInterval(() => {
      try {
        if (lastUiCtx.current) updateWidget(lastUiCtx.current);
      } catch {
        // Display-only — a widget refresh must never take the process down.
        // A stale ctx is dropped here and reinstalled by the next
        // updateWidget with a fresh one.
        lastUiCtx.current = undefined;
      }
    }, 5000);
    uiRefreshTimer.unref();
  }
  function disarmUiRefreshTimer(): void {
    if (uiRefreshTimer) {
      clearInterval(uiRefreshTimer);
      uiRefreshTimer = undefined;
    }
  }

  return { gateWidgetFacts, contractReadout, updateWidget, armUiRefreshTimer, disarmUiRefreshTimer };
}
