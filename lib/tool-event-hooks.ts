/**
 * THE TOOL-EVENT HOOKS — what the gate does after every tool call
 * (`tool_result`), on every user message (`input`) and when a background agent
 * finishes. Moved out of `extensions/review-gate.ts` (t8, 2026-09-26, wave 4); the edit
 * branch of `tool_result` is lib/edit-tracking-hook.ts, the L1 `tool_call`
 * decision is lib/ship-gate-hook.ts.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  MessageEndEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { createChildSide } from "./child-side-host.ts";
import { armCopilotReview } from "./copilot-review-state.ts";
import { BASH_WRITE_NUDGE, looksLikeBashFileWrite } from "./edit-discipline.ts";
import type { ToolResultPatch } from "./edit-tracking-hook.ts";
import { armingFromFacts } from "./gate-arming.ts";
import type { GateState } from "./gate-state.ts";
import { invalidateBindings } from "./gate-state-transitions.ts";
import { observeInspection } from "./judge-inspection.ts";
import { readJudgeSideEnv } from "./judge-side.ts";
import { goalReminderDue } from "./loop-goal-directives.ts";
import { notifyUserInput } from "./poll-wait.ts";
import { parsePrecommitOutput } from "./precommit-parse.ts";
import { evaluateReadonlyStall, readonlyStallNudgeFor } from "./readonly-stall.ts";
import { resolveCommandRepos } from "./repo-resolve.ts";
import { armLoop, clearBypassToken, type SessionCells } from "./session-cells.ts";
import { detectShipCommands, observedShipKinds } from "./ship-detect.ts";
import { existingPrNotice, probeOpenPr } from "./station-pr-evidence.ts";
import { FULL_LANE_NUDGE, looksLikeFullLaneRun } from "./test-run-discipline.ts";
import { changedFiles } from "./worktree-changes.ts";

// 2026-08-31 (P0, onchain deadlock investigation): `replace` / `insert` are
// pi's hashline edit tools and were MISSING here — a session could edit files
// through them while every edit gate (L8 goal gate, sensitive-file floor,
// orchestrator write restriction, edit tracking) was silently skipped.
export const EDIT_TOOL_NAMES = new Set(["edit", "write", "Edit", "Write", "NotebookEdit", "notebook_edit", "replace", "insert"]);

// D (2026-09-01): read-only tools whose results carry the goal-negotiation
// reminder while this session is loop-mode and its goal is unapproved.
// `bash` is deliberately excluded: a read-only bash command (ls, git log)
// must not be nagged — the reminder targets the agent's passive reading.
const READ_ONLY_TOOL_NAMES = new Set([
  "read", "read_file", "Read", "read_more",
  "grep", "anchor_grep", "rg",
  "ls", "cat", "head", "tail",
]);

/** D — one-line advisory appended to read-only results while the session is
 * loop-mode and its loop goal is not yet confirmed. Not a block: the L8 edit
 * gate is the enforcement, this text just keeps the negotiation in front of
 * an agent that is busy reading. */
const GOAL_REMINDER_TEXT =
  "\n[review-gate] 你还没协商并获批本会话的 loop goal —— 顺序是先用 `propose_restatement` " +
  "把需求反述给用户确认（没有它 `propose_loop_goal` 会直接被拒、不弹框），再 `propose_loop_goal` " +
  "走完协商，然后才改代码（未批准前 L8 会拦下 edit/write）。";
const GOAL_REMINDER_MIN_MS = 5 * 60_000; // every 5 minutes at most
const GOAL_REMINDER_CAP = 2; // per session at most

type ChildSide = ReturnType<typeof createChildSide>;

