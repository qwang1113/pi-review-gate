/**
 * Judge IDENTITY and scratch helpers — what survives of lib/judge-process.ts
 * after the pane migration.
 *
 * A judge used to be a non-interactive `pi -p` process this module spawned;
 * it is now an interactive pi in a tmux pane opened by lib/judge-pane.ts.
 * What stays here is process-independent: the deterministic session id (the
 * resume key across panes, rounds and restarts) and the gate-owned TMPDIR
 * helpers (a reviewer verifies by doing, and its throwaway worktrees still
 * land where the gate can reclaim them).
 *
 * Pure, except `judgeScratchDir` (tmpdir query) — no spawning, no processes.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Prefix of every gate-owned session id, so orphans are identifiable. */
export const JUDGE_SESSION_PREFIX = "rg-";

/** Max length of a gate-owned session id (pi accepts arbitrary ids; keep sane). */
export const MAX_SESSION_ID = 80;

/**
 * Deterministic session id for one judge role in one repo.
 *
 * THE RESUME KEY: same role + same repo ⇒ same session id ⇒ the next pane
 * continues the same pi session. Independent of the main session's own id,
 * so a restarted main session resumes a judge's context.
 */
export function judgeSessionIdFor(role: string, repoHash: string): string {
  const safeRole = role.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 20);
  const safeHash = repoHash.replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
  const raw = `${JUDGE_SESSION_PREFIX}${safeRole}-${safeHash}`;
  return raw.slice(0, MAX_SESSION_ID);
}

/** A short repo discriminator for ids: first 10 hex chars of the root hash. */
export function shortRepoHash(repoRoot: string): string {
  let hash = 0;
  for (let i = 0; i < repoRoot.length; i++) {
    hash = (hash * 31 + repoRoot.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 10);
}

/** Name of the dir holding every judge round's scratch worktrees. */
export const REVIEW_SCRATCH_DIRNAME = "rg-review-scratch";

/**
 * The gate-owned TMPDIR for one judge session — where its throwaway review
 * worktrees land, so the GATE can reclaim them (D — "whoever creates it clears
 * it"). A reviewer verifies by doing (`git worktree add <tmp> HEAD` to run
 * tests on the reviewed commit), and it was told to build those under $TMPDIR;
 * pointing $TMPDIR at a per-session dir the gate knows makes the cleanup
 * deterministic instead of a name-guessing sweep that could delete a
 * concurrent lane's live review worktree. Keyed by session id, so the reaping
 * side computes the same path without storing it.
 */
export function judgeScratchDir(sessionId: string): string {
  return join(tmpdir(), REVIEW_SCRATCH_DIRNAME, safeSessionFilePart(sessionId));
}

/**
 * The worktree paths from `git worktree list --porcelain` that live under
 * `scratchDir` — the ones a finished judge left behind. Pure string work so the
 * reaping decision is unit-testable without a repository.
 */
export function reviewScratchWorktrees(porcelain: string, scratchDir: string): string[] {
  const normalized = scratchDir.replace(/\/+$/, "");
  const prefix = normalized + "/";
  const paths: string[] = [];
  for (const rawLine of String(porcelain ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length).trim();
    if (path === normalized || path.startsWith(prefix)) paths.push(path);
  }
  return paths;
}

/** Sanitize a session-id-like string for use as a filename component. */
export function safeSessionFilePart(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
}
