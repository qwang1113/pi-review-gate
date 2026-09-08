/**
 * pi-review-gate — TUI widget content builders (pure functions).
 *
 * The extension renders ONE widget via `ctx.ui.setWidget`: belowEditor shows
 * a SINGLE-LINE gate status strip — mode/branch/edited + unmet count. All
 * details live in the `/gate-status` command; the strip is deliberately
 * minimal to keep the editor area quiet.
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
   * Recorded review rounds so far (`state.rounds.length`).
   *
   * WHY IT IS ON THE STRIP (2026-09-17, user decision A): "which round is
   * this" is what tells a reader whether the session is converging or stuck
   * polishing, and which round a verdict belongs to. Until now the only way
   * to learn it was to open a channel file. It costs three characters and NO
   * git work — the count is already in memory (the same field `/gate-status`
   * prints), so the CHEAP-BY-CONTRACT rule above is untouched.
   *
   * Absent ⇒ the reading is unknown and the segment is omitted entirely
   * (never rendered as 0, which would be a claim rather than a silence).
   */
  rounds?: number;
  /** The round ceiling (`state.maxRounds`); absent ⇒ the count shows alone. */
  maxRounds?: number;
  /** Unmet requirements (ship-gate problems). */
  unmet: string[];
}

/**
 * Build the gate status strip — ONE line: `门禁 · mode <mode> · <branch> ·
 * <已编辑|未编辑>`, plus the review round reading (`轮 N/M`) when known and
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
  // that answer "how is this going" sit next to each other. A known ceiling
  // is shown (`轮 3/25`: distance to the polish ceiling is the point);
  // without one the count stands alone rather than inventing a denominator.
  if (typeof f.rounds === "number" && Number.isFinite(f.rounds)) {
    const ceiling = typeof f.maxRounds === "number" && Number.isFinite(f.maxRounds) && f.maxRounds > 0
      ? `/${f.maxRounds}`
      : "";
    wsBits.push(`轮 ${f.rounds}${ceiling}`);
  }
  if (f.unmet.length > 0) wsBits.push(`${f.unmet.length} 项未满足`);
  return [`门禁 · ${wsBits.join(" · ")}`];
}
