/**
 * `set_gate_mode` — the in-session mode decision and self-service switching.
 * The rules are lib/task-mode.ts's (`evaluateModeChange`); this tool supplies
 * the FACTS and obtains consent. Moved out of `extensions/review-gate.ts` (t8, 2026-09-26).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseChoice, type ChoiceSpec } from "./choice-dialog.ts";
import type { createChildSide } from "./child-side-host.ts";
import { asChoiceHost, type createGateDialogs } from "./gate-dialogs.ts";
import { ORCHESTRATOR_NEEDS_TMUX } from "./orchestrator-directives.ts";
import type { SessionCells } from "./session-cells.ts";
import {
  buildModeConfirmMessage,
  evaluateModeChange,
  isEnforcedMode,
  MODE_CONFIRM_TITLE,
  normalizeTaskMode,
  type TaskMode,
  type TaskModeSource,
} from "./task-mode.ts";
import type { ToolHost } from "./tool-host.ts";

export interface GateModeToolDeps {
  setTaskMode(mode: TaskMode, source: TaskModeSource, ctx: ExtensionContext): void;
  askChoice: ReturnType<typeof createGateDialogs>["askChoice"];
  reportChildState: ReturnType<typeof createChildSide>["reportChildState"];
  /** Started BY an orchestrator as a worker (not as its relay successor). */
  isOrchestrationChild(): boolean;
  loopGoalDirectiveText(): string;
}

