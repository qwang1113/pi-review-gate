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
 * THE LAYOUT (user requirement, 2026-09-08: 一个 window 最多 3 列，前两列固定
 * 独占一列，第三个会话之后共享第三列、高度等分):
 *
 *     window
 *     ├─ column 1   one pane, full height   (the opener / project manager)
 *     ├─ column 2   one pane, full height   (the first session opened)
 *     └─ column 3   EVERY remaining pane, height shared evenly
 *
 *  - fewer than three columns → `split-window -h` beside a pane that sits
 *    ALONE in its column (the rightmost such column): a lone pane's parent IS
 *    the window root, so the split flattens into a real sibling column and
 *    lands where the third one belongs, keeping the SHARED column rightmost.
 *    Splitting a pane inside a multi-pane column NESTS a half-width pane there
 *    instead — measured, and reachable: close the middle column of a
 *    three-column window and the third column's panes ARE the second one. If
 *    NO column sits alone (a shape the gate never builds), the split carries
 *    `-f`, which spans the window height and opens a real column at the right
 *    edge. Both sequences are regression tests in
 *    test/tmux-window-layout.integration.test.ts;
 *  - three or more → `split-window -v` off the third column's last pane;
 *  - a handoff (giving the orchestration to a successor) → `split-window -h`
 *    off the orchestrator's own pane, so the successor lands beside it and
 *    inherits the left column when the old pane is closed. That is the ONE
 *    deliberate exception: it holds a fourth column for as long as both panes
 *    are alive.
 *
 * WHICH COLUMN IS "THE THIRD" IS A FACT ABOUT THE WINDOW, NOT ABOUT A REGISTRY
 * (2026-09-08). The old rule asked the opener's own child list, and every
 * session keeps its own — so a judge pane opened by a child, or a second
 * orchestration in the same window, each saw "no children yet" and opened a
 * NEW column. The user's own window had five. The rule now reads the window's
 * real geometry ({@link buildWindowLayoutArgv}) and decides in
 * {@link planPanePlacement}; equalising the result is {@link buildEvenLayoutArgv}.
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
  /** Where the new pane goes — the answer {@link planPanePlacement} gives. */
  placement: PanePlacement;
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
  const command = opts.command ?? ["pi"];
  return assertSafeTmuxArgv([
    "split-window",
    opts.placement.direction,
    // `-f` spans the whole window's other axis instead of splitting the
    // target — the one flag that turns a split into a NEW COLUMN wherever the
    // target happens to sit (see the header).
    ...(opts.placement.full ? ["-f"] : []),
    "-t",
    requirePane(opts.placement.target, "placement.target"),
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
 * Open the SUCCESSOR orchestrator beside the current one (handoff).
 * Always horizontal off the orchestrator's own pane: when the old pane is
 * closed afterwards, tmux expands the successor into the left column, which
 * is what makes the handover invisible in the user's layout.
 */
export function buildHandoffPaneArgv(opts: {
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
 * THERE IS NO `send-keys` BUILDER, AND THAT IS THE POINT (2026-08-30).
 *
 * Delivering text and pressing keys used to live here. Both are gone, with
 * every caller, because typing at a TUI is not an API: the measured results
 * were a truncated task document (F7), a message that was never submitted
 * (F8), text landing in the composer or the steering queue depending on
 * timing (R-20), and a confirmation dialog that ignored `Enter` and `C-m` and
 * accepted only `KPEnter` (R-8).
 *
 * Both jobs now go through the channel instead:
 *
 *  - a MESSAGE is written to the child's channel and the child's own gate
 *    injects it with `pi.sendUserMessage` (lib/orchestrator-child-channel.ts);
 *  - an ANSWER to a dialog is written to the same channel and resolves the
 *    `ui.select` the child's gate is already awaiting — no keystroke exists
 *    anywhere in that path.
 *
 * What is left in this module is what tmux is genuinely for: creating a pane,
 * closing a pane, and enumerating which panes exist.
 */


/** Close ONE pane. Panes only — never a window, never a session. */
export function buildKillPaneArgv(pane: string): readonly string[] {
  return assertSafeTmuxArgv(["kill-pane", "-t", requirePane(pane, "pane")]);
}

/**
 * ── PANE DECORATION (2026-08-30) ──
 *
 * Four builders, all cosmetic, and they are the ONLY writes this module makes
 * that are not about creating, closing or listing a pane. They exist because
 * the user asked for children to be tellable apart on screen, and because the
 * gate — not the orchestrator — has to be the one that runs them (philosophy
 * one: the project manager never assembles a tmux command).
 *
 * WHY THIS IS NOT THE FORBIDDEN KIND OF CONFIG WRITE. `assertSafeTmuxArgv`
 * refuses any option write carrying `-g`, because that is the user's GLOBAL
 * configuration and no gate has business touching it. These are window- and
 * pane-scoped: `select-pane -P/-T` affects exactly one pane the registry
 * created, and `setw -t <pane>` affects the window that pane lives in — the
 * one the orchestration was invited into. Both are undone on close.
 *
 * The colour and title STRINGS are decided in lib/orchestrator-pane-decor.ts;
 * everything here does is put them in an argv array where no shell can see
 * them. A title is arbitrary text (a task title), so it travels as its own
 * argv element and is never concatenated into a command line.
 */

/** Set one pane's border colour (`-P` is the pane style). */
export function buildPaneStyleArgv(pane: string, style: string): readonly string[] {
  return assertSafeTmuxArgv(["select-pane", "-t", requirePane(pane, "pane"), "-P", style]);
}

/** Set one pane's title — what `pane-border-format` then renders. */
export function buildPaneTitleArgv(pane: string, title: string): readonly string[] {
  return assertSafeTmuxArgv(["select-pane", "-t", requirePane(pane, "pane"), "-T", title]);
}

/**
 * Turn the label bar on for the WINDOW a pane belongs to.
 *
 * Two commands rather than one because tmux takes one option per call; the
 * caller runs them in order and treats any failure as cosmetic.
 */
export function buildShowPaneLabelsArgv(
  pane: string,
  status: string,
  format: string,
): readonly (readonly string[])[] {

  const target = requirePane(pane, "pane");
  return [
    assertSafeTmuxArgv(["setw", "-t", target, "pane-border-status", status]),
    assertSafeTmuxArgv(["setw", "-t", target, "pane-border-format", format]),
  ];
}

/**
 * Undo it — `-u` restores each option to what the user's own config says,
 * which is not the same as setting it to a default we invented.
 */
export function buildHidePaneLabelsArgv(pane: string): readonly (readonly string[])[] {

  const target = requirePane(pane, "pane");
  return [
    assertSafeTmuxArgv(["setw", "-t", target, "-u", "pane-border-status"]),
    assertSafeTmuxArgv(["setw", "-t", target, "-u", "pane-border-format"]),
  ];
}


/**
 * List the pane IDS of the window a pane belongs to — "who is there", for
 * liveness probing. {@link buildWindowLayoutArgv} asks the other question
 * ("who is WHERE"), which is what the three-column rule reads.
 */
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

// ---------------------------------------------------------------------------
// The window's own geometry (three-column rule, 2026-09-08)
// ---------------------------------------------------------------------------

/** One pane as tmux reports its place in the window. */
export interface WindowPane {
  id: string;
  /** Column membership: panes sharing `left` are in the same column. */
  left: number;
  /** Order within the column. */
  top: number;
}

/** The window as it actually looks right now. */
export interface WindowLayout {
  /** Left→right; panes within a column top→bottom. Never empty once parsed. */
  columns: WindowPane[][];
  /** One pane is zoomed — equalising would fight what the user is reading. */
  zoomed: boolean;
}

/** Probe the geometry of the window a pane lives in. */
export function buildWindowLayoutArgv(pane: string): readonly string[] {
  return assertSafeTmuxArgv([
    "list-panes",
    "-t",
    requirePane(pane, "pane"),
    "-F",
    "#{pane_id} #{pane_left} #{pane_top} #{window_zoomed_flag}",
  ]);
}

/**
 * Group what tmux printed into columns.
 *
 * PANES SHARING A `left` ARE ONE COLUMN — that is the whole grouping rule, and
 * it is measured rather than inferred from split history: after three
 * horizontal splits and two vertical ones the window reports
 * `{p1, p2, p3[child, child, child]}`, and only `left` tells the two levels
 * apart. A line that does not parse is skipped — a format this build does not
 * understand must not invent a layout.
 */
export function parseWindowLayout(stdout: string): WindowLayout {
  const panes: WindowPane[] = [];
  let zoomed = false;
  for (const raw of String(stdout ?? "").split(/\r?\n/)) {
    const [id, rawLeft, rawTop, flag] = raw.trim().split(/\s+/);
    const left = Number(rawLeft);
    const top = Number(rawTop);
    if (!isPaneId(id) || !Number.isInteger(left) || !Number.isInteger(top)) continue;
    panes.push({ id, left, top });
    if (flag === "1") zoomed = true;
  }
  panes.sort((a, b) => a.left - b.left || a.top - b.top);
  const columns: WindowPane[][] = [];
  let currentLeft: number | undefined;
  for (const pane of panes) {
    if (currentLeft === undefined || pane.left !== currentLeft) {
      columns.push([]);
      currentLeft = pane.left;
    }
    columns[columns.length - 1]!.push(pane);
  }
  return { columns, zoomed };
}

/** Where a new pane goes, in tmux's own vocabulary. */
export interface PanePlacement {
  /** `-h` opens a column, `-v` stacks inside one. */
  direction: "-h" | "-v";
  /** The pane tmux splits — or, with `full`, the pane the new column lands beside. */
  target: string;
  /**
   * Pass `-f`: the new pane spans the whole window's other axis instead of
   * splitting the target. Only meaningful with `-h`, where it is what makes
   * the split a real column.
   */
  full?: boolean;
}

/**
 * THE RULE, in one function: fewer than three columns ⇒ open a new one;
 * otherwise ⇒ stack under the third column's last pane.
 *
 * Requires a non-empty layout — the caller probed a live pane, so the window
 * holds at least that pane.
 */
export function planPanePlacement(columns: readonly (readonly WindowPane[])[]): PanePlacement {
  if (columns.length === 0) {
    throw new Error("planPanePlacement 需要一个非空的窗口布局");
  }
  if (columns.length >= 3) {
    const third = columns[2]!;
    return { direction: "-v", target: third[third.length - 1]!.id };
  }
  // OPENING A NEW COLUMN, and the lone pane is what decides where it goes.
  //
  // A plain `-h` split is FLATTENED into the target's parent container when
  // the direction matches, and NESTS a half-width pane inside it when it does
  // not — measured: splitting the last pane of a two-column window whose right
  // column held three panes produced `{c1, c2[…{half, half}]}` and the
  // three-column rule became a lie. A lone pane's parent IS the window root,
  // so splitting beside it lands exactly where the third column belongs, with
  // the shared column staying rightmost.
  const alone = [...columns].reverse().find((column) => column.length === 1);
  if (alone) return { direction: "-h", target: alone[0]!.id };
  // No column sits alone — a shape the gate never builds. A plain split would
  // nest, so `-f` is the only way to get a real column here; it lands at the
  // right edge (measured: `-f` ignores the target's position entirely), which
  // is where the shared column ends up anyway.
  const rightmost = columns[columns.length - 1]!;
  return { direction: "-h", target: rightmost[rightmost.length - 1]!.id, full: true };
}

/**
 * Equalise the space a pane shares with its SIBLINGS (`select-layout -E`).
 *
 * tmux spreads the target pane's PARENT container evenly, so the target picks
 * the axis: a third-column pane equalises that column's heights, a
 * first-column pane equalises the columns' widths. Both were measured on a
 * scratch tmux server (16/16/16 heights, 66/66/66 widths) before this was
 * wired in — the whole rule rests on that behaviour.
 */
export function buildEvenLayoutArgv(pane: string): readonly string[] {
  return assertSafeTmuxArgv(["select-layout", "-E", "-t", requirePane(pane, "pane")]);
}
