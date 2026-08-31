/**
 * The gate's COMMAND layer — every slash command the extension registers, and
 * the single registration entry point of the whole family.
 *
 * They live here rather than in `extensions/review-gate.ts` for the reason
 * this repository has a rule about (AGENTS.md §"架构规范"): that file is
 * ~8000 lines, and it got there one "just add the body here" at a time. The
 * orchestration tools moved out first (lib/orchestrator-*-tools.ts), then the
 * judge tools (lib/judge-session-tools.ts), the prepare family
 * (lib/review-prepare-tools.ts, lib/advisory-prepare-tools.ts), the L7 Copilot
 * pair (lib/copilot-review-tools.ts) and the user-interaction family
 * (lib/user-interaction-tools.ts + lib/consent-request-tools.ts). Same shape
 * here: `registerGateCommands(host, deps)`, with every effect the commands
 * need arriving through an injected `deps` object.
 *
 * ONE ENTRY (philosophy two): the extension calls this function exactly once
 * and gets the workflow catalog, the five state/status commands AND
 * `/gate-doctor`; the diagnosis module registers nothing on its own.
 *
 * THE BOUNDARY: this module owns what each command SAYS and WHEN it persists.
 * It owns none of the rules behind them — the requirement list is
 * lib/gate-state.ts, the fingerprint lib/fingerprint.ts, the mode normalizer
 * lib/task-mode.ts, the command catalog lib/workflow-commands.ts and the two
 * read-only diagnoses lib/gate-diagnosis-commands.ts. What is injected is
 * everything it cannot own — the session's mutable state, its persistence,
 * the dialogs, the internal tool call and the per-session reset — so every
 * branch is testable without a terminal.
 *
 * SHARED STATE, NOT A COPY: `deps.state()`, `deps.projectConfig()` and
 * `deps.primaryRepoRoot()` are GETTERS, because the extension REBINDS all
 * three (session_start reloads the state and the config, and `/gate-reset`
 * replaces the state object outright). A captured reference would leave the
 * status readout describing a dead object while the gate reads a live one.
 *
 * BEHAVIOR IS FROZEN: this module was moved verbatim out of the extension.
 * Command names, descriptions, readout text, notification levels, the order
 * of the reset and the persist timing are the ones already documented;
 * changing any of them is a separate, deliberate change.
 */

import { readFileSync } from "node:fs";
import { join as pathJoin, dirname as pathDirname } from "node:path";

import { computeFingerprint } from "./fingerprint.ts";
import { unmetRequirements, type GateState } from "./gate-state.ts";
import { formatPrecommitSummary, lastPrecommitTiming } from "./gate-timings.ts";
import { isEnforcedMode, normalizeTaskMode, type TaskMode } from "./task-mode.ts";
import { ORCHESTRATOR_NEEDS_TMUX } from "./orchestrator-directives.ts";
import type { ProjectConfig } from "./project-config.ts";
import {
  WORKFLOW_COMMANDS,
  buildWorkflowPrompt,
  workflowCommand,
  type WorkflowCommandName,
} from "./workflow-commands.ts";
import {
  modelDiagnosisLines,
  registerGateDiagnosisCommands,
  type GateDiagnosisDeps,
} from "./gate-diagnosis-commands.ts";

/**
 * Just enough of a command's pi context for everything the commands do.
 *
 * The real `ExtensionCommandContext` carries far more; naming only what is
 * used keeps a test harness three lines long and makes the surface each
 * command actually touches readable.
 */
