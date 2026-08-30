/**
 * pi-review-gate — TUI widget content builders (pure functions).
 *
 * The extension renders one widget via `ctx.ui.setWidget`: belowEditor shows
 * the effective model configuration (adviser/reviewer models). The
 * sub-agent artifact scan was retired 2026-09-06 with the pi-subagents
 * companion.
 *
 * Everything here is a pure function of plain strings so it can be
 * unit-tested without a TUI. The extension owns the side effects
 * (reading goal files, calling setWidget) and the try/catch fallbacks.
 */

export interface ModelConfigWidgetEntry {
  /** Agent role name (reviewer, adviser, …). */
  name: string;
  /** Effective spec as shown, including any `:thinking` suffix. */
  spec: string;
  /** Whether the agent runs on its built-in default model chain. */
  auto: boolean;
  /** Which config layer decided this entry. */
  source: "project" | "global" | "default";
}

/**
 * Build the widget lines showing the effective model configuration for the
 * judgment agents. One line per agent: `model <name>: <spec>  [state · source]`.
 */
export function buildModelConfigWidget(entries: ModelConfigWidgetEntry[]): string[] {
  return entries.map((e) => {
    const state = e.auto === false ? "auto OFF" : "auto on";
    return `model ${e.name}: ${e.spec}  [${state} · ${e.source}]`;
  });
}