export interface ToolResultHookDeps {
  childSide: Pick<ChildSide, "noteChildProgress" | "observeBackgroundToolResult">;
  isJudgePane(): boolean;
  judgeCurrentRound(): number | undefined;
  judgeOwnPaths(): string[];
  goalStageSatisfied(): boolean;
  stateForRepo(root: string): GateState;
  persistRepo(ctx: ExtensionContext, root: string): void;
  onEditResult(event: ToolResultEvent, ctx: ExtensionContext): ToolResultPatch;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c !== "object" || c === null) return "";
      const o = c as Record<string, unknown>;
      return String(o.text ?? o.content ?? "");
    }).join("\n");
  }
  return "";
}

/** Append one nudge to a result, keeping its error semantics. */
function withNudge(event: ToolResultEvent, text: string, isError: boolean): ToolResultPatch {
  return { content: [...(event.content ?? []), { type: "text", text }], isError };
}

export function createToolResultHook(cells: SessionCells, deps: ToolResultHookDeps) {
  /** The drill counter, for the read family and bash alike. */
  function readonlyNudge(event: ToolResultEvent): ToolResultPatch {
    // Read-only drill stall guard (lib/readonly-stall.ts) — PRODUCTIVITY,
    // not liveness: count consecutive successful read-family calls with no
    // edit landing in between; at READONLY_STALL_LIMIT append the nudge
    // (never a block). WHO HEARS IT is `readonlyStallNudgeFor`'s decision.
    // State is in-memory only.
    const nudgeText = readonlyStallNudgeFor(cells.state.taskMode);
    if (nudgeText === undefined || event.isError === true) return undefined;
    const stall = evaluateReadonlyStall({
      previous: cells.readonlyStallState,
      produced: false,
      read: true,
    });
    cells.readonlyStallState = stall.state;
    // The enclosing condition excludes isError:true, so the result is not an
    // error; keep the original semantics (false).
    return stall.nudge ? withNudge(event, nudgeText, false) : undefined;
  }

  /**
   * 1.5 D — goal-negotiation reminder on read-only tools (advisory, throttled).
   *
   * MEASURED (2026-09-01, onchain): an orchestration child read code for four
   * minutes and then died without negotiating its goal. The L8 edit gate
   * cannot remind an agent that keeps READING. Never blocks; throttled
   * (user decision, 2026-09-01). Explore/normal never remind.
   */
  function onReadOnlyResult(event: ToolResultEvent): ToolResultPatch {
    const state = cells.state;
    const nowMs = Date.now();
    const canRemind =
      state.taskMode !== "explore" &&
      state.taskMode !== "normal" &&
      state.taskMode !== "orchestrator" &&
      !deps.goalStageSatisfied() &&
      goalReminderDue({
        now: nowMs,
        lastAt: cells.lastGoalReminderAt,
        count: cells.goalReminderCount,
        minMs: GOAL_REMINDER_MIN_MS,
        cap: GOAL_REMINDER_CAP,
      });
    if (canRemind) {
      cells.lastGoalReminderAt = nowMs;
      cells.goalReminderCount += 1;
      return withNudge(event, GOAL_REMINDER_TEXT, event.isError === true);
    }
    return readonlyNudge(event);
  }

  /** 2. Bash: precommit re-arming + stash/checkout re-arming, then the nudges. */
  async function onBashResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultPatch> {
    const state = cells.state;
    const cwd = cells.cwd;
    const primaryRepoRoot = cells.primaryRepoRoot;
    const stateOf = (root: string) => (root === primaryRepoRoot ? state : deps.stateForRepo(root));
    const text = contentText(event.content);
    const cmd = (event.input as Record<string, unknown>)?.command as string | undefined;

    // ROOT-CAUSE FIX (adviser): plain bash stdout can NEVER grant a PASS — the
    // ONLY way to record PASS is the run_precommit step, which spawns the
    // trusted runner itself and verifies a private nonce receipt. Here bash
    // output may only INVALIDATE a prior PASS as a safety net.
    if (text) {
      const verdict = parsePrecommitOutput(text);
      if (verdict && verdict !== "PASS") {
        // P-multi: a FAIL sentinel invalidates a standing PASS in EVERY repo
        // this session tracks.
        for (const root of cells.sessionRepos) {
          const st = stateOf(root);
          if (st.precommit.verdict === "PASS") {
            st.precommit = { verdict, fingerprint: null, at: new Date().toISOString() };
            deps.persistRepo(ctx, root);
          }
        }
      }
    }
    // P0-7: re-arm gate if a git operation restored dirty state without going
    // through an edit tool (bypass prevention). P-multi: the command's own
    // repos (cd chain / git -C) are re-armed, not just cwd.
    if (cmd && /(^|[\s;&|])(git\s+(stash\s+(pop|apply)|checkout|switch|restore|reset\s+--hard|merge|pull|rebase|cherry-pick|am)|gh\s+pr\s+checkout)\b/.test(cmd)) {
      const cmdRepos = resolveCommandRepos(cmd, cwd);
      const rearmRoots = new Set(cmdRepos.repos);
      if (cmdRepos.ambiguous) {
        for (const r of cells.sessionRepos) rearmRoots.add(r);
      }
      for (const root of rearmRoots) {
        const files = changedFiles(root);
        if (!files || files.length === 0) continue;
        const st = stateOf(root);
        // User-granted scope limit: files still in the exempt snapshot never
        // re-arm the gate; anything newer still does (fail-closed). Scope
        // limits are primary-repo-only; other repos always arm.
        const exempt = root === primaryRepoRoot ? new Set(state.scopeLimit?.preexistingFiles ?? []) : new Set<string>();
        const arming = exempt.size > 0 ? files.filter((f) => !exempt.has(f)) : files;
        // The file-kind half of the rule is `lib/gate-arming.ts`'s, here as
        // everywhere (2026-09-20). `commitsAhead: 0` — this site re-arms on
        // what the git command just restored, not on the branch's history.
        const armed = armingFromFacts({ files: arming, commitsAhead: 0 });
        if (armed.hasCodeChange && !st.hasCodeChange) { st.hasCodeChange = true; }
        if (armed.hasDocChange && !st.hasDocChange) { st.hasDocChange = true; }
        if (st.hasCodeChange || st.hasDocChange) {
          invalidateBindings(st);
          clearBypassToken(cells);
          deps.persistRepo(ctx, root);
        }
      }
    }
    // DELIVERY-STATION EVIDENCE: which ship kinds the gate WATCHED succeed in
    // each repo. `event.isError !== true` is the whole point — an observation
    // of an exit code, not a claim. Independent of the Copilot block below
    // (round-1 reviewer P1). The KINDS come from `observedShipKinds`, not from
    // the over-matching `detectShipCommands` (round-2/3 reviewer P2).
    if (cmd && event.isError !== true && state.taskMode !== "normal") {
      const shipped = observedShipKinds(cmd);
      if (shipped.length > 0) {
        const cmdRepos = resolveCommandRepos(cmd, cwd);
        const roots = cmdRepos.ambiguous ? new Set(cells.sessionRepos) : new Set(cmdRepos.repos);
        for (const root of roots) {
          const st = stateOf(root);
          const before = st.shippedKinds ?? [];
          const merged = [...new Set([...before, ...shipped])];
          if (merged.length !== before.length) {
            st.shippedKinds = merged;
            deps.persistRepo(ctx, root);
          }
        }
      }
    }

    // L7: a SUCCESSFUL PR-affecting ship opens a Copilot review round for the
    // repo the command ran in. `git push` counts even when no PR exists yet —
    // the check tool resolves that to UNSUPPORTED. A FAILED command arms nothing.
    if (cmd && event.isError !== true && state.taskMode !== "normal" && cells.projectConfig.copilotReview.enabled) {
      const kinds = new Set(detectShipCommands(cmd).map((d) => d.kind));
      if (kinds.has("pr-create") || kinds.has("pr-edit") || kinds.has("push")) {
        const cmdRepos = resolveCommandRepos(cmd, cwd);
        const armRoots = cmdRepos.ambiguous ? new Set(cells.sessionRepos) : new Set(cmdRepos.repos);
        const nowIso = new Date().toISOString();
        for (const root of armRoots) {
          const st = stateOf(root);
          st.copilot = armCopilotReview(st.copilot, nowIso);
          deps.persistRepo(ctx, root);
          armLoop(cells);
        }
      }
    }

    // Edit-discipline nudge (prompt-only, non-blocking): right after a FAILED
    // edit call, a bash command that looks like a direct file write is the
    // exact workaround pattern — append guidance once and close the window.
    // Deliberately AFTER the state-maintenance above. Skipped in normal mode.
    if (state.taskMode !== "normal" && cells.editFailurePending && cmd && looksLikeBashFileWrite(cmd)) {
      cells.editFailurePending = false;
      return withNudge(event, BASH_WRITE_NUDGE, event.isError === true);
    }

    // Test-run discipline nudge (prompt-only, non-blocking): a manual full
    // `npm test` / `tsc --noEmit` in the MAIN session is pure waste — the
    // submission chain runs the full lane itself, input-cached. Judge panes
    // are exempt (a reviewer's full run in its throwaway worktree IS the job).
    if (state.taskMode !== "normal"
      && readJudgeSideEnv(process.env) === undefined
      && cmd && looksLikeFullLaneRun(cmd)) {
      return withNudge(event, FULL_LANE_NUDGE, event.isError === true);
    }

    // A FAILED `gh pr create`: the branch already has a PR. `gh` reports that
    // case as an ERROR, so the success-only evidence above can never see it —
    // the gate asks GitHub itself and says the answer out loud (2026-09-16,
    // user-requested). Placed BEFORE the read-only stall guard.
    if (
      cmd && event.isError === true && state.taskMode !== "normal"
      && observedShipKinds(cmd).includes("pr-create")
    ) {
      const cmdRepos = resolveCommandRepos(cmd, cwd);
      for (const root of cmdRepos.ambiguous ? cells.sessionRepos : cmdRepos.repos) {
        const notice = existingPrNotice(await probeOpenPr(root));
        if (notice) return withNudge(event, notice, true);
      }
    }

    // Read-only drill stall guard: bash is the drill workhorse, so count it
    // like the read family — deliberately at the END of the bash branch, after
    // every state-maintenance safety net, so this nudge can never skip them.
    return readonlyNudge(event);
  }

  return async function onToolResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultPatch> {
    // E — a completed tool call is forward progress for the child health reading.
    deps.childSide.noteChildProgress("tool");
    // Background-agent wait tracking: a launch starts a wait, a terminal
    // report ends one (lib/background-wait.ts). Runs before every return.
    deps.childSide.observeBackgroundToolResult(event);
    // 0. JUDGE SIDE: the round's mechanical inspection evidence. Folded FIRST,
    // because every branch below returns early and a miss here would read as
    // "this judge inspected nothing". Successful calls only.
    if (deps.isJudgePane() && event.isError !== true) {
      cells.judgeInspection = observeInspection(
        cells.judgeInspection,
        { toolName: event.toolName, input: event.input },
        {
          range: cells.judgeReviewRange,
          // Stamped with the round the registry says we are in, so an
          // abandoned round's reads cannot be credited to the next round.
          round: deps.judgeCurrentRound(),
          // The round's OWN paperwork never counts as having reviewed the
          // repository.
          ownPaths: deps.judgeOwnPaths(),
          // WHOSE round this is (2026-09-22, reviewer P2): for the acceptance
          // judge a successful execution is an inspection action.
          role: readJudgeSideEnv(process.env)?.role,
        },
      );
    }
    // 1. Edits: only arm gate on success.
    if (EDIT_TOOL_NAMES.has(event.toolName)) return deps.onEditResult(event, ctx);
    if (READ_ONLY_TOOL_NAMES.has(event.toolName)) return onReadOnlyResult(event);
    if (event.toolName === "bash") return onBashResult(event, ctx);
    return undefined;
  };
}

