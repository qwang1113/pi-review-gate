/**
 * `prepare_review` — the preparation of ONE code-review round.
 *
 * It lives here rather than in `extensions/review-gate.ts` for the reason this
 * repository now has a rule about (AGENTS.md §"架构规范"): that file is ~8900
 * lines, and it got there one "just add the tool body here" at a time. The
 * orchestration tools moved out first (lib/orchestrator-*-tools.ts), then the
 * judge tools that observe/end a session (lib/judge-session-tools.ts) and the
 * ones that relay to it (lib/judge-relay-tools.ts). This is the same move for
 * the prepare family, and the same shape: `register<Family>Tools(host, deps)`,
 * with every effect the tool needs arriving through an injected `deps` object.
 *
 * THE BOUNDARY: this module prepares a round the REVIEWER will judge — it
 * resolves the immutable `baseline..HEAD` commit range, enforces the polish
 * gate, opens the findings stream and registers the review target a verdict
 * later binds to. The two ADVISORY preparations (`prepare_adviser`,
 * `prepare_goal_audit`) touch no git range and register no target; they are
 * lib/advisory-prepare-tools.ts. Splitting the family this way is also what
 * keeps both files clear of the 600-line hard block on new source files.
 *
 * WHAT IS AND IS NOT INJECTED. The pure decision modules are imported directly
 * (lib/polish-gate.ts for the "does this round deserve a review" rule,
 * lib/review-baseline.ts for the squash-point search, lib/parallel-review.ts
 * for the prompt and the trusted-precommit extraction, lib/review-scope.ts for
 * the directive): they are already testable on their own, and hiding them
 * behind deps would only make the wiring longer. What IS injected is
 * everything the tool cannot own — the repo resolution, gate state and its
 * persistence, the loop-goal readers, the review-target registry, and the
 * three git reads — so every branch in this file can be exercised with a fake
 * instead of a real repository.
 *
 * BEHAVIOR IS FROZEN: this module was moved verbatim out of the extension.
 * The tool name, schema, reply text, `details` fields and error branches are
 * the ones the agent-facing contract already documents; changing any of them
 * is a separate, deliberate change.
 */

import { mkdirSync } from "node:fs";
import { join as pathJoin } from "node:path";

import { Type } from "typebox";

import type { ToolHost, ToolReply } from "./tool-host.ts";
import type { ToolRepoTarget } from "./repo-resolve.ts";
import type { GateState } from "./gate-state.ts";
import type { ReviewScopeDecision, SettledConclusion } from "./review-scope.ts";
import { formatReviewScopeDirective } from "./review-scope.ts";
import { polishReasonRequired } from "./polish-gate.ts";
import { squashPointBaseline, branchBaseBaseline } from "./review-baseline.ts";
import { buildReviewPrompt, extractPrecommitBaseline } from "./parallel-review.ts";
import { computeFingerprint } from "./fingerprint.ts";
import { TASK_TEXT_MARKER } from "./constants.ts";

/**
 * The range under review, as `record_review` will later consume it.
 *
 * A structural subset of the extension's own `ReviewTarget` on purpose: this
 * module must not become the second place that decides what a target IS.
 */
export interface PreparedReviewTarget {
  baseline: string;
  head: string;
  tree: string;
}

/**
 * The three git reads this tool performs.
 *
 * Injected rather than shelled out inline for one measured reason: the
 * baseline resolution is the most intricate branch set in the whole prepare
 * family (last-READY commit → ancestor check → squash point → branch base →
 * checkpoint parent → checkpoint itself), and pinning it used to require
 * building a real repository with a rewritten history. Behind this seam each
 * of those branches is three lines of fake.
 *
 * `squashPointBaseline` / `branchBaseBaseline` are NOT here: they run git
 * themselves and are already pinned by test/review-baseline.test.ts.
 */
