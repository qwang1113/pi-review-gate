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
 * THE RESUME KEY, scoped to the opener and to the review LANE: same role +
 * same repo + same opener + same lane ⇒ same session id ⇒ the next pane
 * continues the same pi session.
 * A different opener session gets a different id ⇒ a fresh transcript that never inherits another session's context.
 * A different LANE does the same on purpose: that is how the reuse unit ends
 * (a new goal/plan) and how the gate rotates a transcript that grew too big
 * (lib/judge-rotation.ts). Omitting the lane reproduces the pre-lane id exactly.
 * Crash recovery is unaffected: the same opener re-opens with the same id and resumes its transcript.
 */
export function judgeSessionIdFor(role: string, repoHash: string, openerId: string, lane?: JudgeLane): string {
  const safeRole = role.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 20);
  const safeHash = repoHash.replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
  const raw = `${JUDGE_SESSION_PREFIX}${safeRole}-${safeHash}-${shortOpenerHash(openerId)}${laneSuffix(lane)}`;
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

/** A short opener discriminator for ids (empty input still hashes deterministically; callers fail closed first). */
export function shortOpenerHash(openerId: string): string {
  return shortRepoHash(openerId.trim() || "unknown");
}

/**
 * WHICH transcript a judge is running in: the review OBJECT it serves and the
 * generation of that object's transcript.
 *
 * The policy that produces a lane lives in lib/judge-rotation.ts; the lane
 * itself lives HERE, with the id derivation, because both the session id and
 * the work dir are rendered from it and they must never disagree about which
 * lane they name (a session id from one lane beside a dir from another is a
 * judge writing its transcript where nobody will look for it).
 */
export interface JudgeLane {
  /** Full object id — the approved goal/plan hash, or the "none" placeholder. */
  objectId: string;
  /** 0 for the object's first transcript, +1 for each gate-decided rotation. */
  generation: number;
}

/**
 * The object's discriminator inside an id or a path: always 8 hex chars.
 *
 * An approved hash is already hex, so it is simply truncated (the FULL id
 * stays in the registry — comparisons are made against that, never against
 * this prefix). Anything else — the `none` placeholder above all — is folded
 * through the same cheap hash the repo and opener use, so every lane suffix
 * has ONE recognisable shape for the dir-name matchers to key on.
 */
export function shortObjectId(objectId: string): string {
  const raw = objectId.trim();
  return /^[0-9a-f]{8,}$/i.test(raw) ? raw.toLowerCase().slice(0, 8) : shortRepoHash(raw || "none");
}

/**
 * The lane suffix shared by the session id and the work dir — ONE renderer, so
 * the two cannot drift into different lanes.
 *
 * No lane ⇒ empty string, byte-for-byte the pre-lane id and dir. That is what
 * lets a caller that has no lane fact (a legacy path, a test) keep working
 * unchanged instead of silently naming lane `none-g0`.
 */
export function laneSuffix(lane?: JudgeLane): string {
  if (!lane) return "";
  const generation = Number.isFinite(lane.generation) && lane.generation > 0 ? Math.floor(lane.generation) : 0;
  return `-${shortObjectId(lane.objectId)}-g${generation}`;
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
