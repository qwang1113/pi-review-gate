/**
 * pi-review-gate — TUI text builders for the two surfaces a session shows
 * about itself (pure functions).
 *
 * 1. The widget: ONE `ctx.ui.setWidget` call, belowEditor, a SINGLE-LINE gate
 *    status strip — mode/branch/edited + unmet count. It is deliberately
 *    minimal to keep the editor area quiet.
 * 2. The contract list: NOT a widget. It is rendered on demand by the
 *    `/gate-contract` command into the same multi-line `notify` block
 *    `/gate-status` uses (2026-09-18, user decision: 「不常驻展示, 而是通过某个
 *    命令」 — see the section below).
 *
 * 2026-09-16 — CHEAP BY CONTRACT: the strip must never run git work. It used
 * to include a full worktree fingerprint on every 5s tick (measured ~3.2s in
 * a 13k-file repo, on pi's main event loop — typing froze). The facts now
 * carry only in-memory state, one `symbolic-ref`, and the loop-goal flag;
 * anything that needs a fingerprint lives in `/gate-status` instead.
 *
 * Everything here is a pure function of plain strings so it can be
 * unit-tested without a TUI. The extension owns the side effects
 * (reading goal files, calling setWidget) and the try/catch fallbacks.
 */

export interface GateWidgetFacts {
  /** Current gate mode (loop / explore / normal / orchestrator). */
  mode?: string;
  /** True outside a git repository — the strip shows 非 git 目录 instead of a branch. */
  nonGit?: boolean;
  /** Current branch (the session works directly on it — no work branch). */
  branch?: string;
  /** The session has edited at least one file. */
  edited: boolean;
  /**
   * Review rounds THIS session sent out: `state.sentReviewRounds` in a loop
   * session, the task's own `roundSeq` in a judge pane.
   *
   * WHY IT IS ON THE STRIP (2026-09-17, user decision): "which round is this"
   * is what tells a reader whether the session is converging or stuck
   * polishing. It costs three characters and NO git work — the count is
   * already in memory, so the CHEAP-BY-CONTRACT rule above is untouched.
   *
   * WHAT IT COUNTS, AND WHAT IT DELIBERATELY IS NOT (same decision — the
   * reading it replaced was 「已结算的审查轮次 / 刹车阈值」, and the two halves
   * of that fraction were unrelated: the count only moved when a verdict was
   * recorded, so it sat still for the whole duration of every round, and the
   * denominator was the auto-loop BRAKE — a project-config number no reader
   * could tell apart from a review ceiling). The count is therefore
   * SUBMISSIONS, and there is no denominator: a round the judge is still
   * reading was sent. The brake still bites exactly as before — it just is
   * not on the strip.
   *
   * Absent ⇒ the reading is unknown and the segment is omitted entirely
   * (never rendered as 0, which would be a claim rather than a silence).
   */
  rounds?: number;
  /** Unmet requirements (ship-gate problems). */
  unmet: string[];
}

/**
 * WHICH SESSIONS SHOW THE ROUND READING (2026-09-17, user decision): a loop
 * session's own submissions and a judge pane's own round number are both
 * about reviewing. An orchestrator never reviews (its children do), and an
 * explore or normal session sends nothing to review — a permanent `轮 0`
 * there is noise a reader has to learn to ignore, so the segment is not
 * rendered at all.
 *
 * Pure, and the ONE place this rule lives: the extension asks it instead of
 * re-deriving "is this a reviewing session" from the mode string.
 */
export function showsRoundReading(f: { mode?: string; judge?: boolean }): boolean {
  return f.judge === true || f.mode === "loop";
}

/**
 * Build the gate status strip — ONE line: `门禁 · mode <mode> · <branch> ·
 * <已编辑|未编辑>`, plus the review round reading (`轮 N`) when known and
 * the unmet count when any (0 stays hidden).
 * Pure: everything comes from the facts object.
 */
export function buildGateWidget(f: GateWidgetFacts): string[] {
  // NON-GIT (2026-09-02): outside a repository the strip leads with
  // 非 git 目录 — mode/branch are both meaningless there (reviewer P2).
  // The round reading is meaningless there too (no repo ⇒ no review), so
  // this branch stays exactly as it was.
  if (f.nonGit) return [`门禁 · 非 git 目录 · ${f.edited ? "已编辑" : "未编辑"}`];
  const wsBits: string[] = [`mode ${f.mode ?? "未初始化"}`];
  if (f.branch) wsBits.push(f.branch);
  wsBits.push(f.edited ? "已编辑" : "未编辑");
  // ROUND READING — deliberately before the unmet count, so the two numbers
  // that answer "how is this going" sit next to each other. Submission
  // count, no denominator: what it counts and why there is no ceiling are
  // `GateWidgetFacts.rounds`'s to explain, not this line's.
  if (typeof f.rounds === "number" && Number.isFinite(f.rounds)) {
    wsBits.push(`轮 ${f.rounds}`);
  }
  if (f.unmet.length > 0) wsBits.push(`${f.unmet.length} 项未满足`);
  return [`门禁 · ${wsBits.join(" · ")}`];
}

