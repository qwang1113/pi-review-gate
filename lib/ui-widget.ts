/**
 * pi-review-gate — TUI widget content builders (pure functions).
 *
 * The extension renders ONE widget via `ctx.ui.setWidget`: belowEditor shows
 * a SINGLE-LINE gate status strip — mode/branch/edited + unmet count. All
 * details live in the `/gate-status` command; the strip is deliberately
 * minimal to keep the editor area quiet.
 *
 * Everything here is a pure function of plain strings so it can be
 * unit-tested without a TUI. The extension owns the side effects
 * (reading goal files, calling setWidget) and the try/catch fallbacks.
 */

export interface GateWidgetFacts {
  /** Current gate mode (loop / explore / normal / orchestrator). */
  mode?: string;
  /** Current branch (the session works directly on it — no work branch). */
  branch?: string;
  /** The session has edited at least one file. */
  edited: boolean;
  /** Unmet requirements (ship-gate problems). */
  unmet: string[];
}

/**
 * Build the gate status strip — ONE line: `门禁 · mode <mode> · <branch> ·
 * <已编辑|未编辑>`, plus the unmet count when any (0 stays hidden).
 * Pure: everything comes from the facts object.
 */
export function buildGateWidget(f: GateWidgetFacts): string[] {
  const wsBits: string[] = [`mode ${f.mode ?? "?"}`];
  if (f.branch) wsBits.push(f.branch);
  wsBits.push(f.edited ? "已编辑" : "未编辑");
  if (f.unmet.length > 0) wsBits.push(`${f.unmet.length} 项未满足`);
  return [`门禁 · ${wsBits.join(" · ")}`];
}
