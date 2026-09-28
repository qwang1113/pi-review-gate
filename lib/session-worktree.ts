/**
 * A SECOND SESSION IN A HELD REPO GETS ITS OWN CHECKOUT (2026-09-28, user
 * decision) — the pure half.
 *
 * Before: a second pi session started in a repository whose gate another live
 * session holds was refused outright (lib/session-exclusivity.ts) and told to
 * run `git worktree add` by hand — a multi-step flow the gate could perfectly
 * well do itself (philosophy one). Now the gate asks once, and on "yes" it cuts
 * a worktree under /tmp (lib/worktree-root.ts), seeds it like an orchestration
 * child's (lib/worktree-seed.ts) and moves the session into it in place. The
 * two sessions then share nothing but the object store.
 *
 * WHO CLEARS IT: the session that works in it, as soon as it is used up — when
 * its `declare_done` is accepted or its process exits. The leftovers are
 * committed onto the session's branch first, and the directory is removed only
 * when that commit landed (or there was nothing to commit): a refused commit
 * keeps the directory, because the work in it is then the only copy.
 *
 * OWNERSHIP IS A FILE BESIDE THE CHECKOUT (`<worktree>.owner.json`), not inside
 * it: inside, it would be untracked content in the very tree it describes. It
 * names the session, the process, the repo and the branch the gate cut.
 *
 * Pure: paths, names, argv, the record and the decisions. The IO is
 * lib/session-worktree-host.ts.
 */

import { basename, dirname, join } from "node:path";
import type { ChoiceSpec } from "./choice-dialog.ts";
import { gateWorktreeRoot } from "./worktree-root.ts";

export const SESSION_BRANCH_PREFIX = "rg-session-";

/** The internal command the gate dispatches to itself to get a command ctx. */
export const RELOCATE_COMMAND = "gate-relocate";

/** Where a session worktree lives. `token` is minted by the host (random). */
export function sessionWorktreePath(repoRoot: string, token: string): string {
  return join(gateWorktreeRoot(), `${basename(repoRoot) || "repo"}-s-${token}`);
}

export function sessionWorktreeBranch(token: string): string {
  return `${SESSION_BRANCH_PREFIX}${token}`;
}

/** Pinned to HEAD for the same reason a child's is (lib/orchestrator-worktree.ts). */
export function createSessionWorktreeArgv(repoRoot: string, path: string, branch: string): readonly string[] {
  return ["-C", repoRoot, "worktree", "add", "-b", branch, path, "HEAD"];
}

export function ownerRecordPath(worktreePath: string): string {
  return `${worktreePath}.owner.json`;
}

/** Is this path one of the gate's session worktrees (a direct child of the root)? */
export function isSessionWorktreePath(path: string): boolean {
  return dirname(path) === gateWorktreeRoot() && /-s-[A-Za-z0-9]+$/.test(basename(path));
}

export interface SessionWorktreeOwner {
  /** The session working in it — the only one that may reclaim it. */
  sessionId: string;
  /** Diagnostic, and how a `/new` in the SAME process re-adopts it. */
  pid: number;
  /** The repository it was cut from. */
  repo: string;
  /** The branch the gate cut; the session may have renamed it since. */
  branch: string;
  path: string;
}

export function parseOwner(raw: string | undefined): SessionWorktreeOwner | undefined {
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const s = (k: string) => (typeof v[k] === "string" && (v[k] as string).length > 0 ? (v[k] as string) : undefined);
    const sessionId = s("sessionId"), repo = s("repo"), branch = s("branch"), path = s("path");
    if (!sessionId || !repo || !branch || !path) return undefined;
    return { sessionId, repo, branch, path, pid: typeof v.pid === "number" ? v.pid : -1 };
  } catch {
    return undefined;
  }
}

/**
 * THE RECLAMATION, in order. A failure stops the sequence, so a commit that
 * did not land never reaches the removal — that is the whole safety property.
 * `branch` is the one the checkout is ON now (read by the caller; the session
 * may have renamed it). The branch is never deleted: it is the only copy.
 */
export function reclaimSessionWorktreeArgv(owner: SessionWorktreeOwner, branch: string): readonly (readonly string[])[] {
  return [
    ["-C", owner.path, "add", "-A"],
    ["-C", owner.path, "commit", "-m", `chore(session): save leftovers of ${branch}`],
    ["-C", owner.repo, "worktree", "remove", "--force", owner.path],
  ];
}

/** May THIS session reclaim that checkout? Only the one the record names. */
export function ownsSessionWorktree(owner: SessionWorktreeOwner | undefined, sessionId: string | undefined): boolean {
  return !!owner && !!sessionId && owner.sessionId === sessionId;
}

/**
 * Should a `/new` / `/resume` in the same process take the record over? The
 * process that cut the checkout is still the one working in it; without this a
 * `/new` after `declare_done` would leave a checkout nobody may reclaim.
 */
export function shouldAdopt(owner: SessionWorktreeOwner | undefined, sessionId: string | undefined, pid: number): boolean {
  return !!owner && !!sessionId && owner.sessionId !== sessionId && owner.pid === pid;
}

/**
 * Offer the move? Only to a session the exclusivity guard REFUSED (a judge,
 * worker or orchestration child is never refused — it does not claim the
 * repo's sidecar), only with a dialog to ask in, and only once.
 */
export function shouldOfferRelocation(input: { refused: boolean; hasUI: boolean; alreadyOffered: boolean }): boolean {
  return input.refused && input.hasUI && !input.alreadyOffered;
}

export const RELOCATE_YES = "切到独立 worktree 工作";
export const RELOCATE_NO = "不切换，保持现状（门禁不启动）";

export function relocateChoice(repoRoot: string): ChoiceSpec {
  return {
    title:
      `这个仓库（${repoRoot}）已有另一个活着的会话在用门禁。要不要把本会话切到一个独立的 worktree？` +
      `门禁会在 ${gateWorktreeRoot()}/ 下从当前 HEAD 开一条新分支（rg-session-…），带上 .pi 配置 / .env / node_modules，` +
      "然后把本会话原地切进去 —— 与另一个会话互不打扰。本会话 declare_done 或退出时，未提交的改动 commit 到那条分支，目录回收。",
    options: [RELOCATE_YES, RELOCATE_NO],
    recommended: RELOCATE_YES,
  };
}
