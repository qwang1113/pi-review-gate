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
import type { ReviewScopeDecision } from "./review-scope.ts";
// The contract's wording (and the SettledConclusion it carries) has ONE home.
import { formatReviewScopeDirective, type SettledConclusion } from "./review-carryover.ts";
import { polishReasonRequired } from "./polish-gate.ts";
import { buildQualityAuditTask, QUALITY_RULES_RELPATH } from "./quality-round.ts";
import { buildReviewPrompt, changeRowsLargestFirst, extractPrecommitBaseline, formatChangeIndex, type ChangeIndexRow } from "./parallel-review.ts";
import { computeFingerprint } from "./fingerprint.ts";
import { TASK_TEXT_MARKER } from "./constants.ts";

/**
 * The range under review, as the gate's verdict recorder will later consume it.
 *
 * A structural subset of the extension's own `ReviewTarget` on purpose: this
 * module must not become the second place that decides what a target IS.
 */
export interface PreparedReviewTarget {
  baseline: string;
  head: string;
  tree: string;
  /**
   * WHAT THE GATE IS DISPATCHING, recorded at the moment it dispatches it:
   * the round's range as the task text states it, and the full/incremental
   * decision this round was prepared under.
   *
   * Registered here rather than recomputed when the verdict lands, because
   * the decision is a function of the worktree and the worktree keeps moving
   * while the reviewer works — recomputing it later would record a decision
   * this round never ran under. It is the gate's half of the audit pair in
   * `RoundRecord.scope` (lib/gate-state.ts).
   */
  scope?: { range?: string; kind?: "full" | "incremental" };
  /**
   * The files this round changed, straight off the same `numstat` the change
   * index was built from.
   *
   * They ride the target because the QUALITY PRECONDITION is evaluated at
   * DISPATCH time (`lib/quality-round.ts`): "does this round carry code?" is
   * what decides whether a quality round is required, and re-running
   * `git diff` to answer it would be a second read of the same range — one
   * that can disagree with the range the round was prepared under.
   */
  files?: readonly string[];
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
 * THE TWO HISTORY PROBES ARE IN THE SEAM TOO (2026-09-15). `squashPointBaseline`
 * and `branchBaseBaseline` do run git themselves, and each is pinned on its own
 * by test/review-baseline.test.ts — but the BRANCHES that consult them ("chain
 * rewritten", "no checkpoint on record") are decisions of THIS module, and a
 * decision that can only be exercised against a real repository is a decision
 * nobody pins. Every call site in this file goes through the seam; the
 * standalone tests keep pinning the probes themselves.
 */
export interface ReviewPrepareGit {
  /** Is `maybeAncestor` already contained in `branch`? Never throws. */
  isAncestor(root: string, maybeAncestor: string, branch: string): boolean;
  /** `git rev-parse <rev>`, trimmed. THROWS when the rev cannot be read. */
  revParse(root: string, rev: string): string;
  /** `git diff --name-only <baseline>..<head>`. THROWS when it cannot run. */
  changedFilesInRange(root: string, baseline: string, head: string): string[];
  /**
   * `git diff --numstat <baseline>..<head>` — what moved, per file.
   * THROWS when it cannot run (the caller falls back to the name list).
   *
   * Preferred over `changedFilesInRange` because it answers BOTH questions in
   * one call: the file list, and the sizes the reviewer's read plan is built
   * from (lib/parallel-review.ts's `formatChangeIndex`).
   */
  numstatInRange(root: string, baseline: string, head: string): ChangeIndexRow[];
  /**
   * The commit every commit of this branch sits on top of — `git merge-base
   * <default branch> HEAD` (lib/review-baseline.ts). Undefined when the repo
   * names no default branch at all (no remote, no main/master): there is then
   * no base to compare against, and the caller keeps its empty range.
   */
  branchBaseBaseline(root: string): string | undefined;
  /**
   * The SQUASH POINT — the newest commit in `startSha`'s parent chain whose
   * tree equals `reviewedTree`, i.e. where a rewritten chain still holds the
   * content a READY was bound to (lib/review-baseline.ts). Undefined on a
   * clean miss, which sends the caller to the branch base.
   */
  squashPointBaseline(root: string, reviewedTree: string, startSha: string): string | undefined;
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
  /**
   * Record the range a verdict will bind to (consumed by the verdict recorder),
   * and RETIRE any parked READY from the previous round (2026-09-15).
   *
   * The ctx travels with it because retiring one is a WRITE: a parked
   * conclusion belongs to the round that dispatched it, and a new dispatch
   * makes it history — leaving it in the sidecar would let a later PASS on that
   * old tree replay a verdict the session has already moved past.
   */
  registerReviewTarget(root: string, target: PreparedReviewTarget, ctx: unknown): void;
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
  // No checkpoint on record is allowed, and it does NOT by itself mean an
  // empty range: since 2026-09-15 the baseline falls back to the branch base
  // (see below), so a session that never checkpointed still reviews what its
  // branch carries. Only a range that is genuinely empty makes this the
  // loop-goal / task-completion round. A real code round goes through
  // judge_submit, which commits a checkpoint before this tool runs.
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
  // Round-9 P1 (unreviewed-commit gap): the baseline must be the last commit
  // a round CONCLUDED about, never the latest checkpoint's parent — two
  // checkpoints since the last READY would otherwise leave the earlier one's
  // content outside every reviewed range while its tree still ships.
  // Round-10 P1 (2026-09-16): "the last round that concluded" means READY **or
  // BLOCKED**, and the checkpoint fallback below is gone. While only a READY
  // was recorded, a round that produced NO conclusion at all — a re-submit
  // that interrupted it, a precommit FAIL before it concluded, a crash — left
  // the checkpoint's parent to be the baseline, which moved PAST its content:
  // measured that day, a whole round's changes (d28714e..a70f2a1) dropped out
  // of every later range while the gate went on believing the chain was
  // reviewed. No conclusion for this branch at all ⇒ baseline from the BRANCH
  // BASE, i.e. the whole branch.
  // The concluded commit is used when it is an ancestor of HEAD (the normal
  // chain). When it is NOT an ancestor the chain was rewritten (squash/rebase):
  // walk the new chain from the checkpoint's parent to find the SQUASH
  // POINT — the newest commit whose tree equals the reviewed tree — and
  // baseline from there, so the range covers the whole new chain (the
  // squash commit plus every checkpoint after it). No matching tree
  // (a content-changing rebase) falls back to the branch base so the
  // review covers everything.
  // THE COMMIT SURVIVES AN INVALIDATION (round-1 review P2, 2026-09-16):
  // `invalidateBindings` flips the VERDICT back to PENDING on the next edit
  // and deliberately leaves `commitSha` in place — the commit a round
  // concluded about does not stop existing when the worktree moves on. Reading
  // the verdict here threw that away and re-based the range on the BRANCH
  // BASE, i.e. re-reviewing the WHOLE branch after every post-READY edit — the
  // loop's most expensive step, on the branch that just passed. A missing
  // `commitSha` is the only thing that means "nothing was ever concluded here".
  const lastConcluded = st.review.commitSha;
  let baseline: string | undefined;
  if (lastConcluded) {
    // The ancestor test used to be a bare try/catch around `git merge-base
    // --is-ancestor`; behind the seam it is the same question asked as a
    // boolean, and the injected implementation runs the same command.
    if (deps.git.isAncestor(root, lastConcluded, "HEAD")) {
      baseline = lastConcluded;
    } else {
      // Chain rewritten: find the squash point by tree identity (pure
      // logic in lib/review-baseline.ts, pinned by tests — round-12 P2).
      // A clean miss leaves `baseline` unset on purpose: the block below is
      // the ONE place that decides what an unset baseline falls back to. It
      // used to call `branchBaseBaseline` again here as well, which was a
      // second fork of the same rule (and a second `git merge-base` when the
      // first answer was empty) — round-2 quality P2, 2026-09-16.
      baseline = st.checkpoint?.prevSha && st.review.fingerprint
        ? deps.git.squashPointBaseline(root, st.review.fingerprint, st.checkpoint!.prevSha)
        : undefined;
    }
  }
  if (!baseline) {
    // NO CONCLUSION IS NOT "NO CONTENT" (2026-09-15) — and, since 2026-09-16,
    // it is also not "the previous checkpoint was reviewed". A checkpoint is
    // this SESSION's freeze; a session that has not concluded anything about
    // this branch still has whatever the branch carries: content committed by
    // someone else, by the agent's own `git commit`, or by a round whose
    // conclusion never arrived. Reading the absence of a conclusion as "there
    // is nothing earlier to audit" made the reviewer's task text assert a fact
    // the gate had never checked (measured then: a 18-file, +2260/-79 delivery
    // announced as "There is NO code change to audit"; measured again today: a
    // whole round silently outside every range).
    //
    // So ask git instead: the branch base covers every commit of this branch,
    // whenever it was made.
    //
    // AND WHEN GIT CANNOT NAME ONE (2026-09-16): a repository with no remote,
    // no `main` and no `master` — the shape every sandbox has, and a real
    // shape for a local-only repo — used to leave the range EMPTY, and an
    // empty range is a round that demands a clean worktree and then blesses
    // nothing. There the checkpoint's own parent is the last thing that can
    // still say "this content was here before this round": too little
    // coverage is the failure this rule exists to prevent, but NO coverage is
    // the harder failure. Undefined stays the genuinely-unknown case (neither
    // a branch base nor a checkpoint to fall back to) and keeps the old
    // empty-range exit-goal round.
    baseline = deps.git.branchBaseBaseline(root);
    // `st.checkpoint?.sha`, NOT `st.checkpoint` (round-2 quality P2,
    // 2026-09-16): `sha` is parsed with no validation, so a record carrying an
    // EMPTY one would take the IIFE below into `revParse("^")`, throw, and
    // return "" — a baseline that is not `undefined`, so it survives both the
    // `baseline === undefined` default below and the empty-range judgement,
    // and the range becomes `""..HEAD`.
    if (!baseline && st.checkpoint?.sha) {
      baseline = st.checkpoint.prevSha || (() => {
        try {
          return deps.git.revParse(root, `${st.checkpoint!.sha}^`);
        } catch {
          // Round-9 P2 / round-10 Nit: a root commit or an unreachable sha
          // must not throw out of the tool — the checkpoint itself is the
          // baseline (an empty range at worst: the reviewer audits the
          // checkpoint commit alone).
          return st.checkpoint!.sha;
        }
      })();
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
  // Nothing resolved a baseline: no checkpoint record AND no branch base to
  // compare against (or the branch sits exactly on its base). Only now is the
  // round the empty-range "audit the exit goal" kind — HEAD..HEAD, the
  // reviewer judges the loop goal / task completion instead of a diff.
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
  let changeIndex: string | undefined;
  if (!emptyRange) {
    // ONE git call answers both questions: which files moved, and how much.
    // The name-only read stays as the fallback — a range whose numstat cannot
    // be read (an unreadable object, a git that refuses) still gets a round.
    try {
      // Same order the index renders in, so the round's `files` list and the
      // batch plan cannot disagree about it.
      const rows = changeRowsLargestFirst(deps.git.numstatInRange(root, baseline, head));
      files = rows.map((r) => r.file);
      changeIndex = formatChangeIndex(rows, range);
    } catch {
      try {
        files = deps.git.changedFilesInRange(root, baseline, head);
      } catch { /* empty file list is still a valid round */ }
    }
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
  const qualityStreamPath = pathJoin(root, ".pi", "review-stream", `${runId}-quality.jsonl`);
  try { mkdirSync(pathJoin(qualityStreamPath, ".."), { recursive: true }); } catch { /* stream is optional */ }
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
    changeIndex,
  );
  // Register the review target: the verdict recorder verifies HEAD is still the
  // reviewed commit and binds a READY to the reviewed tree. The scope travels
  // with it so the recorder can write down what this round was DISPATCHED to
  // review beside what the judge reports it reviewed (auditability, not a
  // rule: nothing refuses a verdict over a mismatch).
  deps.registerReviewTarget(root, { baseline, head, tree, scope: { range, kind: scopeNow.scope }, files }, ctx);
  // THE QUALITY ROUND'S BRIEF — built HERE, in the same pass, because every
  // value it needs (the range, the file list, the pre-computed change index,
  // the transcript pointer) is already in hand. Rebuilding it in the caller
  // would mean a second `numstat` for the same round (round-4 P2: one range,
  // read once). The task is NOT dispatched here — the chain decides whether a
  // quality round runs at all (a docs-only round skips it), and that decision
  // belongs to the one routing rule in lib/quality-round.ts.
  const qualityTask = buildQualityAuditTask({
    range,
    files,
    streamPath: qualityStreamPath,
    ...(changeIndex === undefined ? {} : { changeIndex }),
    rulesPath: pathJoin(root, QUALITY_RULES_RELPATH),
    session: { dir: deps.sessionDir(ctx), id: st.sessionId ?? "unknown" },
  });
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
    "它自己跑 precommit、checkpoint、本 prepare 与派发，judge 在 pane 里调 judge_conclude 交卷后门禁落 channel report 并机械记录 verdict。",
    "本工具只返回上面的审查范围与下面的任务文本；显示用 title 与 session id 都由门禁自行派生（session id 按 role+repo+opener 确定性派生，所以同一 opener 同一 role 的下一轮续用同一会话）。",
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
    "works. The gate re-checks that HEAD is still the reviewed commit when it records your ",
    "verdict; a new checkpoint ",
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
      // The quality round's half of the same round: its task text and its own
      // findings stream. `judge_submit` picks whichever of the two its routing
      // rule selected; nothing else reads these.
      qualityTask,
      qualityStream: qualityStreamPath,
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