export interface ReviewPrepareGit {
  /** Is `maybeAncestor` already contained in `branch`? Never throws. */
  isAncestor(root: string, maybeAncestor: string, branch: string): boolean;
  /** `git rev-parse <rev>`, trimmed. THROWS when the rev cannot be read. */
  revParse(root: string, rev: string): string;
  /** `git diff --name-only <baseline>..<head>`. THROWS when it cannot run. */
  changedFilesInRange(root: string, baseline: string, head: string): string[];
  /** Is the worktree CLEAN (no staged/unstaged/untracked changes)? The
   *  empty-range exit-goal round REQUIRES it — a READY must never bless
   *  content no reviewer saw (round-2 P2). */
  worktreeClean(root: string): boolean;
}

/**
 * Everything this tool needs from the outside world.
 *
 * Deliberately narrow and side-effect-explicit: every method is a thing a test
 * replaces with three lines.
 */
export interface ReviewPrepareToolDeps {
  /** Which repo does this call target? Never guessed — see repo-resolve.ts. */
  resolveRepo(requested: string | undefined): ToolRepoTarget;
  /** The gate state of one repo (the primary repo's state IS the extension's). */
  stateFor(root: string): GateState;
  /** Persist one repo's state (sidecar + blocked-marker handling). */
  persist(ctx: unknown, root: string): void;
  /** The session dir pi is ACTUALLY using, for the reviewer's transcript pointer. */
  sessionDir(ctx: unknown): string;
  /** Has the USER approved this repo's loop goal? */
  goalConfirmed(root: string, st: GateState): boolean;
  /** Goal text handed to spawned reviewers (capped, with a file pointer when truncated). */
  goalTextForReviewers(root: string): { text: string; truncated: boolean } | undefined;
  /** Absolute path of THIS session's loop-goal file, for the truncation pointer. */
  loopGoalPath(root: string): string;
  /** How much of this round the reviewer must deep-read. */
  reviewScope(root: string, st: GateState): ReviewScopeDecision;
  /** Findings the previous round left on the table. */
  previousRoundFindings(st: GateState): string[];
  /** The conclusion the previous round already reached, if any. */
  settledConclusion(st: GateState): SettledConclusion | undefined;
  /** Record the range a verdict will bind to (consumed by `record_review`). */
  registerReviewTarget(root: string, target: PreparedReviewTarget): void;
  /** The git reads, so this module can be tested without a repository. */
  git: ReviewPrepareGit;
  /**
   * Read a UTF-8 file, or undefined when it does not exist / cannot be read.
   *
   * Only the precommit cache is read this way. It is injected for the same
   * reason as the git surface: the trusted-precommit branch is a rule, and a
   * rule pinned against the real filesystem is pinned against the machine.
   */
  readText(path: string): string | undefined;
}

/**
 * The trusted-checks block for the reviewer's task text: what precommit
 * already verified (sidecar verdict + cache steps), so the reviewer does
 * not re-run the full suite.
 *
 * SAFETY (round-9 P1): the baseline is only trusted when the recorded PASS
 * is bound to the CURRENT worktree fingerprint — a PASS for an older tree
 * proves nothing about this change, and claiming it would suppress exactly
 * the verification this round needs. Cache entries recorded AFTER the PASS
 * itself are skipped (they belong to a later tree). Undefined when no
 * matching PASS is on record — the reviewer then decides on its own.
 */
export function precommitBaselineFor(
  root: string,
  st: GateState,
  readText: (path: string) => string | undefined,
): string | undefined {
  let digest: string | undefined;
  try {
    const fp = computeFingerprint(root);
    digest = fp.unavailable ? undefined : fp.digest;
  } catch { digest = undefined; }
  const cacheRaw = readText(pathJoin(root, ".pi", "precommit-cache.json"));
  // The pure decision (fingerprint match + stale-entry filter + wording) is
  // in lib/parallel-review.ts so the safety behavior is testable.
  return extractPrecommitBaseline(st.precommit, digest, cacheRaw);
}

