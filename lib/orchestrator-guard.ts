/**
 * The tmux BACKSTOP — a bash-layer HINT about hand-written tmux commands.
 *
 * THIS IS NOT THE MAIN PATH (task book §4.3). The main path is the tool set:
 * an orchestrator expresses intent (`orchestrator_spawn` / `orchestrator_send`
 * / `orchestrator_close`) and the gate builds the command
 * (lib/orchestrator-tmux.ts). This module catches the case where a session
 * goes around the tools and types tmux itself — which is where the measured
 * damage lives, because the blast radius of an improvised tmux command is the
 * USER'S working environment, not a wrong answer.
 *
 * IT NOW BLOCKS — BUT NEVER PERMANENTLY (user decision, 2026-09-17). Between
 * those two states the rule was "hint, do not block" (2026-09-14), and that
 * left the blast radius unchecked: the agent could still `kill-server` while
 * being told not to. The user's rule now is a PERMISSION: an unauthorized tmux
 * operation is REFUSED, and the refusal names the one way out —
 * `request_tmux_access`, which puts a dialog in front of the human. A grant
 * covers the session that asked and the `session_handoff` successor it may
 * name (see lib/gate-state.ts `tmuxAccess`), so a long piece of work does not
 * have to re-ask after every handover — and an `orchestrator_attach` takeover
 * starts with nothing, like every other confirmed record.
 *
 * THE AGENT CANNOT GRANT ITSELF ANYTHING. It only asks; the answer comes from
 * the user's dialog (or, for a child session, from its manager), and a
 * dialog that cannot be shown is fail-closed.
 *
 * TWO TIERS, and the difference still matters — it is the STRENGTH OF THE
 * HINT:
 *
 *  1. ALWAYS WARNED — `kill-session`, `kill-server`, `kill-window`,
 *     `new-session`, `new-window`, a global option write (`set -g`), and
 *     `kill-pane -a` (which sweeps every OTHER pane in the window, the user's
 *     included). None of these has a legitimate use from inside an agent
 *     session: they either destroy something the user owns or create surface
 *     outside the one window the orchestration was agreed in. No tool
 *     replaces them, so the warning is the strongest one the gate has.
 *  2. TOOL-REPLACED — `split-window`, `send-keys`, `kill-pane`. These are
 *     exactly what the orchestration tools do, so in ORCHESTRATOR mode the
 *     hint is not a prohibition but a redirect: the message names the tool to
 *     call instead. Outside orchestrator mode they are left alone; an
 *     ordinary session running tmux for its own reasons is not this module's
 *     business.
 *
 * QUOTED TEXT IS DATA. Detection runs over the shell lexer's UNQUOTED tokens
 * (lib/shell-lex.ts), so `echo "tmux kill-server"` and a quoted payload inside
 * a legitimate command are not commands and are not flagged.
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
  /** What to say when the session HAS permission (advice, not a refusal). */
  reason: string;
  /** What to say when it does not: the block, plus the way to earn it. */
  refusal: string;
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
  "split-window": "orchestrator_spawn（接力用 session_handoff，救活死掉的用 orchestrator_recover）",
  // Typing at a child is gone entirely: a MESSAGE goes through
  // `orchestrator_instruct` and an ANSWER through `orchestrator_answer`, both
  // via the child's channel. Naming only one of them here would send the
  // agent to the wrong tool for half the cases.
  "send-keys": "orchestrator_instruct（发消息/打断）或 orchestrator_answer（回它在等的那个问题）",

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

/**
 * Blank out quoted regions, preserving everything outside them.
 *
 * Used for the raw-command sweep: what is left is the text the shell will
 * treat as SYNTAX, so `$(tmux kill-server)` and `(cd /x && tmux kill-server)`
 * stay visible while `echo "tmux kill-server"` becomes `echo `.
 *
 * The quoting rules are the shell's, not an approximation, because getting
 * them wrong costs a FALSE POSITIVE on the most ordinary command in this
 * repository — a commit message about the rule itself:
 *  - inside DOUBLE quotes a backslash escapes the next character, so `\"`
 *    does NOT close the quote (`git commit -m "say \"tmux kill-server\" is
 *    refused"` stays one quoted string);
 *  - inside SINGLE quotes nothing escapes — the next `'` always closes;
 *  - outside quotes a backslash escapes the next character.
 *
 * An UNCLOSED quote blanks the rest of the line. That is fail-open, and
 * deliberately so: an unterminated quote is a syntax error, so the shell runs
 * nothing at all.
 *
 * COMMENTS and HERE-DOC bodies are blanked for the same reason quotes are:
 * they are text the shell does not execute, and leaving them in made
 * `tmux list-panes # then kill-server by hand` a hard block.
 */