export interface CommandContext {
  /** Is there a terminal to render a dialog in? */
  hasUI?: boolean;
  /** Is the agent between turns? A busy agent cannot be handed a prompt. */
  isIdle(): boolean;
  /** The session's own model registry (the diagnosis's primary facts source). */
  modelRegistry?: unknown;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

/**
 * Just enough of the pi extension API to register a command.
 *
 * The tool-registration seam is lib/tool-host.ts; commands are a different
 * surface (a name, a description and a handler that receives raw argument
 * text), so they get their own — a host that could register one but not the
 * other is exactly the ambiguity philosophy two forbids.
 */
export interface CommandHost {
  registerCommand(name: string, options: {
    description?: string;
    handler: (args: string, ctx: CommandContext) => Promise<void>;
  }): void;
  /** Put a message in the agent's queue as if the user had typed it. */
  sendUserMessage(text: string): void;
}

/** The shape a gate tool result carries back through the internal call. */
export interface InternalToolResult {
  content?: Array<{ type: string; text: string }>;
  details?: Record<string, unknown> | undefined;
}

/**
 * Everything the commands need from the outside world.
 *
 * Deliberately narrow and side-effect-explicit: every member is a thing a
 * test replaces with three lines.
 */
export interface GateCommandDeps extends GateDiagnosisDeps {
  /** This session's gate state — a GETTER; see "SHARED STATE" above. */
  state(): GateState;
  /** The effective project config — a GETTER (session_start reloads it). */
  projectConfig(): ProjectConfig;
  /** Persist the state (sidecar write + status widget refresh). */
  persist(ctx: unknown): void;
  /**
   * Call another gate tool internally.
   *
   * `/precommit` runs the SAME implementation the review chain runs, so the
   * PASS it records is the one the ship gate accepts — there is no second
   * lane and no second way to be granted one.
   */
  callTool(name: string, params: Record<string, unknown>, ctx: unknown): Promise<InternalToolResult>;
  /** The text a tool result carries (its content joined). */
  toolText(result: InternalToolResult): string;
  /** One status line per OTHER repo this session edited, and whether any blocks. */
  otherRepoStatus(): { lines: string[]; blocked: boolean };
  /** Is the loop goal on disk the one the USER approved? */
  loopGoalConfirmed(): boolean;
  /** Is there a goal draft at all (approved or not)? */
  loopGoalPresent(): boolean;
  /** `ui.confirm` with the dialog-height budget applied (never bypassed). */
  confirmBounded(uiCtx: unknown, title: string, message: string): Promise<boolean>;
  /** Arm or disarm auto-continuation. */
  setLoopArmed(armed: boolean): void;
  /** Record a task-mode decision (source "user" — an explicit human choice). */
  setTaskMode(mode: TaskMode, source: "user", ctx: unknown): void;
  /**
   * Lift the lock on agent-initiated downgrades.
   *
   * Only a USER action may do this, which is why it is its own seam rather
   * than a flag the commands share with anything else.
   */
  unlockAgentDowngrades(): void;
  /**
   * Reset every per-session mutable the EXTENSION owns: the state object
   * itself, the loop counters and locks, the sensitive-file grants, the
   * bypass token and the appeal ledger.
   *
   * One seam rather than fifteen setters, because those bindings live in the
   * extension's closure and a command that could reset half of them is a
   * command that eventually does.
   */
  resetSession(): void;
}

// ---------- the workflow-command catalog ----------

/**
 * Run the trusted precommit lane for a USER command and print the verdict.
 *
 * It goes through the same internal implementation the review chain uses,
 * so the PASS it records is the one the ship gate accepts — there is no
 * second lane and no second way to be granted one.
 */
async function runPrecommitCommand(
  deps: GateCommandDeps,
  mode: "fast" | "full",
  ctx: CommandContext,
): Promise<void> {
  ctx.ui.notify(`review-gate: 正在跑 precommit（${mode} lane）……`, "info");
  try {
    const result = await deps.callTool("run_precommit", { mode }, ctx);
    const verdict = String(result.details?.verdict ?? "UNKNOWN");
    ctx.ui.notify(
      `review-gate: precommit ${verdict}\n${deps.toolText(result)}`,
      verdict === "PASS" ? "info" : "error",
    );
  } catch (error) {
    ctx.ui.notify(`review-gate: precommit 没跑起来 —— ${(error as Error).message}`, "error");
  }
}

function registerWorkflowCommand(host: CommandHost, deps: GateCommandDeps, name: WorkflowCommandName) {
  const command = workflowCommand(name);
  host.registerCommand(name, {
    description: command.description,
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify(`Agent is busy. Retry ${command.usage} when it is idle.`, "warning");
        return;
      }
      // PHILOSOPHY ONE — some commands are not a request to the agent at
      // all. `/precommit` used to mean "agent, go call run_precommit"; that
      // tool is no longer registered, and re-exposing it to keep a command
      // alive would be the back door philosophy three forbids. The gate
      // runs the lane itself instead: one intent, no turn spent, and no
      // tool name for an agent to misremember.
      const gateRuns = command.gateRuns;
      if (gateRuns) {
        await runPrecommitCommand(deps, gateRuns.precommitMode, ctx);
        return;
      }
      host.sendUserMessage(
        buildWorkflowPrompt(name, args ?? ""),
      );
    },
  });
}

// ---------- /gate-status ----------

