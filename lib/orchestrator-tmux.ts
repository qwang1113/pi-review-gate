/**
 * tmux COMMAND CONSTRUCTION — the orchestrator never writes a tmux command,
 * so this module writes all of them.
 *
 * WHY (user requirement, 2026-08-29: "if a tool can be provided, do not make
 * the session assemble it"). Every tmux failure measured in the hand-run
 * orchestration came from an improvised command, and the cost of an improvised
 * tmux command is not a wrong answer — it is the USER'S WORKING ENVIRONMENT.
 * A stray `kill-session` ends the window they are watching from. So the layout
 * rules live here, once, as argv arrays, and the agent only expresses intent.
 *
 * ARGV, NOT A SHELL STRING. Every builder returns an argument ARRAY for
 * execFile-style spawning: no shell parses it, so a pane id or a message body
 * can never become another command. On top of that {@link assertSafeTmuxArgv}
 * refuses the destructive subcommands outright — the gate's own execution path
 * is held to the same list the bash guard enforces against the agent
 * (lib/orchestrator-guard.ts), so "the gate is exempt from the guard" can
 * never mean "the gate may do the forbidden thing".
 *
 * THE LAYOUT (measured against the user's own window):
 *
 *     window
 *     ├─ left column    the orchestrator, alone
 *     └─ right column   child sessions, stacked vertically
 *
 *  - first child, no right column yet → `split-window -h` off the ORCHESTRATOR
 *    pane, which creates the right column;
 *  - every later child → `split-window -v` off the LAST child pane, which
 *    stacks it under the others instead of splitting the orchestrator again;
 *  - a relay (handing the orchestration to a successor) → `split-window -h`
 *    off the orchestrator's own pane, so the successor lands beside it and
 *    inherits the left column when the old pane is closed.
 *
 * Pure module: builds and validates argv. It never spawns anything.
 */

/** A tmux pane id as tmux itself prints it: `%` followed by digits. */
const PANE_ID = /^%\d{1,10}$/;

/** tmux subcommands the gate itself must never run (see the header). */
export const FORBIDDEN_TMUX_SUBCOMMANDS: readonly string[] = Object.freeze([
  "kill-session",
  "kill-server",
  "kill-window",
  "new-session",
  "new",
  "new-window",
  "neww",
]);

export class UnsafeTmuxCommand extends Error {}

/** True for a syntactically valid pane id. Fail-closed: anything else is refused. */
export function isPaneId(value: unknown): value is string {
  return typeof value === "string" && PANE_ID.test(value);
}

