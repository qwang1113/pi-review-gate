/**
 * SCRATCH-SESSION DETECTION — /tmp sessions never enter loop via the agent.
 *
 * USER REQUIREMENT: ONLY sessions started in the scratch dir /tmp (macOS
 * /private/tmp is the same dir through a symlink) are path-exempt: they
 * NEVER enter loop via the agent. First classification is explore
 * (investigation) or normal (local pi-config work / chores) — no consent
 * dialog. Explore still keeps the L1 ship gate; only normal steps the
 * in-session gate aside. Everything under /tmp is scratch for PATH
 * detection, including any incidental git checkout inside it.
 *
 * NOTHING ELSE IS PATH-EXEMPT — in particular NOT:
 *  - a session STARTED IN the user's ~/.pi config dir,
 *  - the pi binary's install directory,
 *  - developing pi-review-gate ITSELF (its repository anywhere, or a
 *    per-project .pi install) — that is regular development and runs the
 *    full loop. Editing ~/.pi FROM a /tmp session is the intended scratch
 *    case and stays out of loop.
 *
 * Detection is DETERMINISTIC and path-based on purpose: the session's repo
 * root is chosen by the USER (the agent cannot forge which directory a
 * session runs in), so a path hit is a genuine signal. Text claims ("this
 * is a pi task") are NOT trusted here — the agent's own gate-mode pick is the
 * soft path, and this clamp exists precisely to bound it (lib/task-mode.ts,
 * scratchFirstMode).
 *
 * The git hooks need NO mirror of this: /tmp is scratch space, so no
 * hook-installed repo lives there. Ordinary repos — the gate's own
 * checkout included — stay fully enforced.
 */
import { resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

let cachedSelfRoots: readonly string[] | undefined;

/** Paths that count as path-exempt scratch roots. Resolved once per process
 *  (the extension is resident; these paths cannot move under it mid-session). */
function selfRoots(): readonly string[] {
  if (cachedSelfRoots) return cachedSelfRoots;
  const roots = new Set<string>();

  // 1. Scratch/temp dirs: sessions started in /tmp (macOS /private/tmp is
  //    the same dir through a symlink) are ad-hoc scratch sessions (pi
  //    config work, troubleshooting). The agent cannot enter loop there
  //    (USER REQUIREMENT): first classification is explore or normal;
  //    explore still keeps the L1 ship gate. Everything under /tmp is a
  //    scratch PATH, including any incidental git checkout inside it.
  roots.add("/tmp");

  // Keep BOTH the plain and the realpath form of every root: a path that
  // does not exist yet (e.g. /tmp/scratch-dir) stays in its plain form while
  // its root (e.g. /tmp → /private/tmp on macOS) was realpathed — a
  // one-sided normalization would miss the match.
  cachedSelfRoots = [...roots].flatMap(pathVariants);
  return cachedSelfRoots;
}

function pathVariants(p: string): string[] {
  const variants = new Set<string>([resolve(p)]);
  try { variants.add(realpathSync(p)); } catch { /* keep the plain form */ }
  return [...variants];
}

/** Is `abs` (an absolute path) inside a path-exempt scratch root (/tmp)? */
export function isPiSelfPath(abs: string): boolean {
  const targetVariants = pathVariants(abs);
  for (const root of selfRoots()) {
    if (targetVariants.some((t) => t === root || t.startsWith(root + sep))) return true;
  }
  return false;
}

/** Is `root` a repository/session root that is path-exempt? A path check
 *  only — anything outside /tmp (the gate's OWN checkout included) is
 *  deliberately NOT exempt and runs the full loop. */
export function isPiSelfRoot(root: string): boolean {
  return isPiSelfPath(root);
}