function registerGateStatus(host: CommandHost, deps: GateCommandDeps): void {
  host.registerCommand("gate-status", {
    description: "Show review-gate state",
    handler: async (_args, ctx) => {
      const state = deps.state();
      const projectConfig = deps.projectConfig();
      const primaryRepoRoot = deps.primaryRepoRoot();
      const fp = computeFingerprint(deps.cwd);
      const problems = unmetRequirements(state, fp.digest, fp.unavailable, { requireDocSync: projectConfig.docSync });
      const others = deps.otherRepoStatus();
      // ---- 裁决 (verdicts) ----
      const review = `review:    ${state.review.verdict}${state.review.at ? ` (${state.review.at})` : ""}`;
      const precommit = `precommit: ${state.precommit.verdict}` +
        (state.precommit.verdict === "PASS"
          ? ` [lane ${state.precommit.mode ?? "?"}, tests: ${state.precommit.testScope ?? "unknown"}]` +
            (state.precommit.testScope === "full" ? "" : " — commit OK, push/PR need a full run") +
            (state.precommit.testScope === "skipped" ? " — ⚠️ tests were NOT run in this lane" : "")
          : "") +
        (state.precommit.at ? ` (${state.precommit.at})` : "");
      const lines = [
        "── 裁决 ──",
        review,
        precommit,
        ...formatPrecommitSummary(lastPrecommitTiming(primaryRepoRoot)),
        "── 工作区 ──",
        `changes:   code=${state.hasCodeChange} docs=${state.hasDocChange}`,
        `docSync:   ${projectConfig.docSync ? `ENFORCED (attested: ${state.review.docSync ?? "none"})` : "off"}`,
        `rounds:    ${state.rounds.length}/${state.maxRounds}`,
        `task mode: ${state.taskMode ?? "undecided (behaves as loop; agent decides via set_gate_mode)"}`,
        "── 配置 ──",
        `config:    thinkHarder=${projectConfig.thinkHarder}${state.strategicResetFired ? " (fired)" : ""} gitMemory=${projectConfig.gitMemory}`,
        ...(state.scopeLimit
          ? [`scope:     session-only (user-granted ${state.scopeLimit.at}; ${state.scopeLimit.preexistingFiles.length} pre-existing file(s) exempt)`]
          : []),
        ...(state.pausedQuestion
          ? [`paused:    awaiting user answer to "${state.pausedQuestion.question.slice(0, 120)}" (${state.pausedQuestion.at})`]
          : []),
        "── 门禁 ──",
        // L8: whether THIS text is the contract the user approved (loop mode
        // ships are blocked until it is), and L7: the Copilot cycle, which
        // gates completion only — both are easy to misread from the outside,
        // so the readout names them explicitly.
        `loop goal: ${deps.loopGoalConfirmed() ? "approved by the user" : deps.loopGoalPresent() ? "DRAFT — not approved (loop-mode ships blocked)" : "none"}`,
        ...(state.copilot
          ? [`copilot:   ${state.copilot.status}${state.copilot.pr ? ` PR #${state.copilot.pr}` : ""}` +
            ` (round ${state.copilot.rounds}, no round cap` +
            `${state.copilot.note ? `; ${state.copilot.note.slice(0, 120)}` : ""})`]
          : []),
        `bypass:    ${state.bypass.active ? `ACTIVE (${state.bypass.reason})` : "off"}`,
        `fingerprint: ${fp.unavailable ? "UNAVAILABLE" : fp.digest.slice(0, 12)}`,
        // Explore: ship commands stay fully gated (L1), but declare_done and
        // auto-continuation are advisory. Normal: the ship gate is OFF.
        state.taskMode === "normal"
          ? "ship gate: OFF (normal mode — extension inactive)"
          : state.taskMode === "explore"
            ? (problems.length
              ? `ship gate: BLOCKED (explore: completion advisory, ship still gated)\n${problems.map((p) => `  - ${p}`).join("\n")}`
              : "ship gate: OPEN (explore)")
            : (problems.length ? `ship gate: BLOCKED\n${problems.map((p) => `  - ${p}`).join("\n")}` : "ship gate: OPEN"),
        // Every OTHER repo this session edited gets its own line. Showing only
        // the session repo is how a multi-repo session could look green while
        // the repo it was about to commit sat at PENDING (and vice versa).
        ...others.lines,
        // Model chains: the first line from modelDiagnosisLines is the
        // `model chains:` header — our ── 模型 ── section header replaces it.
        ...(() => {
          const ml = modelDiagnosisLines(deps, ctx.modelRegistry);
          return ml.length > 1 ? ["── 模型 ──", ...ml.slice(1)] : [];
        })(),
      ];
      ctx.ui.notify(lines.join("\n"), problems.length || others.blocked ? "warning" : "info");
    },
  });
}

// ---------- the four state-changing commands ----------

function registerGateBypass(host: CommandHost, deps: GateCommandDeps): void {
  host.registerCommand("gate-bypass", {
    description: "Bypass the review gate (requires a reason; user-confirmed)",
    handler: async (args, ctx) => {
      const reason = (args ?? "").trim();
      if (!reason) { ctx.ui.notify("Usage: /gate-bypass <reason>", "error"); return; }
      const ok = ctx.hasUI
        ? await deps.confirmBounded(
            ctx,
            "Bypass review gate?",
            `Reason: ${reason}\nDisables ship blocking until /gate-reset.`,
          )
        : true;
      if (!ok) return;
      deps.state().bypass = { active: true, reason, at: new Date().toISOString() };
      deps.setLoopArmed(false);
      deps.persist(ctx);
      ctx.ui.notify(`review-gate: BYPASSED (${reason})`, "warning");
    },
  });
}

