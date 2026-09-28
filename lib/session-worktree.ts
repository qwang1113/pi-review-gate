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
 * WHAT "DONE" MEANS THERE (2026-09-28, user decision, second round): the work
 * is back in the MAIN repository in an accepted state. The session must have
 * committed it through the gate like any other round (station floor `commit`),
 * `declare_done` refuses a dirty checkout, and once every gate — acceptance
 * included — has passed, a VERIFIED-BRANCH RECORD is written into the main
 * repo's `.pi/verified-branches.json` (branch, commit, tree). The pre-push
 * hook there recognises that tree (scripts/pre-push-verified.cjs). Only then
 * is the directory removed; the branch stays.
 *
 * NOT DONE: a session that exits without `declare_done` loses its uncommitted
 * work — the directory is removed as it stands. Nothing is ever committed on
 * its behalf, and no hook is ever bypassed.
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

/** The directory only — never a commit, never the branch. */
export function removeSessionWorktreeArgv(owner: SessionWorktreeOwner): readonly string[] {
  return ["-C", owner.repo, "worktree", "remove", "--force", owner.path];
}

// ── the station floor ──

/**
 * Below `commit` nobody could deliver: `precommit` means "the user commits",
 * and the checkout the user would commit in is removed at `declare_done`.
 */
export const RELOCATED_STATION_FLOOR = "commit" as const;

const STATION_ORDER = ["precommit", "commit", "pr"] as const;
type Station = (typeof STATION_ORDER)[number];

export function raiseStationToFloor<S extends Station>(station: S, floor: Station | undefined): S | Station {
  if (floor === undefined) return station;
  return STATION_ORDER.indexOf(station) < STATION_ORDER.indexOf(floor) ? floor : station;
}

export function stationFloorNotice(requested: Station, floor: Station | undefined): string | undefined {
  if (raiseStationToFloor(requested, floor) === requested) return undefined;
  return `⚠️ 独立 worktree 会话的交付站点最低 ${floor}（不是 ${requested}）：目录在 declare_done 时回收，` +
    "改动必须先过门禁 commit 到本会话的分支，否则没有人能再提交它。";
}

// ── the verified-branch record in the MAIN repo ──

export const VERIFIED_BRANCHES_RELPATH = ".pi/verified-branches.json";

export interface VerifiedBranchRecord {
  branch: string;
  commit: string;
  /** The commit's tree — what the pre-push hook matches. */
  tree: string;
  review: "READY";
  /** The acceptance status the round finished with (READY / SKIPPED / DISABLED). */
  acceptance: string;
  sessionId: string;
  at: string;
}

/** Parse the record file; anything unusable is dropped (fail-closed for the hook). */
export function parseVerifiedBranches(raw: string | undefined): VerifiedBranchRecord[] {
  if (raw === undefined) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((r): r is VerifiedBranchRecord =>
      !!r && typeof r === "object" &&
      ["branch", "commit", "tree", "acceptance", "sessionId", "at"].every((k) => typeof (r as Record<string, unknown>)[k] === "string") &&
      (r as Record<string, unknown>).review === "READY");
  } catch {
    return [];
  }
}

/** `/gate-status` lines for the recorded branches (none ⇒ no lines). */
export function formatVerifiedBranches(records: readonly VerifiedBranchRecord[]): string[] {
  if (records.length === 0) return [];
  return [
    "── 已验分支（独立 worktree 会话交付的）──",
    ...records.map((r) => `${r.branch}  ${r.commit.slice(0, 12)}  acceptance=${r.acceptance}  (${r.at})`),
  ];
}

export function isVerifiedTree(records: readonly VerifiedBranchRecord[], tree: string): boolean {
  return !!tree && records.some((r) => r.tree === tree);
}

/** Acceptance outcomes that let a round finish. */
const FINISHED_ACCEPTANCE: ReadonlySet<string> = new Set(["READY", "SKIPPED", "DISABLED"]);

/**
 * May this relocated session finish? `undefined` = yes; otherwise the reason.
 * Called only after every other gate passed, so it judges what is left: the
 * checkout is clean, HEAD is the reviewed content, and acceptance concluded.
 *
 * `reviewTree` is `state.review.fingerprint`, which a READY binds to the
 * REVIEWED COMMIT'S TREE (lib/verdict-host.ts `bindTree`) — the same value
 * `declare_done` already checks against `headCommitTree` (`HEAD^{tree}`,
 * lib/repo-facts.ts). So HEAD's tree is the right thing to compare, and the
 * same tree goes into the record the pre-push hook matches.
 */
export function finishRefusal(f: {
  clean: boolean;
  headTree: string | undefined;
  reviewVerdict: string | undefined;
  reviewTree: string | null | undefined;
  acceptanceStatus: string | undefined;
}): string | undefined {
  if (!f.clean) {
    return "独立 worktree 里还有未提交的改动 —— 先走审查循环（judge_submit）把它们 commit 到本会话的分支，再 declare_done；" +
      "目录一回收，没提交的改动就没了。";
  }
  if (f.reviewVerdict !== "READY" || !f.headTree || f.reviewTree !== f.headTree) {
    return "本会话分支的 HEAD 不是审查 READY 的那份内容 —— 要写回主仓库的必须是验过的内容，先让当前 HEAD 过一轮审查。";
  }
  if (!f.acceptanceStatus || !FINISHED_ACCEPTANCE.has(f.acceptanceStatus)) {
    return `真实验收还没有放行（${f.acceptanceStatus ?? "无记录"}）—— 验收通过后才能把这条分支记为已验。`;
  }
  return undefined;
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
      "然后把本会话原地切进去 —— 与另一个会话互不打扰。完成条件：改动过门禁 commit 到那条分支并通过验收（站点最低 commit），" +
      "declare_done 时门禁把「已验」记录写回主仓库、目录回收；没做完就退出则未提交的改动丢弃。",
    options: [RELOCATE_YES, RELOCATE_NO],
    recommended: RELOCATE_YES,
  };
}