function requirePane(value: string, what: string): string {
  if (!isPaneId(value)) {
    throw new UnsafeTmuxCommand(`${what} 不是合法的 tmux pane id（形如 %12）：${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Last line of defense before the gate spawns tmux: the argv must not name a
 * destructive subcommand. Called by every builder AND by the executor, so a
 * future builder cannot quietly bypass it.
 */
export function assertSafeTmuxArgv(argv: readonly string[]): readonly string[] {
  const sub = argv[0];
  if (typeof sub !== "string" || sub.length === 0) {
    throw new UnsafeTmuxCommand("tmux 命令缺少子命令");
  }
  if (FORBIDDEN_TMUX_SUBCOMMANDS.includes(sub)) {
    throw new UnsafeTmuxCommand(
      `tmux ${sub} 属于禁止清单（会影响用户的 session/window），门禁自己也不执行`,
    );
  }
  // A global option write would change the user's own configuration.
  if ((sub === "set" || sub === "set-option" || sub === "setw" || sub === "set-window-option") && argv.includes("-g")) {
    throw new UnsafeTmuxCommand(`tmux ${sub} -g 会改用户全局配置，禁止`);
  }
  return argv;
}

export interface SpawnPaneOptions {
  /** The orchestrator's OWN pane — the left column. */
  orchestratorPane: string;
  /** The last child pane, when a right column already exists. */
  lastChildPane?: string;
  /** Working directory for the new pane (a repo root or a worktree). */
  cwd: string;
  /** Environment injected into the pane (orchestration id, gate mode…). */
  env?: Readonly<Record<string, string>>;
  /** The command the pane runs. Defaults to an interactive `pi`. */
  command?: readonly string[];
}

/** `-e K=V` pairs, in a stable order so the argv is testable. */
function envArgs(env: Readonly<Record<string, string>> | undefined): string[] {
  if (!env) return [];
  return Object.keys(env)
    .sort()
    .flatMap((key) => ["-e", `${key}=${env[key]}`]);
}

/**
 * Open a child session pane, following the layout rules in the header.
 *
 * `-P -F '#{pane_id}'` makes tmux PRINT the new pane id, which is how the
 * registry learns what it just created — guessing it (or listing panes and
 * diffing) is exactly the improvisation this module removes.
 */
export function buildSpawnPaneArgv(opts: SpawnPaneOptions): readonly string[] {
  const self = requirePane(opts.orchestratorPane, "orchestratorPane");
  const command = opts.command ?? ["pi"];
  // First child ⇒ create the right column off the orchestrator (horizontal).
  // Later children ⇒ stack under the last child (vertical).
  const [direction, target] = opts.lastChildPane
    ? ["-v", requirePane(opts.lastChildPane, "lastChildPane")]
    : ["-h", self];
  return assertSafeTmuxArgv([
    "split-window",
    direction,
    "-t",
    target,
    "-c",
    opts.cwd,
    ...envArgs(opts.env),
    "-P",
    "-F",
    "#{pane_id}",
    ...command,
  ]);
}

/**
 * Open the SUCCESSOR orchestrator beside the current one (relay, §8).
 * Always horizontal off the orchestrator's own pane: when the old pane is
 * closed afterwards, tmux expands the successor into the left column, which
 * is what makes the handover invisible in the user's layout.
 */
export function buildRelayPaneArgv(opts: {
  orchestratorPane: string;
  cwd: string;
  env?: Readonly<Record<string, string>>;
  command?: readonly string[];
}): readonly string[] {
  const self = requirePane(opts.orchestratorPane, "orchestratorPane");
  return assertSafeTmuxArgv([
    "split-window",
    "-h",
    "-t",
    self,
    "-c",
    opts.cwd,
    ...envArgs(opts.env),
    "-P",
    "-F",
    "#{pane_id}",
    ...(opts.command ?? ["pi"]),
  ]);
}

/**
 * Deliver a message to a child pane.
 *
 * TWO commands, deliberately: `-l` sends the text LITERALLY (so a message
 * containing `Enter`, `C-c` or a semicolon is data, never a key name), and a
 * separate `Enter` submits it. Sending them as one string is the classic way
 * to shred a multi-line message into half-executed input.
 */
export function buildSendMessageArgv(pane: string, text: string): readonly (readonly string[])[] {
  const target = requirePane(pane, "pane");
  // A newline inside the payload would submit early and split the message in
  // two; the child's input is a single line, so they are flattened to spaces.
  const oneLine = text.replace(/\r?\n/g, " ").trim();
  return [
    assertSafeTmuxArgv(["send-keys", "-t", target, "-l", oneLine]),
    assertSafeTmuxArgv(["send-keys", "-t", target, "Enter"]),
  ];
}

/** Close ONE pane. Panes only — never a window, never a session. */
export function buildKillPaneArgv(pane: string): readonly string[] {
  return assertSafeTmuxArgv(["kill-pane", "-t", requirePane(pane, "pane")]);
}

/** List the pane ids of the window a pane belongs to (liveness probing). */
export function buildListPanesArgv(pane: string): readonly string[] {
  return assertSafeTmuxArgv([
    "list-panes",
    "-t",
    requirePane(pane, "pane"),
    "-F",
    "#{pane_id}",
  ]);
}

/** Read back what tmux printed for `-P -F '#{pane_id}'` (or list-panes). */
export function parsePaneIds(stdout: string): string[] {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => isPaneId(line));
}

/** The single pane id a `-P` spawn printed, or undefined when tmux said nothing. */
export function parseSpawnedPaneId(stdout: string): string | undefined {
  return parsePaneIds(stdout)[0];
}