function blankQuoted(raw: string): string {
  // Here-doc bodies first — they can contain anything, including quotes that
  // would otherwise unbalance the scan below. Same delimiter shapes as
  // lib/shell-lex.ts handles.
  const withoutHeredocs = raw.replace(
    /<<-?\s*(?:\\)?['"]?([A-Za-z0-9_-]+)['"]?[\s\S]*?^\s*\1\s*$/gm,
    " ",
  );
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < withoutHeredocs.length; i++) {
    const ch = withoutHeredocs[i]!;
    if (quote) {
      // Double quotes honour backslash escapes; single quotes are literal.
      if (quote === '"' && ch === "\\" && i + 1 < withoutHeredocs.length) { out += "  "; i++; continue; }
      if (ch === quote) { quote = null; out += " "; continue; }
      out += " ";
      continue;
    }
    if (ch === "\\" && i + 1 < withoutHeredocs.length) { out += "  "; i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; out += " "; continue; }
    // An unquoted `#` that STARTS a word begins a comment: blank to end of
    // line. `foo#bar` is not a comment, so the previous character decides.
    if (ch === "#" && (i === 0 || /\s/.test(withoutHeredocs[i - 1]!))) {
      while (i < withoutHeredocs.length && withoutHeredocs[i] !== "\n") { out += " "; i++; }
      if (i < withoutHeredocs.length) out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

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
 * The match requires `tmux` and the destructive subcommand to sit in the SAME
 * command (no `|`, `;` or `&` between them) — the same shape
 * lib/ship-detect.ts uses for `git … commit`. That adjacency is what keeps the
 * sweep from firing on an unrelated word elsewhere on the line: without it,
 * `sh -c 'tmux ls' && echo new` would read as `tmux new-session`.
 *
 * Only the ALWAYS-FORBIDDEN tier is swept. The tool-replaced ones are a
 * redirect, and a redirect fired at a false positive is just confusing.
 * There are two places this sweep is applied, and they cover different
 * hiding places:
 *   - the SEGMENT text, when the segment is a nested shell — its payload is a
 *     quoted string, which the lexer correctly reports as data;
 *   - the RAW command with quoted regions blanked out, which is where shell
 *     PUNCTUATION hides things the lexer removed or split: `$(tmux
 *     kill-server)` and backticks are erased by the substitution
 *     preprocessing, and `(cd /x && tmux kill-server)` leaves a `)` glued to
 *     the subcommand token so precise matching misses it.
 * Blanking quotes in the raw pass is what keeps `echo "tmux kill-server"`
 * out: quoted text really is data, and the nested-shell pass is what catches
 * it when a shell is about to execute that data.
 */
function sweepForbidden(text: string): string | undefined {
  // Long forms first, so the reported subcommand is the canonical one.
  for (const sub of ALWAYS_FORBIDDEN) {
    if (new RegExp(`\\btmux\\b[^|;&]*?(?<![A-Za-z0-9_-])${sub}(?![A-Za-z0-9_-])`).test(text)) return sub;
  }
  for (const [alias, canonicalName] of Object.entries(TMUX_ALIASES)) {
    if (!ALWAYS_FORBIDDEN.includes(canonicalName)) continue;
    if (new RegExp(`\\btmux\\b[^|;&]*?(?<![A-Za-z0-9_-])${alias}(?![A-Za-z0-9_-])`).test(text)) return canonicalName;
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
/**
 * THE ONE WAY OUT, named identically everywhere (哲学二: one route, spelled
 * once). A refusal that does not say how to proceed is just a wall.
 */
export const TMUX_PERMISSION_ROUTE =
  "要跑它先取得授权：`request_tmux_access({ reason: \"…\" })` —— 会弹给用户拍板；" +
  "授权后本会话和它的接力继任者都能用 tmux（也可以选择只允许这一次）。";

/** The block shown when the session has no permission for this subcommand. */
function refusalText(subcommand: string, danger: string): string {
  return `review-gate: 已拦截 \`tmux ${subcommand}\` —— ${danger}${TMUX_PERMISSION_ROUTE}`;
}

/** The refusal for a call the sweep found hidden rather than spelled out. */
function hiddenHit(subcommand: string, segment: string): TmuxGuardHit {
  const danger =
    "它会破坏或越出用户的 tmux 环境，而这条命令把它藏在了包装命令、嵌套 shell 或 shell 语法" +
    "（子 shell / 命令替换）里。";
  return {
    subcommand,
    tier: "forbidden",
    segment,
    refusal: refusalText(subcommand, danger),
    reason:
      `review-gate: 已授权，命令照常执行。提醒：\`tmux ${subcommand}\` ` + danger +
      "需要开子会话用 `orchestrator_spawn`，接力用 `session_handoff`，救活死掉的用 `orchestrator_recover`。",
  };
}

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
      // The nested test looks at the RAW head too, so `xargs -I{} sh -c …`
      // (where the wrapper's own option hides the shell) is still seen.
      const strippedHead = stripCommandPrefixes(tokens)[0];
      const nested = [tokens[0], strippedHead].some(
        (t) => t !== undefined && NESTED_SHELL.test(t.split("/").pop() ?? t),
      );
      // A BARE shell token is the piped-to-shell shape (`echo … | sh`), where
      // the payload lives in a DIFFERENT segment — so that case sweeps the
      // whole command line, exactly as lib/ship-detect.ts does for `git`.
      const scope = nested ? `${allText} ${command}` : allText;
      const swept = nested || tokens.some(isTmuxHead) ? sweepForbidden(scope) : undefined;
      if (swept) return hiddenHit(swept, allText);
      continue;
    }
    const { subcommand, rest } = invocation;
    const rendered = tokens.join(" ");

    if (ALWAYS_FORBIDDEN.includes(subcommand)) {
      const danger = "它会破坏或越出用户的 tmux 环境（编排只允许在用户与你约定的那一个 window 内 split）。";
      return {
        subcommand,
        tier: "forbidden",
        segment: rendered,
        refusal: refusalText(subcommand, danger),
        reason:
          `review-gate: 已授权，命令照常执行。提醒：\`tmux ${subcommand}\` ` + danger +
          "需要开子会话用 `orchestrator_spawn`，接力用 `session_handoff`，救活死掉的用 `orchestrator_recover`。",
      };
    }

    if (OPTION_SUBCOMMANDS.has(subcommand) && rest.includes("-g")) {
      const danger = "那是用户的全局 tmux 配置，任何会话都不得改写。";
      return {
        subcommand,
        tier: "forbidden",
        segment: rendered,
        refusal: refusalText(`${subcommand} -g`, danger),
        reason: `review-gate: 已授权，命令照常执行。提醒：\`tmux ${subcommand} -g\` ${danger}`,
      };
    }

    // `kill-pane -a` sweeps every OTHER pane in the window — the user's panes
    // included — so it is destructive regardless of mode, unlike a plain
    // kill-pane which merely does what orchestrator_close does properly.
    if (subcommand === "kill-pane" && rest.includes("-a")) {
      const danger = "它会清掉 window 里其他所有 pane（包括用户自己的）。";
      return {
        subcommand,
        tier: "forbidden",
        segment: rendered,
        refusal: refusalText("kill-pane -a", danger),
        reason:
          `review-gate: 已授权，命令照常执行。提醒：\`tmux kill-pane -a\` ` + danger +
          "要关自己开的子会话，用 `orchestrator_close`（只能关它登记过的 pane）。",
      };
    }

    if (opts.orchestratorMode && TOOL_REPLACED.includes(subcommand)) {
      const danger =
        "门禁会构造命令、登记 pane 归属并做安全检查；现编的 tmux 命令出错的代价是搞挂用户的工作环境。";
      return {
        subcommand,
        tier: "use-the-tool",
        segment: rendered,
        refusal: refusalText(subcommand, `项目经理不手写 tmux —— \`${subcommand}\` 应该改用 ${TOOL_FOR[subcommand]}。`),
        reason: `review-gate: 已授权，命令照常执行。提醒：${TOOL_FOR[subcommand]} 能做同样的事并带上归属与安全检查。`,
      };
    }
  }
  // FINAL fail-closed pass over the RAW command with quoted regions blanked.
  // This is where shell PUNCTUATION hides a call from everything above: the
  // lexer erases `$(...)` and backticks entirely, and a subshell leaves `)`
  // glued to the subcommand token so the precise matcher does not recognize
  // it. Quoted text stays out (it is data — the nested-shell pass above is
  // what catches it when a shell is about to run it).
  const hiddenBySyntax = sweepForbidden(blankQuoted(command));
  if (hiddenBySyntax) return hiddenHit(hiddenBySyntax, command.trim().slice(0, 200));
  return undefined;
}