export function registerGateModeTool(host: ToolHost, cells: SessionCells, deps: GateModeToolDeps): void {
  host.registerTool({
    name: "set_gate_mode",
    label: "Set Gate Mode",
    description:
      "Decide or change this session's gate mode: \"loop\" (full enforced review loop), " +
      "\"explore\" (investigation — advisory gates, ship commands still blocked), or \"normal\" " +
      "(gate fully off). Call this FIRST in a new session to classify the task — YOUR pick is the " +
      "classification; no external model second-guesses it. You can only classify yourself INTO the " +
      "gate: a first \"loop\" always applies, a first \"explore\" applies while this session is still " +
      "clean, but \"normal\" (gate fully off) always needs the user's confirmation dialog. " +
      "In a Temp dir (/tmp) nothing is forced: the gate only nudges — trivial work should go " +
      "\"normal\", delivery work runs the same modes as anywhere else. " +
      "Upgrades (toward loop) apply immediately (a non-git directory still refuses enforced " +
      "modes via the agent; only the user can force one via /gate-mode). Downgrades after the first classification pop a " +
      "confirmation dialog for the user — you cannot approve it yourself, and a declined " +
      "dialog locks further agent-initiated downgrades for this session. " +
      "\"orchestrator\" is the PROJECT-MANAGER role — loop plus the orchestration constraints " +
      "(you write no code, a plan the user approved authorizes every child session, and " +
      "declare_done additionally requires an empty task queue and no live children). Pick it " +
      "only when the user asked you to supervise rather than to build; it requires tmux.",
    parameters: Type.Object({
      mode: Type.String({ description: '"loop" | "explore" | "normal" | "orchestrator"' }),
      reason: Type.String({ description: "One-line justification (shown to the user as untrusted data)" }),
    }),
    async execute(_id, rawParams, _signal, _onUpdate, rawCtx) {
      const params = rawParams as { mode: string; reason: string };
      const ctx = rawCtx as ExtensionContext;
      const state = cells.state;
      const requested = normalizeTaskMode(params.mode.trim());
      if (requested === undefined) {
        return {
          content: [{ type: "text", text: 'review-gate: unknown mode — use "loop", "explore", "normal", or "orchestrator". "plan" / "goal" / "review" are internal-only: the gate places them onto spawned sessions itself, an agent can never pick them.' }],
          details: {},
          isError: true,
        };
      }
      // ORCHESTRATOR PRECONDITIONS. Both are facts about the environment, not
      // judgements, so they are checked before the rule engine ever runs:
      //  - no tmux ⇒ the role is impossible (its children ARE panes of the
      //    user's window, and a relay is a split);
      //  - a session STARTED as somebody's orchestration child must never
      //    become an orchestrator itself — it would start answering its own
      //    bell. A relay successor is exempt (it carries a predecessor pane).
      if (requested === "orchestrator") {
        if (!process.env.TMUX) {
          return {
            content: [{ type: "text", text: ORCHESTRATOR_NEEDS_TMUX }],
            details: { mode: state.taskMode ?? null },
            isError: true,
          };
        }
        if (deps.isOrchestrationChild()) {
          return {
            content: [{
              type: "text",
              text:
                "review-gate: 本会话是某个编排的**子会话**（环境里带着 RG_ORCHESTRATION_ID），" +
                "不能自己变成项目经理 —— 那会让它接管管着自己的那个 orchestration 的通知渠道。" +
                "你就是普通 loop 会话：干活、送审、declare_done；有事项目经理会找你。",
            }],
            details: { mode: state.taskMode ?? null },
            isError: true,
          };
        }
        // THE IDENTITY TAKE-OVER GUARD USED TO BE HERE, AND THAT WAS THE BUG
        // (2026-09-06, B1): entering the role grants nothing on its own — what
        // needs an identity is writing/submitting a plan and spawning a child,
        // and all three refuse on `runtimeConflict`. Refusing the mode itself
        // put `orchestrator_attach` / `orchestrator_plan({action:"archive"})`
        // behind the very door it was holding shut.
      }
      // FIRST CLASSIFICATION: while the mode is undecided and THIS session has
      // not edited anything, the AGENT's own pick IS the classification — the
      // pure rule engine below is what bounds it.
      let effective = requested;
      // NON-GIT SHORT-CIRCUIT (2026-09-02, user decision): outside a git
      // repository the enforced modes are impossible. Clamp loop/orchestrator
      // to normal BEFORE evaluateModeChange so a loop upgrade request can
      // never reach the rule engine as a real loop.
      const nonGitTask = !cells.sessionInGit;
      if (nonGitTask && state.taskMode === undefined && (effective === "loop" || effective === "orchestrator")) {
        effective = "normal";
      }
      // The pure rule engine decides; this tool only supplies FACTS. Consent
      // is obtained below by the EXTENSION (there is deliberately no
      // "confirmed" parameter the model could set). hasChanges = THIS
      // session's own edits only. piSelfTask now means non-git directories
      // only: Temp dirs are NOT clamped anymore (criterion 6 — nudge instead).
      const decision = evaluateModeChange({
        current: state.taskMode,
        requested: effective,
        hasChanges: cells.sessionEdited,
        hasUI: ctx.hasUI,
        downgradesLocked: cells.agentDowngradesLocked,
        piSelfTask: !cells.sessionInGit,
        // NON-GIT (2026-09-02): the clamp comes from the non-git rule, so the
        // reject reason must say so (reviewer P2).
        clampReason: !cells.sessionInGit
          ? `this session is not inside a git repository — non-git directories cannot enter "${effective}" via the agent. Ask the user to run /gate-mode ${effective} if they really want the enforced workflow here.`
          : undefined,
      });

      if (decision.action === "noop") {
        // Criterion 3: EVERY return path reports to the supervisor.
        deps.reportChildState(ctx, `gate mode already ${effective}（noop）`, { force: true, state: "mode-changed" });
        return {
          content: [{ type: "text", text: `review-gate: gate mode is already "${effective}".` }],
          details: { mode: effective },
        };
      }

      if (decision.action === "apply") {
        // NON-GIT (2026-09-02): a non-git directory still clamps loop/orchestrator
        // to normal without confirmation; Temp dirs only get a nudge (criterion 6).
        const nonGitFirst = !cells.sessionInGit && state.taskMode === undefined;
        deps.setTaskMode(effective, decision.source, ctx);
        try {
          const sourceNote = nonGitFirst
            ? "（非 git 目录，规则禁止 loop，无需确认）"
            : "";
          ctx.ui.notify(
            effective === "loop"
              ? `review-gate: 会话类型已判定为循环任务${sourceNote}。可用 /gate-mode 切换。`
              : effective === "orchestrator"
                ? `review-gate: 本会话已进入项目经理（orchestrator）模式${sourceNote} — 你负责统筹调度，不写代码；plan 需用户批准后才能开子会话。可用 /gate-mode 切换。`
                : effective === "explore"
                  ? `review-gate: 会话类型已判定为探查任务${sourceNote} — gate 仅供参考，AI 可自主结束（commit/push 等 ship 命令仍被完整拦截）。可用 /gate-mode 切换。`
                  : `review-gate: 会话类型已判定为普通任务${sourceNote} — 本会话门禁关闭。可用 /gate-mode 切换。`,
            isEnforcedMode(effective) ? "info" : "warning",
          );
        } catch { /* headless */ }
        // Loop mode decided ⇒ deliver the Step 0 loop-goal directive right
        // here: before_agent_start only injects it on the NEXT turn.
        const goalNote = effective === "loop" ? "\n\n" + deps.loopGoalDirectiveText() : "";
        return {
          content: [{
            type: "text",
            text:
              `review-gate: gate mode set to "${effective}" (source: ${decision.source})` +
              (effective !== requested
                ? `。你请求的是 "${requested}"，目录规则已将其调整为 "${effective}"（非 git 目录禁 enforced 模式）。`
                : ".") +
              goalNote,
          }],
          details: { mode: effective, source: decision.source },
        };
      }

      if (decision.action === "confirm") {
        // USER CONSENT — rendered by the extension with fixed consequence copy;
        // the agent's reason is displayed as clearly-labeled untrusted data.
        // The copy is built from `effective`, never from `requested`.
        const confirmLabel = `确认降级到 ${effective}`;
        const keepLabel = `保持当前模式（${state.taskMode ?? "undecided"}）`;
        const spec: ChoiceSpec = {
          title: MODE_CONFIRM_TITLE,
          options: [confirmLabel, keepLabel],
          // The SAFE option is the recommendation: a downgrade turns the
          // enforced workflow off, so the gate never nudges the user into it.
          recommended: keepLabel,
        };
        let ok = false;
        /** The user's own typed reason for keeping the mode, when they gave one. */
        let declineReason: string | undefined;
        try {
          const pick = parseChoice(
            await deps.askChoice(
              asChoiceHost(ctx),
              spec,
              { body: buildModeConfirmMessage(effective, params.reason) },
            ),
            spec,
          );
          ok = pick.kind === "chose" && pick.option === confirmLabel;
          declineReason = pick.kind === "declined" && pick.reason ? pick.reason : undefined;
        } catch { ok = false; }
        if (ok) {
          deps.setTaskMode(effective, "user", ctx);
          return {
            content: [{ type: "text", text: `review-gate: the user CONFIRMED the downgrade — gate mode is now "${effective}".` }],
            details: { mode: effective, source: "user" },
          };
        }
        // Declined: lock agent-initiated downgrades for this session so the
        // dialog cannot be re-popped until the user acts (/gate-mode).
        cells.agentDowngradesLocked = true;
        // Criterion 3: a DECLINED downgrade is still a mode-related event the
        // supervisor must not miss.
        deps.reportChildState(ctx, `gate mode 降级被用户拒绝（保持 ${cells.state.taskMode ?? "undecided"}）`, { force: true, state: "mode-changed" });
        return {
          content: [{
            type: "text",
            text:
              "review-gate: the user DECLINED the downgrade." +
              (declineReason ? ` 用户的意见：${declineReason}` : "") +
              " Agent-initiated downgrades are now " +
              "locked for this session — continue under the current mode and do not ask again; " +
              "only the user can change the mode (/gate-mode).",
          }],
          details: { mode: cells.state.taskMode ?? null, declined: true },
          isError: true,
        };
      }

      // Criterion 3: the REJECTED path also reports — a refused mode change
      // is information the supervisor should have.
      deps.reportChildState(ctx, `gate mode 变更被拒（${decision.reason}）`, { force: true, state: "mode-changed" });
      return {
        content: [{ type: "text", text: `review-gate: mode change rejected — ${decision.reason}` }],
        details: { mode: cells.state.taskMode ?? null },
        isError: true,
      };
    },
  });
}
