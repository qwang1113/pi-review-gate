/**
 * The tmux BACKSTOP — bash-layer refusal of hand-written tmux commands.
 *
 * THIS IS NOT THE MAIN PATH (task book §4.3). The main path is the tool set:
 * an orchestrator expresses intent (`orchestrator_spawn` / `orchestrator_send`
 * / `orchestrator_close`) and the gate builds the command
 * (lib/orchestrator-tmux.ts). This module only catches the case where a
 * session goes around the tools and types tmux itself — which is where the
 * measured damage lives, because the blast radius of an improvised tmux
 * command is the USER'S working environment, not a wrong answer.
 *
 * TWO TIERS, and the difference matters:
 *
 *  1. ALWAYS FORBIDDEN — `kill-session`, `kill-server`, `kill-window`,
 *     `new-session`, `new-window`, a global option write (`set -g`), and
 *     `kill-pane -a` (which sweeps every OTHER pane in the window, the user's
 *     included). None of these has a legitimate use from inside an agent
 *     session: they either destroy something the user owns or create surface
 *     outside the one window the orchestration was agreed in. No tool
 *     replaces them, so the refusal is final.
 *  2. TOOL-REPLACED — `split-window`, `send-keys`, `kill-pane`. These are
 *     exactly what the orchestration tools do, so refusing them in
 *     ORCHESTRATOR mode is not a prohibition but a redirect: the message
 *     names the tool to call instead. Outside orchestrator mode they are left
 *     alone; an ordinary session running tmux for its own reasons is not this
 *     module's business.
 *
 * QUOTED TEXT IS DATA. Detection runs over the shell lexer's UNQUOTED tokens
 * (lib/shell-lex.ts), so `echo "tmux kill-server"` and a quoted payload inside
 * a legitimate command are not commands and are not flagged. Fail-closed on
 * the structure, not on the prose.
 *
 * Pure module: string in, decision out. It never executes anything.
 */

import { lexSegments } from "./shell-lex.ts";

export type TmuxGuardTier = "forbidden" | "use-the-tool";

export interface TmuxGuardHit {
  /** The tmux subcommand (canonical, long form) that was refused. */
  subcommand: string;
  tier: TmuxGuardTier;
  /** The offending shell segment, for the message. */
  segment: string;
  /** Ready-to-show explanation, including what to do instead. */
  reason: string;
}

/**
 * tmux short aliases → canonical names. Only the ones this module rules on:
 * an alias that reaches a forbidden subcommand must not slip through because
 * it was spelled differently.
 */
const TMUX_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  new: "new-session",
  neww: "new-window",
  killw: "kill-window",
  killp: "kill-pane",
  splitw: "split-window",
  send: "send-keys",
  set: "set-option",
  setw: "set-window-option",
});

/** Destructive or scope-escaping subcommands — refused in every gated mode. */
export const ALWAYS_FORBIDDEN: readonly string[] = Object.freeze([
  "kill-session",
  "kill-server",
  "kill-window",
  "new-session",
  "new-window",
]);

/** Subcommands the orchestration tools replace (refused in orchestrator mode). */
export const TOOL_REPLACED: readonly string[] = Object.freeze([
  "split-window",
  "send-keys",
  "kill-pane",
]);

/** Which tool to call instead of typing the command. */
const TOOL_FOR: Readonly<Record<string, string>> = Object.freeze({
  "split-window": "orchestrator_spawn（或接力用 orchestrator_relay）",
  "send-keys": "orchestrator_send",
  "kill-pane": "orchestrator_close",
});

/** tmux GLOBAL flags that consume the following token as their value. */
const FLAGS_WITH_VALUE = new Set(["-c", "-f", "-L", "-S", "-T"]);

/** Option-writing subcommands, for the `-g` rule. */
const OPTION_SUBCOMMANDS = new Set(["set-option", "set-window-option"]);

function canonical(sub: string): string {
  return TMUX_ALIASES[sub] ?? sub;
}

function isTmuxHead(token: string): boolean {
  if (token === "tmux") return true;
  // An absolute or relative path to tmux is the same command.
  const base = token.split("/").pop();
  return base === "tmux";
}

/**
 * Find the tmux SUBCOMMAND of one segment, skipping tmux's own global flags
 * (`tmux -L work kill-server` must still be seen as `kill-server`).
 * Returns the canonical name plus the remaining unquoted tokens.
 */
function tmuxInvocation(tokens: readonly string[]): { subcommand: string; rest: string[] } | undefined {
  if (tokens.length === 0 || !isTmuxHead(tokens[0]!)) return undefined;
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (!token.startsWith("-")) break;
    if (FLAGS_WITH_VALUE.has(token)) i += 2;
    else i += 1;
  }
  const sub = tokens[i];
  if (sub === undefined) return undefined;
  return { subcommand: canonical(sub), rest: tokens.slice(i + 1) };
}

/**
 * Decide whether a bash command line contains a refused tmux operation.
 *
 * Returns the FIRST hit (one clear message beats a list), or undefined when
 * the command is fine. The caller decides when to ask: the gate skips this
 * entirely in `normal` mode, exactly like every other bash rule.
 */
export function detectForbiddenTmux(
  command: string,
  opts: { orchestratorMode: boolean },
): TmuxGuardHit | undefined {
  if (!command || !command.includes("tmux")) return undefined;

  for (const segment of lexSegments(command)) {
    // Quoted text is DATA: `echo "tmux kill-server"` is not a command.
    const tokens = segment.tokens.filter((t) => !t.quoted).map((t) => t.value).filter(Boolean);
    const invocation = tmuxInvocation(tokens);
    if (!invocation) continue;
    const { subcommand, rest } = invocation;
    const rendered = tokens.join(" ");

    if (ALWAYS_FORBIDDEN.includes(subcommand)) {
      return {
        subcommand,
        tier: "forbidden",
        segment: rendered,
        reason:
          `review-gate: 禁止 \`tmux ${subcommand}\` —— 它会破坏或越出用户的 tmux 环境` +
          "（编排只允许在用户与你约定的那一个 window 内 split）。" +
          "需要开子会话用 `orchestrator_spawn`，接力用 `orchestrator_relay`。",
      };
    }

    if (OPTION_SUBCOMMANDS.has(subcommand) && rest.includes("-g")) {
      return {
        subcommand,
        tier: "forbidden",
        segment: rendered,
        reason:
          `review-gate: 禁止 \`tmux ${subcommand} -g\` —— 那是用户的全局 tmux 配置，` +
          "任何会话都不得改写。",
      };
    }

    // `kill-pane -a` sweeps every OTHER pane in the window — the user's panes
    // included — so it is destructive regardless of mode, unlike a plain
    // kill-pane which merely does what orchestrator_close does properly.
    if (subcommand === "kill-pane" && rest.includes("-a")) {
      return {
        subcommand,
        tier: "forbidden",
        segment: rendered,
        reason:
          "review-gate: 禁止 `tmux kill-pane -a` —— 它会清掉 window 里其他所有 pane（包括用户自己的）。" +
          "要关自己开的子会话，用 `orchestrator_close`（只能关它登记过的 pane）。",
      };
    }

    if (opts.orchestratorMode && TOOL_REPLACED.includes(subcommand)) {
      return {
        subcommand,
        tier: "use-the-tool",
        segment: rendered,
        reason:
          `review-gate: 项目经理不手写 tmux —— \`${subcommand}\` 请改用 ${TOOL_FOR[subcommand]}。` +
          "门禁会构造命令、登记 pane 归属并做安全检查；现编的 tmux 命令出错的代价是搞挂用户的工作环境。",
      };
    }
  }
  return undefined;
}