/**
 * THE HINTS RIDE THE RESULT (user decision, 2026-09-14). `tool_result`
 * handlers chain like middleware, so this patch is what the REST of the
 * pipeline (and the model) sees as that tool's output: the advice appears
 * under the very command it is about, in one message.
 */
export function appendPendingHints(cells: SessionCells, event: ToolResultEvent): ToolResultPatch | { content: ToolResultEvent["content"] } {
  if (cells.pendingHints.length === 0) return undefined;
  const text = cells.pendingHints.splice(0).join("\n\n");
  try {
    return { content: [...event.content, { type: "text" as const, text: "\n\n" + text }] };
  } catch { /* an unreadable result shape: drop the hint, never the result */ }
  return undefined;
}

/** A real user message: resumes an ESC pause, ends a long block, answers ask_user. */
export function createInputHook(cells: SessionCells, deps: { persist(ctx?: ExtensionContext): void }) {
  return function onInput(event: InputEvent, ctx: ExtensionContext): void {
    // 2026-09-08: the edit-failure nudge window NO LONGER closes on a fresh
    // user message (see edit-discipline.ts).
    // A real user message resumes an ESC-abort pause ("extension" is how the
    // gate injects its own follow-ups — those never count).
    if (event.source !== "extension") cells.lastRunAborted = false;
    // …and it ENDS a long block. `orchestrator_wait` / `judge_wait` are minutes
    // of blocking inside ONE turn, and a message typed during them used to sit
    // in the host's steer queue until the budget ran out (B5). This event fires
    // while a tool is still executing (measured 2026-09-06).
    if (event.source !== "extension") notifyUserInput();

    // A real user message answers a standing ask_user pause: clear it and
    // re-arm auto-continuation so the loop enforces again from this turn on.
    const state = cells.state;
    if (state.pausedQuestion && event.source !== "extension") {
      delete state.pausedQuestion;
      if (state.taskMode !== "explore" && state.taskMode !== "normal") armLoop(cells);
      deps.persist(ctx);
    }
  };
}

