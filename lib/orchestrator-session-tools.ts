/**
 * The SESSION LIFECYCLE tools — what a child is doing, and when it ends:
 * wait and close. Plus the registration of every orchestration session tool.
 *
 * The DISPATCH half — spawn and send, i.e. getting work INTO a child — lives
 * in lib/orchestrator-dispatch.ts. The two were one file until this round's
 * delivery-verification work pushed it past the 600-line standard the
 * repository holds itself to, and the split follows a real seam: dispatch
 * answers "did the other side actually receive this" (F1/F7/F8/F11), while
 * this half answers "what is it doing now, and is it still alive"
 * (F12/F14). The two lifecycle tool bodies later moved out for the same
 * reason: `orchestrator_wait` lives in lib/orchestrator-wait-tool.ts and
 * `orchestrator_close` in lib/orchestrator-close-tool.ts, so this file is the
 * ONE place that answers "which orchestration tools exist".
 *
 * The invariant both halves share: the orchestrator expresses INTENT and the
 * gate performs the ACT. It names a task, not a split direction; a child, not
 * a pane id; "wait", not a polling loop. Every tmux argv is built by
 * lib/orchestrator-tmux.ts, every pane it may touch is one the registry
 * created, and the blast radius is one window.
 *
 * Read this alongside lib/orchestrator-tools.ts (the plan tool),
 * which is the half that never leaves the sidecar.

 */

import { Type } from "typebox";

import type { OrchestratorDeps, ToolHost, ToolReply } from "./orchestrator-deps.ts";

/**
 * The orchestration deps, whole.
 *
 * `decoratedJudgePanes()` used to be added here — for the single decision "may
 * this close take the window's shared label bar down" — and is GONE with that
 * decision (2026-09-17, user decision): the bar is never taken down, because
 * toggling it resizes every pane in the window. See `closeSessionPane` in
 * lib/session-factory.ts.
 */
export type OrchestratorSessionDeps = OrchestratorDeps;

import { readInheritance } from "./session-inheritance.ts";
import { dispatchInstruct, dispatchSpawn } from "./orchestrator-dispatch.ts";
import { doWait } from "./orchestrator-wait-tool.ts";
import { doClose } from "./orchestrator-close-tool.ts";
import { registerOrchestratorAnswerTool } from "./orchestrator-answer-tools.ts";
import { registerOrchestratorRecoveryTools } from "./orchestrator-recovery-tools.ts";
import { requireOrchestratorMode } from "./orchestrator-tool-kit.ts";

/**
 * Register the orchestration session tools.
 *
 * Five live in this file (spawn / instruct / wait / close) and two are
 * delegated to their own modules (`orchestrator_answer`,
 * `orchestrator_recover` + `orchestrator_attach`) — registered from here so
 * there is ONE place that answers "which orchestration tools exist".
 *
 * `orchestrator_handoff` USED to live here and is GONE (2026-09-14,
 * philosophy three): handing over is every session's move, not the project
 * manager's, so it is registered once for all four kinds of session as
 * `session_handoff` (lib/session-handoff-tools.ts). Two entry points for one
 * act is exactly what philosophy two forbids — and the old one was the
 * failing half of it.
 */
