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
 * Words that PREFIX a command without changing what it runs. Measured bypasses
 * of the first version of this guard: `FOO=bar tmux kill-server`,
 * `TMUX_TMPDIR=/tmp tmux kill-window`, `command tmux kill-server`,
 * `env tmux kill-server` — all of them reached tmux while the head check saw
 * something else.
 */
const TRANSPARENT_PREFIXES: ReadonlySet<string> = new Set([
  "env", "command", "builtin", "exec", "nohup", "time", "sudo", "doas",
  "nice", "stdbuf", "setsid", "xargs",
]);

/** Shell/indirection heads whose ARGUMENT is another command line. */
const NESTED_SHELL = /^(?:(?:ba|z|da|k)?sh|eval|xargs|watch)$/;

/** Drop leading `VAR=value` assignments and transparent wrapper words. */
function stripCommandPrefixes(tokens: readonly string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { i += 1; continue; }   // VAR=value
    const base = token.split("/").pop() ?? token;
    if (TRANSPARENT_PREFIXES.has(base)) { i += 1; continue; }
    break;
  }
  return tokens.slice(i);
}

/**
 * Find the tmux SUBCOMMAND of one segment, skipping tmux's own global flags
 * (`tmux -L work kill-server` must still be seen as `kill-server`).
 * Returns the canonical name plus the remaining unquoted tokens.
 */
function tmuxInvocation(rawTokens: readonly string[]): { subcommand: string; rest: string[] } | undefined {
  const tokens = stripCommandPrefixes(rawTokens);
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
 * FAIL-CLOSED sweep for the shapes precise head detection cannot reach: a
 * wrapper whose own options hide the head (`sudo -u x tmux …`), and a nested
 * shell that carries the whole command as a quoted STRING
 * (`sh -c 'tmux kill-server'`), which the lexer correctly reports as data.
 *
 * The rule is deliberately blunt: the segment mentions tmux AND mentions a
 * destructive subcommand ⇒ refuse. It can false-positive on prose
 * (`echo tmux kill-server`), and that is the right trade: a false positive
 * costs one rewrite, a false negative ends the window the user is watching
 * from. Only the ALWAYS-FORBIDDEN tier is swept — the tool-replaced ones are
 * a redirect, and a redirect fired at a false positive is just confusing.
 */
function sweepForbidden(segmentText: string): string | undefined {
  if (!/\btmux\b/.test(segmentText)) return undefined;
  for (const sub of ALWAYS_FORBIDDEN) {
    if (new RegExp(`(?<![A-Za-z0-9_-])${sub}(?![A-Za-z0-9_-])`).test(segmentText)) return sub;
  }
  for (const [alias, canonicalName] of Object.entries(TMUX_ALIASES)) {
    if (!ALWAYS_FORBIDDEN.includes(canonicalName)) continue;
    if (new RegExp(`(?<![A-Za-z0-9_-])${alias}(?![A-Za-z0-9_-])`).test(segmentText)) return canonicalName;
  }
  return undefined;
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
    // Quoted text is DATA for the PRECISE path: `echo "tmux kill-server"` is
    // not a command. The fail-closed sweep below deliberately looks at the
    // whole segment text instead, because a nested shell carries its command
    // as exactly such a quoted string.
    const tokens = segment.tokens.filter((t) => !t.quoted).map((t) => t.value).filter(Boolean);
    const allText = segment.tokens.map((t) => t.value).join(" ");
    const invocation = tmuxInvocation(tokens);
    if (!invocation) {
      // No readable tmux head. Two shapes still reach tmux: a wrapper whose
      // own options hide it, and a nested shell holding the command as data.
      const head = stripCommandPrefixes(tokens)[0];
      const nested = head !== undefined && NESTED_SHELL.test(head.split("/").pop() ?? head);
      // A BARE shell token is the piped-to-shell shape (`echo … | sh`), where
      // the payload lives in a DIFFERENT segment — so that case sweeps the
      // whole command line, exactly as lib/ship-detect.ts does for `git`.
      const scope = nested ? `${allText} ${command}` : allText;
      const swept = nested || tokens.some(isTmuxHead) ? sweepForbidden(scope) : undefined;
      if (swept) {
        return {
          subcommand: swept,
          tier: "forbidden",
          segment: allText,
          reason:
            `review-gate: 禁止 \`tmux ${swept}\` —— 它会破坏或越出用户的 tmux 环境。` +
            "这条命令把它藏在了包装命令或嵌套 shell 里，门禁按 fail-closed 处理：" +
            "宁可误伤一次（改写即可），也不能放过一次搞挂用户 window 的调用。" +
            "需要开子会话用 `orchestrator_spawn`，接力用 `orchestrator_relay`。",
        };
      }
      continue;
    }
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