function registerGateMode(host: CommandHost, deps: GateCommandDeps): void {
  host.registerCommand("gate-mode", {
    description: "Set task workflow: /gate-mode loop|explore|normal|orchestrator",
    handler: async (args, ctx) => {
      const mode = normalizeTaskMode((args ?? "").trim());
      if (mode === undefined) {
        ctx.ui.notify("Usage: /gate-mode loop|explore|normal|orchestrator", "error");
        return;
      }
      // The orchestrator role is impossible without tmux — its children ARE
      // panes of the user's window. Refuse here too, not just in the tool:
      // the user should be told now, rather than watching every orchestration
      // tool fail one at a time.
      if (mode === "orchestrator" && !process.env.TMUX) {
        ctx.ui.notify(ORCHESTRATOR_NEEDS_TMUX, "error");
        return;
      }
      // /gate-mode is user-invoked — an explicit choice, so source is "user"
      // and any direction is allowed without a confirm dialog. A fresh user
      // decision also clears the agent-downgrade lock.
      deps.unlockAgentDowngrades();
      deps.setTaskMode(mode, "user", ctx);
      ctx.ui.notify(
        mode === "loop"
          ? "review-gate: switched to loop workflow"
          : mode === "orchestrator"
            ? "review-gate: switched to ORCHESTRATOR (project manager) — plan the work, spawn and supervise child sessions; you write no code yourself"
            : mode === "explore"
              ? "review-gate: switched to explore workflow — gates advisory, AI may self-complete; prefer read-only work (ship commands stay gated)"
              : "review-gate: switched to NORMAL mode — all quality gates are OFF for this session (as if the extension were not installed)",
        isEnforcedMode(mode) ? "info" : "warning",
      );
    },
  });
}

function registerGateReset(host: CommandHost, deps: GateCommandDeps): void {
  host.registerCommand("gate-reset", {
    description: "Reset review-gate state for this session",
    handler: async (_args, ctx) => {
      // Everything the reset touches is an EXTENSION-owned binding (the state
      // object it rebinds, its loop counters and locks, the one-shot
      // sensitive-file grants and their decline locks, the bypass token and
      // the persisted appeal ledger), so it goes back through one seam rather
      // than fifteen setters this module would have to keep in sync.
      deps.resetSession();
      deps.persist(ctx);
      ctx.ui.notify("review-gate: state reset", "info");
    },
  });
}

function registerGateLesson(host: CommandHost, deps: GateCommandDeps): void {
  // sd0x-dev-flow self-improvement loop port: /gate-lesson records a corrected
  // mistake into a per-project lesson log (.pi/review-gate-lessons.md). Lessons
  // recurring 3+ times should be promoted into rules/config by the user.
  host.registerCommand("gate-lesson", {
    description: "Record a lesson learned (self-improvement log): /gate-lesson <text>",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();
      if (!text) { ctx.ui.notify("Usage: /gate-lesson <what went wrong → correct approach>", "error"); return; }
      const logPath = pathJoin(deps.cwd, ".pi", "review-gate-lessons.md");
      try {
        const { appendFileSync, mkdirSync } = await import("node:fs");
        mkdirSync(pathDirname(logPath), { recursive: true });
        let n = 1;
        try { n = (readFileSync(logPath, "utf8").match(/^### L\d+/gm) ?? []).length + 1; } catch { /* new log */ }
        appendFileSync(logPath, `\n### L${n} — ${new Date().toISOString().slice(0, 10)}\n\n${text}\n`);
        ctx.ui.notify(`review-gate: lesson L${n} recorded in .pi/review-gate-lessons.md`, "info");
      } catch (e) {
        ctx.ui.notify(`review-gate: could not write lesson log: ${(e as Error).message}`, "error");
      }
    },
  });
}

/**
 * Register the WHOLE command layer — the workflow catalog, the five
 * state/status commands and (through the diagnosis module) `/gate-doctor`.
 *
 * The family has ONE registration call on purpose: an extension that could
 * wire half of it is an extension that eventually does.
 */
export function registerGateCommands(host: CommandHost, deps: GateCommandDeps): void {
  for (const name of Object.keys(WORKFLOW_COMMANDS) as WorkflowCommandName[]) {
    registerWorkflowCommand(host, deps, name);
  }
  registerGateStatus(host, deps);
  registerGateBypass(host, deps);
  registerGateMode(host, deps);
  registerGateReset(host, deps);
  registerGateLesson(host, deps);
  registerGateDiagnosisCommands(host, deps);
}
