/**
 * THE JUDGE'S CROSS-PROCESS CONTRACT — the env keys a judge pane is known by,
 * and whether its pane is still there.
 *
 * ── WHAT THIS FILE IS, AFTER THE SESSION FACTORY (2026-09-05) ──
 *
 * Opening a judge pane used to live here, in a sequence that was a near-copy of
 * the orchestration spawn's. That whole half moved into lib/session-factory.ts
 * (the judge argv and border since in lib/session-launch-specs.ts), which is now the only place ANY pi session is given a pane — and the only
 * consumer of the tmux argv builders. What stayed is the part that is not about
 * opening anything:
 *
 *  1. THE ENVIRONMENT KEYS. `RG_JUDGE_OPENER` / `RG_JUDGE_ID` / `RG_JUDGE_ROLE`
 *     are read by a DIFFERENT process (lib/judge-side.ts, running whatever
 *     build of this extension is on disk when the pane boots) and additionally
 *     grant the judge its exemption from the session-exclusivity guard. They
 *     are a wire format: the names and their value semantics are frozen, and
 *     they live in a leaf module precisely so that nothing about spawning can
 *     accidentally rename one.
 *  2. PANE LIVENESS. "Is that pane still there" is a question every lifecycle
 *     tool asks (wait, close, recover) and no spawner asks; an unreadable list
 *     is missing INFORMATION, never evidence of death. `listServerPanes` is the
 *     ONE reading of that list (2026-09-25, quality round P2): the judge probe,
 *     the orchestrator's "nothing is provably alive" check and the session
 *     registry's holder classification all ask tmux the same question, and a
 *     second copy of the argv plus its fail-closed catch is a second answer to
 *     it.
 *
 * Pure-ish: tmux enters through the injected {@link TmuxRunner}, so every
 * branch runs with a fake instead of a terminal.
 */
import {
  buildListServerPanesArgv,
  parsePaneIds,
  type TmuxRunner,
} from "./orchestrator-tmux.ts";

/** Who opened this judge — read by the judge-side gate from its own env. */
export const JUDGE_OPENER_ENV = "RG_JUDGE_OPENER";
/** This judge's id — the channel key and the pane's resume key. */
export const JUDGE_ID_ENV = "RG_JUDGE_ID";
/** reviewer | adviser | goal-auditor. */
export const JUDGE_ROLE_ENV = "RG_JUDGE_ROLE";

/**
 * Which panes exist right now — ON THE WHOLE SERVER. `undefined` means the
 * list itself is unreadable — missing information, never evidence of death.
 *
 * IT IS NO LONGER SCOPED TO THE OPENER'S WINDOW (2026-09-25). It used to be
 * `list-panes -t <opener's pane>`, which was the same thing as "my children"
 * only while children were split into that window; now they are windows of
 * other tmux sessions, so the window-scoped reading would have reported every
 * live child as DEAD — and an opener told its judge is gone goes and re-does
 * the round.
 */
export function listServerPanes(run: TmuxRunner): string[] | undefined {
  try {
    const result = run(buildListServerPanesArgv());
    if (!result.ok) return undefined;
    return parsePaneIds(result.stdout);
  } catch {
    return undefined;
  }
}

/** Is this pane still alive? Unreadable list ⇒ undefined (never "dead"). */
export function judgePaneAlive(
  run: TmuxRunner,
  paneId: string,
): boolean | undefined {
  const panes = listServerPanes(run);
  if (panes === undefined) return undefined;
  return panes.includes(paneId);
}