async function doPrepareReview(
  deps: ReviewPrepareToolDeps,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolReply> {
  const target = deps.resolveRepo(typeof params.repo === "string" ? params.repo : undefined);
  if (!target.ok) {
    return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
  }
  const root = target.root;
  const reason = typeof params.reason === "string" ? params.reason : undefined;
  const st = deps.stateFor(root);
  // No checkpoint on record is allowed — the "audit the exit goal" round:
  // nothing is frozen to diff, so prepare resolves an empty range (HEAD..HEAD)
  // and the reviewer judges loop-goal / task completion instead of a diff.
  // A real code round still goes through judge_submit, which commits a
  // checkpoint before this tool runs; baseline falls back to HEAD below.
  // Round-18 polish gate (user ask, B-tier): when the gate is
  // demonstrably met (or a file keeps being polished), the next round
  // must carry an explicit reason. Refuse WITHOUT rendering anything
  // (no dialog, no task text) — the refusal itself tells the agent what
  // to do.
  const polish = polishReasonRequired(st.rounds);
  if (polish.required) {
    const given = (reason ?? "").trim();
    if (!given) {
      return {
        content: [{ type: "text", text:
          `review-gate: prepare_review REFUSED — ${polish.why}。\n` +
          "提供非空 reason 参数后重试（理由会写入 gate state，并出现在下一轮 reviewer 的任务文本里，接受独立审核）。\n" +
          `当前状态：${st.rounds.length} 个已记录 round，最近一轮 verdict=${st.rounds[st.rounds.length - 1]?.verdict ?? "(none)"}。`
        }],
        details: { prepared: false, polishRequired: true, why: polish.why },
        isError: true,
      };
    }
  }
  // Round-8 P1: the baseline is the checkpoint's PARENT (prevSha) — the
  // checkpoint itself is the HEAD under review, so baseline..HEAD is the
  // checkpoint's own commits. Old records without prevSha fall back to
  // `git rev-parse <sha>^`.
  // Round-9 P1 (unreviewed-commit gap): the baseline must be the LAST
  // REVIEWED commit, not the latest checkpoint's parent — two checkpoints
  // since the last READY would otherwise leave the earlier one's content
  // outside every reviewed range while its tree still ships. The READY's
  // commitSha is used when it is an ancestor of HEAD (the normal chain).
  // When it is NOT an ancestor the chain was rewritten (squash/rebase):
  // walk the new chain from the checkpoint's parent to find the SQUASH
  // POINT — the newest commit whose tree equals the reviewed tree — and
  // baseline from there, so the range covers the whole new chain (the
  // squash commit plus every checkpoint after it). No matching tree
  // (a content-changing rebase) falls back to the branch base so the
  // review covers everything.
  const lastReviewed = st.review?.verdict === "READY" ? st.review.commitSha : undefined;
  let baseline: string | undefined;
  if (lastReviewed) {
    // The ancestor test used to be a bare try/catch around `git merge-base
    // --is-ancestor`; behind the seam it is the same question asked as a
    // boolean, and the injected implementation runs the same command.
    if (deps.git.isAncestor(root, lastReviewed, "HEAD")) {
      baseline = lastReviewed;
    } else {
      // Chain rewritten: find the squash point by tree identity (pure
      // logic in lib/review-baseline.ts, pinned by tests — round-12 P2);
      // a clean miss falls back to the branch base, then the checkpoint
      // baseline below.
      baseline = st.checkpoint?.prevSha && st.review.fingerprint
        ? squashPointBaseline(root, st.review.fingerprint, st.checkpoint!.prevSha)
        : undefined;
      if (!baseline) baseline = branchBaseBaseline(root);
    }
  }
  if (!baseline) {
    if (st.checkpoint?.sha) {
      baseline =
        st.checkpoint.prevSha ||
        (() => {
          try {
            return deps.git.revParse(root, `${st.checkpoint!.sha}^`);
          } catch {
            // Round-9 P2 / round-10 Nit: a root commit or an unreachable sha
            // must not throw out of the tool — fall back to the checkpoint
            // sha itself as the baseline (an empty range at worst: the
            // reviewer audits the checkpoint commit alone).
            return st.checkpoint!.sha;
          }
        })();
    } else {
      // No checkpoint on record — the "audit the exit goal" round: nothing
      // is frozen to diff, so the range is empty (HEAD..HEAD) and the
      // reviewer judges the loop goal / task completion instead of a diff.
      baseline = undefined; // resolved below as HEAD when emptyRange
    }
  }
  let head = "";
  let tree = "";
  try {
    head = deps.git.revParse(root, "HEAD");
    tree = deps.git.revParse(root, "HEAD^{tree}");
  } catch (err) {
    return {
      content: [{ type: "text", text: `review-gate: prepare_review failed — cannot read HEAD: ${err instanceof Error ? err.message : String(err)}` }],
      details: { prepared: false },
      isError: true,
    };
  }
  // No checkpoint on record: nothing is frozen to diff, so the round is the
  // "audit the exit goal" kind — HEAD..HEAD (empty), reviewer judges the loop
  // goal / task completion instead of a diff.
  if (baseline === undefined) baseline = head;
  // Empty range (head === baseline): nothing new to diff. This is NOT a
  // refusal anymore — it is the "audit the exit goal" round: the reviewer
  // judges whether the task is DONE (loop goal met, worktree clean) rather
  // than a code diff. The range renders as `head..head` and files stays
  // empty; buildReviewPrompt's empty-range branch words the task.
  const emptyRange = head === baseline;
  // Round-2 P2 (security): an empty-range READY binds to the HEAD tree, and
  // the ship gate compares exactly that tree — so a READY taken with a dirty
  // worktree would mechanically bless content no reviewer saw. The clean-
  // worktree condition therefore lives in the GATE, not only in the prompt.
  if (emptyRange) {
    // Round-2 P2 (security): an empty-range READY binds to the HEAD tree, and
    // the ship gate compares exactly that tree — so a READY taken with a dirty
    // worktree would mechanically bless content no reviewer saw. The clean-
    // worktree condition therefore lives in the GATE, not only in the prompt.
    // A git failure here counts as NOT clean (fail-closed): same rule as the
    // file's other git reads — a probe must never throw out of the tool.
    let clean = false;
    try { clean = deps.git.worktreeClean(root); } catch { /* fail-closed */ }
    if (!clean) {
      return {
        content: [{ type: "text", text: "review-gate: prepare_review refused — the worktree is dirty (or unreadable), so the empty-range exit-goal round cannot bless it. Commit or stash your changes first (judge_submit with a dirty worktree commits a checkpoint and reviews the real diff), then retry." }],
        details: { prepared: false, emptyRange: true, dirtyWorktree: true },
        isError: true,
      };
    }
  }
  const range = `${(emptyRange ? head : baseline).slice(0, 12)}..${head.slice(0, 12)}`;
  let files: string[] = [];
  if (!emptyRange) {
    try {
      files = deps.git.changedFilesInRange(root, baseline, head);
    } catch { /* empty file list is still a valid round */ }
  }
  const runId = `review-${Date.now().toString(36)}`;
  const streamPath = pathJoin(root, ".pi", "review-stream", `${runId}-review.jsonl`);
  try { mkdirSync(pathJoin(streamPath, ".."), { recursive: true }); } catch { /* stream is optional */ }
  const goalSt = deps.stateFor(root);
  const goalForReview = deps.goalConfirmed(root, goalSt) ? deps.goalTextForReviewers(root) : undefined;
  const goalText = goalForReview?.text;
  const goalTruncated = goalForReview?.truncated === true;
  // NOTE: no display title is computed here — judge_submit derives the
  // display title itself, and the session id deterministically from
  // role+repo (that is what makes a role's next round resume its session).
  const scopeNow = deps.reviewScope(root, st);
  // Round-18 polish gate: persist a supplied reason BEFORE building the
  // task, so the reviewer of THIS round sees the reason that authorized it.
  if (polish.required && (reason ?? "").trim()) {
    st.lastPolishReason = {
      reason: (reason ?? "").trim(),
      at: new Date().toISOString(),
      round: st.rounds.length + 1,
    };
    deps.persist(ctx, root);
  }
  const task = buildReviewPrompt(
    "review",
    files,
    goalText,
    root,
    { streamPath, commitRange: range },
    formatReviewScopeDirective(
      scopeNow,
      deps.previousRoundFindings(st),
      deps.settledConclusion(st),
      "reviewer",
    ),
    scopeNow.scope,
    { dir: deps.sessionDir(ctx), id: st.sessionId ?? "unknown" },
    precommitBaselineFor(root, st, deps.readText),
    // Round-18 polish gate: the reason for THIS round travels to the
    // reviewer, who judges whether the round deserves to exist.
    st.lastPolishReason,
  );
  // Register the review target: record_review verifies HEAD is still the
  // reviewed commit and binds a READY to the reviewed tree.
  deps.registerReviewTarget(root, { baseline, head, tree });
  const lines = [
    `review-gate: review round ready — range ${range} (${files.length} file(s)).`,
    `stream=${streamPath}`,
    // R-22 — a bypassed round must be legible to the reviewer: it is
    // judging content the full suite never ran on.
    ...(st.checkpoint?.precommitBypassed
      ? [
          "**本轮的 precommit 被用户的 `/gate-bypass` 覆盖**：全量测试没有在这份内容上跑过。" +
          "reviewer 请据此调整判断（该验证的部分自己验证），declare_done 时这条也会再提醒一次。",
        ]
      : []),

    "ADVANCED / internal：正常路径是一次 judge_submit({ role: \"reviewer\", task: <本轮改动说明> })——",
    "它自己跑 precommit、checkpoint、本 prepare 与派发，并在 judge 进程退出时机械记录 verdict。",
    "本工具只返回上面的审查范围与下面的任务文本；显示用 title 与 session id 都由门禁自行派生（session id 按 role+repo 确定性派生，所以同一 role 的下一轮续用同一会话）。",
    ...(goalTruncated
      ? [
          `- 注意:任务文本中的 loop goal 因长度被截断(>1500 字符);落盘 task 文件时请用 read 读取 ${deps.loopGoalPath(root)} 全文并替换截断部分,确保 reviewer 拿到完整 goal。`,

        ]
      : []),
    "- 等待纪律:子会话审核期间,继续做可实现的确定性工作(注意:第一次 goal 批准前编辑/写工具仍被门禁拦截,属预期);确认没有可做的工作后才阻塞等待审核结果。",
    "",
    TASK_TEXT_MARKER,
    task,
    "",
    "The reviewer judges the COMMIT RANGE (immutable): you may keep fixing the worktree while it ",
    "works. record_review re-checks that HEAD is still the reviewed commit; a new checkpoint ",
    "after this prepare ⇒ STALE ⇒ BLOCKED.",
  ];
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      prepared: true,
      baseline,
      head,
      range,
      fileCount: files.length,
      stream: streamPath,
      files,
    },
  };
}

/** Register `prepare_review`. */
export function registerReviewPrepareTools(host: ToolHost, deps: ReviewPrepareToolDeps): void {
  host.registerTool({
    name: "prepare_review",
    label: "Prepare Review",
    description:
      "ADVANCED / internal: `judge_submit({role:\"reviewer\"})` runs this itself as step 3 of the " +
      "submission chain — call it directly only to inspect the range and the task text without " +
      "dispatching anyone. " +
      "Computes the review unit (checkpoint baseline..HEAD), writes the findings-stream path and " +
      "hands back the ready-made task text for the ONE reviewer of this round. One reviewer, one " +
      "commit range: no split — everything the reviewer judges is the whole change in " +
      "baseline..HEAD, which is defined by the last checkpoint sha.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({
        description: "Absolute repo path (required once the session edited several repos)",
      })),
      reason: Type.Optional(Type.String({
        description: "REQUIRED when the polish gate is armed (consecutive READY rounds or the same file in P2/Nit for 3 rounds): why is THIS round worth a review while the gate is already met? Persisted and shown to the next reviewer.",
      })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => doPrepareReview(deps, params, ctx),
  });
}