/**
 * Background-agent wait tracking, message side AND event-bus side.
 *
 * A `subagent-notification` custom message is pi-subagents' terminal signal
 * for one or more agents — but not enough on its own: pi-subagents skips it
 * when the result was already consumed and holds others back for batch
 * finalization (2026-09-17, a child stuck reporting `working` after its own
 * `declare_done`). The EVENT BUS is the terminal signal EVERY finished run
 * emits. It is OPTIONAL, like every host capability this extension reaches
 * for: a host without a bus keeps the two signals it always had.
 */
export function wireBackgroundWaitSignals(
  pi: Pick<ExtensionAPI, "on"> & { events?: ExtensionAPI["events"] },
  cells: SessionCells,
  childSide: Pick<ChildSide, "foldBackgroundWait" | "reportChildState">,
): void {
  pi.on("message_end", (event: MessageEndEvent) => {
    const custom = event.message as { customType?: string; details?: unknown };
    if (custom.customType !== "subagent-notification") return;
    childSide.foldBackgroundWait({
      kind: "message",
      message: { customType: custom.customType, details: custom.details },
    });
  });
  for (const channel of ["subagents:completed", "subagents:failed"] as const) {
    pi.events?.on?.(channel, (payload) => {
      const changed = childSide.foldBackgroundWait({
        kind: "finished",
        id: (payload as { id?: unknown } | null | undefined)?.id,
      });
      // Nothing was waiting on that agent ⇒ nothing to say.
      if (!changed) return;
      // The state may be changing from `working` to `idle`/`done` RIGHT NOW,
      // and a manager may be sitting in a wait: publish it on this event.
      if (cells.latestCtx) {
        try {
          childSide.reportChildState(cells.latestCtx, undefined, { force: true });
        } catch { /* reporting is never allowed to break the session that runs it */ }
      }
    });
  }
}
