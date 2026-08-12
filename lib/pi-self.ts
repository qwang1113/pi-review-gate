/**
 * PI-SELF DETECTION — the gate must not gate its own maintenance.
 *
 * USER REQUIREMENT: sessions that work ON pi itself — the review-gate
 * extension's own repository or installed copy, the pi binary's install
 * directory, or the user's ~/.pi config dir — have the gate OFF
 * automatically: no LLM round-trip, no consent dialog, no review loop.
 *
 * Detection is DETERMINISTIC and path-based on purpose: the session's repo
 * root is chosen by the USER (the agent cannot forge which directory a
 * session runs in), so a path hit is a genuine signal. Text claims ("this is
 * a pi task") are NOT trusted here — that soft path is covered by the LLM
 * classifier prompt instead (lib/llm-classify.ts, classifyTaskMode).
 *
 * The git hooks mirror this exemption deterministically (hooks/pre-commit
 * and hooks/commit-msg: package.json name === "pi-review-gate"), so pi-self
 * commits never need REVIEW_GATE_BYPASS while ordinary repos stay fully
 * enforced. Hooks only exist inside git repos, so the ~/.pi and pi-binary
 * branches of this module matter only to the in-session extension.
 */
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gitRootOfDir } from "./repo-resolve.ts";

/** The gate's own package name — its repo is exempt wherever it is checked out. */
export const GATE_PACKAGE_NAME = "pi-review-gate";

let cachedSelfRoots: readonly string[] | undefined;

/** Paths that count as "pi itself". Resolved once per process (the extension
 *  is resident; these paths cannot move under it mid-session). */
function selfRoots(): readonly string[] {
  if (cachedSelfRoots) return cachedSelfRoots;
  const roots = new Set<string>();
  // <gate-root>/lib in the dev checkout, .../extensions/pi-review-gate/lib in
  // the installed copy (which itself lives under ~/.pi — doubly covered below).
  const here = dirname(fileURLToPath(import.meta.url));

  // 1. The gate's own source: its git checkout, or its non-repo installed copy.
  const gateRoot = gitRootOfDir(here) ?? resolve(here, "..");
  roots.add(gateRoot);

  // 2. The pi binary install directory (global node_modules layout).
  try {
    const req = createRequire(import.meta.url);
    const pkgEntry = req.resolve("@earendil-works/pi-coding-agent/package.json");
    roots.add(dirname(pkgEntry));
  } catch { /* not resolvable from here — no signal */ }

  // 3. The user's pi config dir.
  roots.add(resolve(homedir(), ".pi"));

  cachedSelfRoots = [...roots].map(realOrPlain);
  return cachedSelfRoots;
}

function realOrPlain(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/** Is `abs` (an absolute path) part of pi itself? */
export function isPiSelfPath(abs: string): boolean {
  const target = realOrPlain(abs);
  for (const root of selfRoots()) {
    if (target === root || target.startsWith(root + sep)) return true;
  }
  return false;
}

/** Is `root` a repository that IS the gate? Its own checkout, wherever it
 *  lives (name check) — or a path that is pi itself (path check). */
export function isPiSelfRoot(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { name?: unknown };
    if (pkg?.name === GATE_PACKAGE_NAME) return true;
  } catch { /* not a package — fall through to the path check */ }
  return isPiSelfPath(root);
}
