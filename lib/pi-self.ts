/**
 * PI-SELF DETECTION — pi's own configuration is not gate material.
 *
 * USER REQUIREMENT: sessions that work on pi's GLOBAL configuration — the
 * user's ~/.pi config dir (settings, MCP, installed extensions) or the pi
 * binary's install directory — or that troubleshoot pi's own behavior, have
 * the gate OFF automatically: no LLM round-trip, no consent dialog, no
 * review loop.
 *
 * DELIBERATE NON-GOAL: developing pi-review-gate ITSELF (its repository
 * anywhere, or a per-project .pi install) is NOT pi-self — it is regular
 * development and runs the full loop. The gate gates its own development
 * like any other code; it only steps aside for pi's global config.
 *
 * Detection is DETERMINISTIC and path-based on purpose: the session's repo
 * root is chosen by the USER (the agent cannot forge which directory a
 * session runs in), so a path hit is a genuine signal. Text claims ("this is
 * a pi task") are NOT trusted here — that soft path is covered by the LLM
 * classifier prompt instead (lib/llm-classify.ts, classifyTaskMode).
 *
 * The git hooks need NO mirror of this: ~/.pi and the pi binary install are
 * not git repositories, so no hook ever runs there. Ordinary repos — the
 * gate's own checkout included — stay fully enforced.
 */
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cachedSelfRoots: readonly string[] | undefined;

/** Paths that count as "pi's global configuration". Resolved once per process
 *  (the extension is resident; these paths cannot move under it mid-session). */
function selfRoots(): readonly string[] {
  if (cachedSelfRoots) return cachedSelfRoots;
  const roots = new Set<string>();

  // 1. The user's pi config dir — settings, MCP config, installed extensions
  //    (the review-gate install copy lives under ~/.pi/agent/extensions/…,
  //    so editing the INSTALLED copy is config work; the source repo is not).
  roots.add(resolve(homedir(), ".pi"));

  // 2. The pi binary install directory (global node_modules layout).
  try {
    const req = createRequire(import.meta.url);
    const pkgEntry = req.resolve("@earendil-works/pi-coding-agent/package.json");
    roots.add(dirname(pkgEntry));
  } catch { /* not resolvable from here — no signal */ }

  cachedSelfRoots = [...roots].map(realOrPlain);
  return cachedSelfRoots;
}

function realOrPlain(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/** Is `abs` (an absolute path) part of pi's global configuration? */
export function isPiSelfPath(abs: string): boolean {
  const target = realOrPlain(abs);
  for (const root of selfRoots()) {
    if (target === root || target.startsWith(root + sep)) return true;
  }
  return false;
}

/** Is `root` a repository/session root that IS pi's global config? A path
 *  check only — the gate's OWN checkout is deliberately NOT pi-self
 *  (developing it runs the full loop). */
export function isPiSelfRoot(root: string): boolean {
  return isPiSelfPath(root);
}