export function registerOrchestratorSessionTools(host: ToolHost, deps: OrchestratorSessionDeps): void {
  const guarded = (
    run: (params: Record<string, unknown>, signal: { readonly aborted: boolean } | undefined) => Promise<ToolReply>,
  ) => async (
    _id: string,
    params: Record<string, unknown>,
    signal: { readonly aborted: boolean } | undefined,
  ): Promise<ToolReply> => {
    const refusal = requireOrchestratorMode(deps);
    if (refusal) return refusal;
    return run(params, signal);
  };

  registerOrchestratorAnswerTool(host, deps);
  registerOrchestratorRecoveryTools(host, deps);


  host.registerTool({
    name: "orchestrator_spawn",
    label: "Spawn Child Session",
    description:
      "Open an interactive CHILD SESSION for one plan task, in a pane of THIS window. The gate " +
      "picks the pane from the WINDOW's own layout (three columns: the first two hold one session " +
      "each, the third shares its height), injects the orchestration id " +
      "so the child's wake-ups survive a relay, starts it in loop mode in the repo its task " +
      "declares. A second child in the SAME repo gets its OWN `git worktree` on its own branch " +
      "(2026-09-10) so same-repo tasks run in parallel; if that checkout cannot be created the " +
      "spawn is REFUSED rather than putting two writers in one checkout. Then it registers the " +
      "pane — a pane nobody registered cannot be addressed later. Requires a plan the USER approved.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Plan task id this child will work on" }),
      task: Type.Optional(Type.String({
        description:
          "Opening message sent to the child right away. OMIT IT and this task's `note` (its task book, " +
          "the text the plan was audited and approved for) is used verbatim — pass one only to tailor the " +
          "opening message beyond the task book.",
      })),
    }),
    execute: guarded((params) => dispatchSpawn(deps, params)),
  });

  host.registerTool({
    name: "orchestrator_instruct",
    label: "Instruct A Child Session",
    description:
      "Say something to a running child session, or stop it. `mode` IS pi's own delivery, and it " +
      "DEFAULTS to `interrupt` — a supervisor writes because the child should know NOW, so the " +
      "ordinary call aborts the turn it is in the middle of and the message is read immediately " +
      "(an interrupt carries its text in this same call). The one alternative is `steer`: it cuts " +
      "into the current turn WITHOUT aborting it, for a nudge the child should carry on with. " +
      "`followUp` (\"finish first, then read this\") is REFUSED here — a correction that arrives " +
      "after the round it was meant to correct is a correction nobody applied. Nothing is typed at " +
      "a terminal: the text is written to the child's channel and the child's OWN gate injects it " +
      "with `pi.sendUserMessage`, so it cannot be truncated, cannot be split by a newline, and " +
      "cannot be misread by an open dialog as a menu selection (all four were measured). The " +
      "receipt is EARNED — this fails unless the child acknowledges that it injected the message. " +
      "To ANSWER a question the child is waiting on, use `orchestrator_answer`, not this.",
    parameters: Type.Object({
      childId: Type.String(),
      mode: Type.Optional(Type.String({
        description: "\"interrupt\" (default) | \"steer\". \"followUp\" is refused.",
      })),
      message: Type.Optional(Type.String({ description: "The text to deliver. Required for every mode (interrupt included) — say what the child should do instead." })),
    }),
    execute: guarded((params) => dispatchInstruct(deps, params)),
  });


  host.registerTool({
    name: "orchestrator_wait",
    label: "Wait For A Child Session",
    description:
      "The orchestrator's ONE information channel — call it every round instead of ending your " +
      "turn. It blocks until something happens to a child of THIS orchestration, and the gate " +
      "looks for itself rather than only listening: every poll re-reads each child's channel, so " +
      "a child that raised a question (waiting-input), one that FINISHED (done), one that quietly " +
      "STOPPED (idle), one that went silent while its pane lives (stalled) and one whose pane " +
      "vanished (dead) each produce an event even when nothing rang. A question that is ALREADY " +
      "hanging when you call ends the very first probe — it is a fact on the channel, not a state " +
      "change — and one you leave unanswered rings again on a 10s→30s→60s backoff; a completion " +
      "rings twice, 60s apart, then stays quiet. " +
      "EVERY reply — blocked, interrupted or instant — carries the same four blocks: (1) the " +
      "health of every child, (2) the questions waiting for you, with their full text and every " +
      "option, structured (nothing is read off a screen), (3) dead / stalled children with the " +
      "assets that survived them and the action that recovers each, and (4) YOUR OWN context " +
      "usage with the handover call, computed by the gate — you never look that up yourself. " +
      "Pass `timeoutMs: 0` for an instant snapshot (this replaced the separate status tool). " +
      "Unlike a judge child, an orchestration child does NOT exit when it finishes, so waiting " +
      "for a process to end would hang forever.",
    parameters: Type.Object({
      childId: Type.Optional(Type.String({ description: "Omit to wait on any child" })),
      timeoutMs: Type.Optional(Type.Integer({
        description: "Blocking window (default 300000, max 900000). 0 = instant snapshot.",
      })),
    }),

    execute: guarded((params, signal) => doWait(deps, params, signal)),
  });

  host.registerTool({
    name: "orchestrator_close",
    label: "Close A Child Session",
    description:
      "Close a registered child's pane (`childId`). Nothing else is addressable: the user's own " +
      "panes and other orchestrations' panes are refused, and a handover's predecessor pane is " +
      "closed by the GATE (`session_handoff`), never by a session. " +
      "A child's pane is killed; its transcript and gate state survive on disk.",
    parameters: Type.Object({
      childId: Type.Optional(Type.String()),
      worktree: Type.Optional(Type.Enum({
        keep: "keep",
        merge: "merge",
        discard: "discard",
      }, {
        description:
          "What happens to a child's ISOLATED CHECKOUT, when it had one (it gets one whenever " +
          "another child was already working in the same repo). `keep` (default) leaves it and says " +
          "so — the work in it is often the only copy. `merge` commits whatever the child left " +
          "uncommitted and merges its branch into YOUR checkout, STAGED and uncommitted (use `git " +
          "merge --abort` to undo it); the child's worktree and branch are then LEFT IN PLACE, " +
          "because a staged merge is not a committed one — reclaim them with `discard` once you have " +
          "committed. A conflict aborts and leaves your checkout exactly as it was, with the child's " +
          "work still in its own worktree. `discard` removes the checkout and its branch.",
      })),
    }),
    execute: guarded((params) => doClose(deps, params)),
  });

}

/** Re-exported for the extension's own child-session directive injection. */
export { readInheritance };