// ---------------------------------------------------------------------------
// The contract list — shown ON DEMAND by `/gate-contract` (2026-09-18)
// ---------------------------------------------------------------------------
//
// The strip above answers "what is this session"; this answers "what is it
// working towards", which otherwise means opening `.pi/orchestrator-plan.json`
// or `.pi/loop-goal.md`. A PROJECT MANAGER sees its plan tasks with the plan's
// own statuses; a loop session (standalone or an orchestrated child) sees the
// exit criteria of ITS approved goal.
//
// ON DEMAND, NOT PERMANENT (user decision, same day). An earlier revision of
// this feature lived above the editor all the time, and everything that came
// with it — a per-tick rebuild, a content-compare cache, a display-width cut
// so a long criterion could not steal editor rows, a fold line, theme colors,
// and a `declare_done` flag whose only job was to retire the strip — is gone.
// Nothing of that is needed by a list the user asks for, and 哲学三 forbids
// keeping the old path beside the new one. Consequences worth naming:
//
//  - NO truncation and NO height budget: the terminal wraps a long criterion,
//    and every plan task is listed. Space is not borrowed from anything.
//  - NO colors: the surface is `notify`, which takes ONE color for the whole
//    block. The glyphs still carry the state, so nothing is lost that color
//    was adding.
//
// WHAT IT NEVER DOES: judge. A goal row is `○` because nothing in the gate can
// say "criterion 3 holds" — a reviewer's findings carry `severity`/`file`/
// `line`/`issue`/`evidence` and NO criterion index, so a `✓` there would be a
// claim with nothing behind it. Display-only and cheap: no git work, no
// fingerprint, and nothing here is an enforcement input.

/** The four states a plan task can be in — the plan's own vocabulary. */
export type ContractState = "pending" | "running" | "done" | "blocked";

export interface ContractRow {
  /** The contract's OWN words. Shown as written — see `plainMarkdown` for the
   *  one mechanical thing dropped on the way. */
  text: string;
  state: ContractState;
  /** Plan rows only: the task ids this one is waiting on. */
  waitingOn?: string[];
}

export interface ContractFacts {
  /** Which contract this session owns. Anything else (judge pane, explore,
   *  normal, a non-git directory, an unapproved goal, no plan) has no rows. */
  kind?: "plan" | "goal";
  rows: ContractRow[];
}

/**
 * Single-cell glyphs, NOT emoji (the user's call: emoji read as 「比较奇怪」 on
 * this line). Each is one column wide — like the CJK text beside it, so the
 * column holds — and the glyph alone says the state, since the surface this
 * goes to cannot color a line.
 */
const CONTRACT_GLYPHS: Record<ContractState, string> = {
  pending: "○",
  running: "▸",
  done: "✓",
  blocked: "✕",
};

/** Goal rows have no state to report — see the block comment above. */
const GOAL_GLYPH = CONTRACT_GLYPHS.pending;

/** The plan facts this builder needs — read structurally, so the widget module
 *  never imports the orchestrator's types (and the test needs no plan parser). */
export interface PlanTaskFacts {
  id: string;
  title: string;
  status: ContractState;
  dependsOn: readonly string[];
}

/**
 * Plan tasks → contract rows, with the plan's OWN statuses (nothing invented:
 * a task whose deps are unmet but which the scheduler still calls `pending`
 * stays `○`, because `blocked` is the plan's word for a task someone marked
 * so). `waitingOn` lists the dependencies that are not `done`, which is what
 * the `✕` row then names — the reader sees WHICH id holds the line, not just
 * that something does.
 *
 * Absent or empty plan ⇒ [] — the one shape every "no contract here" case
 * arrives as (no plan file, unreadable JSON, an archived plan).
 */
export function planContractRows(tasks: readonly PlanTaskFacts[] | undefined): ContractRow[] {
  if (!tasks || tasks.length === 0) return [];
  const done = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
  return tasks.map((t) => ({
    text: `${t.id} ${t.title}`.trim(),
    state: t.status,
    waitingOn: (t.dependsOn ?? []).filter((d) => !done.has(d)),
  }));
}

/**
 * Drop markdown BOLD markers, which a text surface cannot render.
 *
 * The one and only edit this display makes to a contract's wording, and it is
 * mechanical: `**交付即清栏**` is the goal file's way of EMPHASISING, and here
 * the asterisks would just be two stars nobody asked for. Measured across this
 * repo's 48 goal files, 122 of 310 criteria rows carry a paired `**`, so this
 * is not a corner case. Nothing is reworded, reordered or shortened.
 */
function plainMarkdown(text: string): string {
  return text.replace(/\*\*|__/g, "").trim();
}

/**
 * Build the contract list — the lines `/gate-contract` shows.
 *
 * Pure: every fact comes in through `f`. Returns [] for nothing to show, which
 * is the CALLER's signal to say why there is no contract here (an unapproved
 * or edited-after-approval goal, an absent / unreadable / archived plan, a
 * child with no goal of its own, a judge pane, a non-git directory) — the
 * reason is a gate fact the caller holds, not something this function can see.
 */
export function buildContractLines(f: ContractFacts): string[] {
  if (f.kind !== "plan" && f.kind !== "goal") return [];
  const rows = f.rows.filter((r) => r && r.text.trim() !== "");
  if (rows.length === 0) return [];

  const lines =
    f.kind === "plan"
      ? [`plan · ${rows.length} 项 · ${rows.filter((r) => r.state === "done").length} 完成`]
      : ["loop goal · 退出标准"];
  for (const r of rows) {
    const glyph = f.kind === "goal" ? GOAL_GLYPH : CONTRACT_GLYPHS[r.state];
    // The blocker ids stay on the row even though nothing else is decorated:
    // on a `✕` line, `等 t2` is the one thing the reader can act on.
    const wait = r.state === "blocked" && r.waitingOn?.length ? ` · 等 ${r.waitingOn.join(" ")}` : "";
    lines.push(`${glyph} ${plainMarkdown(r.text)}${wait}`);
  }
  return lines;
}
