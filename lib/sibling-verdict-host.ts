/**
 * THE REVIEW RECORDER'S TWO SIBLINGS — the QUALITY round's and the
 * ACCEPTANCE round's recorders, moved out of `extensions/review-gate.ts`
 * (t7, wave 3 of the split). They share the adjudication and the cwd check
 * with `recordReviewVerdict` (lib/verdict-host.ts) and deliberately do NOT
 * share a helper with it: the review recorder's checks are the ship gate's,
 * and a shared helper would let a widening on one side silently widen the
 * other.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AcceptanceStatus } from "./acceptance-round.ts";
import type { ReportConclusion } from "./channel-projection.ts";
import { computeFingerprint } from "./fingerprint.ts";
import { gitText } from "./git-exec.ts";
import { appendTiming } from "./gate-timings.ts";
import { isBlockingSeverity } from "./judge-lifecycle.ts";
import type { LoopStage } from "./loop-stages.ts";
import type { ToolRepoTarget } from "./repo-resolve.ts";
import { canonicalPath } from "./repo-facts.ts";
import { adjudicateReviewConclusion, normalizeConcludedVerdict, type ReviewFinding } from "./review-adjudicate.ts";
import type { ReviewTarget } from "./review-target-host.ts";
import type { Ref, SessionHost } from "./session-host.ts";
import { scopeExemptionOf } from "./verdict-host.ts";

export function createSiblingVerdictRecorders(
  host: SessionHost,
  deps: {
    reviewTargets: Map<string, ReviewTarget>;
    resolveToolRepo(requested?: string): ToolRepoTarget;
    stageIsOn(stage: LoopStage, root?: string): boolean;
    /** When the previous gate event happened (the timing's approximate duration). */
    lastGateEventAt: Ref<number>;
  },
) {
  const { reviewTargets, resolveToolRepo, stageIsOn, lastGateEventAt } = deps;
  const stateForRepo = (root: string) => host.stateFor(root);
  const persistRepo = (ctx: ExtensionContext, root: string) => host.persistRepo(ctx, root);

  /**
   * Record ONE QUALITY round's verdict (2026-09-15, user requirement).
   *
   * A SIBLING OF `recordReviewVerdict`, not a smaller copy of it: the quality
   * round records a STANDING that gates the functional round's dispatch
   * (`lib/quality-round.ts`'s `qualityStandingFor`), while a review round
   * records the ship binding. What they MUST agree on — which commit is being
   * judged, that the judge really ran in this repo, that a READY cannot land
   * on content that moved underneath it — is checked here the same way, and
   * deliberately not factored out: the review recorder's checks are the
   * ship-gate's, and a shared helper would let a widening on one side silently
   * widen the other.
   *
   * THERE IS NO PRECOMMIT BINDING HERE, on purpose. The quality round runs
   * BESIDE the full lane (the user's requirement: verification failing must not
   * interrupt it), so refusing a quality READY for want of a PASS would refuse
   * every quality round that finishes first — which is the normal case.
   */
  async function recordQualityVerdict(
    concluded: ReportConclusion,
    repo: string,
    ctx: unknown,
  ): Promise<string | undefined> {
    const verdictRaw = normalizeConcludedVerdict(concluded.verdict);
    if (!verdictRaw) {
      return "review-gate: 质量轮的 report 里没有可识别的 verdict —— 什么都没有记录（fail-closed）：" +
        "reviewer **不会**被派出去。用 judge_submit({role:\"reviewer\"}) 重新送这一轮。";
    }
    const target = resolveToolRepo(repo);
    if (!target.ok) return target.error;
    const targetRoot = target.root;
    if (!host.repos().inGit) return "review-gate: 非 git 目录 —— 无法记录质量裁决（无仓库可绑定）。";
    const st = stateForRepo(targetRoot);
    delete st.pausedQuestion;
    // ONE adjudication, scope-aware since 2026-09-19 — see `ScopeExemption`.
    const parsed = adjudicateReviewConclusion({
      verdict: verdictRaw,
      findings: concluded.findings as ReviewFinding[],
      ...(concluded.cwd === undefined ? {} : { cwd: concluded.cwd }),
    }, scopeExemptionOf(st));
    // THE SAME TWO BINDINGS A REVIEW GETS, for the same reason — a quality
    // READY unlocks the functional round, so it must be bound to the content
    // it actually judged. No target registered ⇒ the round was never prepared
    // ⇒ nothing to bind to ⇒ withhold (fail-closed).
    const targetNow = reviewTargets.get(targetRoot);
    let stale = false;
    if (!targetNow) {
      stale = true;
    } else {
      try {
        stale = gitText(targetRoot, ["rev-parse", "HEAD"]) !== targetNow.head;
      } catch { stale = true; }
    }
    let cwdMismatch: string | undefined;
    if (parsed.verdict === "READY") {
      const claimed = parsed.cwd;
      if (claimed === undefined || claimed.trim() === "") {
        cwdMismatch = "the verdict carries no `cwd` (a required field: run `pwd` and report it)";
      } else if (canonicalPath(claimed) !== canonicalPath(targetRoot)) {
        cwdMismatch = `the verdict's cwd ${JSON.stringify(claimed)} is not the repo this round was prepared for (${targetRoot})`;
      }
    }
    if (stale || cwdMismatch !== undefined) parsed.verdict = "BLOCKED";
    st.quality = {
      verdict: parsed.verdict,
      // Empty when no target was registered: `qualityStandingFor` compares it
      // with HEAD and only an exact match passes, so an empty string can never
      // unlock the functional reviewer.
      commitSha: targetNow?.head ?? "",
      ...(targetNow?.tree === undefined ? {} : { treeSha: targetNow.tree }),
      at: new Date().toISOString(),
      findingsTotal: parsed.findingsTotal,
    };
    persistRepo(ctx as unknown as ExtensionContext, targetRoot);
    appendTiming(targetRoot, {
      kind: "quality",
      at: new Date().toISOString(),
      repo: targetRoot,
      verdict: parsed.verdict,
      approxMs: Math.max(0, Date.now() - lastGateEventAt.current),
      approximate: true,
      findingsTotal: parsed.findingsTotal,
    });
    lastGateEventAt.current = Date.now();
    return `review-gate: 质量轮记录 ${parsed.verdict} for ${targetRoot}（findings: ${parsed.findingsTotal}）。` +
      (parsed.verdict === "BLOCKED"
        ? " 先把 findings 全部改掉（它们写在 findings 流里，报告里有路径），再 judge_submit 重新送审。" +
          "本轮功能轮如果还在跑，门禁已把它终止（内容要改，它的裁决没有意义）；如果它已经扣了一份 READY 下来，那份 READY 作废。"
        : stageIsOn("review", targetRoot)
        ? " 功能轮本来就在跑（同一个 judge_submit 启动的），你不需要再调一次；" +
          "若它先交卷的 READY 被扣下，这一步就是补记它的时刻。"
        : " 功能审查环节已关闭（用户设定的环节开关）—— 没有 reviewer 在跑，也不需要跑；" +
          "质量结论已记入 sidecar，ship 时按它自己的卡点生效。") +
      (stale
        ? "\nSTALE TARGET：质量轮判的那个 commit 已经不是 HEAD（prepare 之后又落了新 checkpoint）—— " +
          "结论记成 BLOCKED，按上面的方式重新送一轮即可。"
        : "") +
      (cwdMismatch === undefined
        ? ""
        : `\nCWD CHECK FAILED: ${cwdMismatch}。质量裁决需要 judge 自己的 \`pwd\`，与 prepare 的仓库不符时记成 BLOCKED。`);
  }

  /**
   * THE ACCEPTANCE ROUND's recorder — the sixth, beside `recordQualityVerdict`
   * (2026-09-22).
   *
   * WHAT DIFFERS from its siblings: the verdict binds to the WORKTREE
   * FINGERPRINT the gate dispatched the round against, and a mismatch is not a
   * dropped report — it is recorded as BLOCKED, because the judge really did
   * run and really did answer, just about content that is no longer there. The
   * record keeps the DISPATCH's fingerprint when it is stale, so it can never
   * release content the round never ran on: `acceptanceDecision` sees the
   * mismatch and re-dispatches.
   */
  async function recordAcceptanceVerdict(
    concluded: ReportConclusion,
    repo: string,
    ctx: unknown,
  ): Promise<string | undefined> {
    const verdictRaw = normalizeConcludedVerdict(concluded.verdict);
    if (!verdictRaw) {
      return "review-gate: 验收轮的 report 里没有可识别的 verdict —— 什么都没有记录（fail-closed）：" +
        "下一次 `declare_done` 会重新派验收轮。";
    }
    const target = resolveToolRepo(repo);
    if (!target.ok) return target.error;
    const targetRoot = target.root;
    if (!host.repos().inGit) return "review-gate: 非 git 目录 —— 无法记录验收裁决（无仓库可绑定）。";
    const st = stateForRepo(targetRoot);
    delete st.pausedQuestion;
    // ONE adjudication, shared with the review and quality recorders: a READY
    // carrying P0/P1 findings contradicts itself, and the cwd is a required
    // field of the verdict schema.
    const parsed = adjudicateReviewConclusion({
      verdict: verdictRaw,
      findings: concluded.findings as ReviewFinding[],
      ...(concluded.cwd === undefined ? {} : { cwd: concluded.cwd }),
    }, scopeExemptionOf(st));
    const dispatchedFingerprint = st.acceptance?.fingerprint;
    const dispatchedJudgeId = st.acceptance?.judgeId;
    const fp = computeFingerprint(targetRoot);
    const currentFingerprint = fp.unavailable ? "" : fp.digest;
    // NO DISPATCH RECORD IS NOT A PASS: without the fingerprint the round was
    // dispatched against there is nothing to compare, so the verdict cannot
    // release anything (fail-closed — it is recorded as BLOCKED instead).
    const stale = currentFingerprint === "" || dispatchedFingerprint === undefined ||
      dispatchedFingerprint !== currentFingerprint;
    let cwdMismatch: string | undefined;
    if (parsed.verdict === "READY") {
      const claimed = parsed.cwd;
      if (claimed === undefined || claimed.trim() === "") {
        cwdMismatch = "the verdict carries no `cwd` (a required field: run `pwd` and report it)";
      } else if (canonicalPath(claimed) !== canonicalPath(targetRoot)) {
        cwdMismatch = `the verdict's cwd ${JSON.stringify(claimed)} is not the repo this round ran in (${targetRoot})`;
      }
    }
    if (stale || cwdMismatch !== undefined) parsed.verdict = "BLOCKED";
    // The RECORD's status vocabulary is narrower than a verdict's: `NEEDS_HUMAN`
    // is not a state the completion gate knows how to release, so anything that
    // is not READY is recorded as BLOCKED — which is what it does to
    // completion — while `verdict` keeps the judge's own word verbatim.
    const status: AcceptanceStatus = parsed.verdict === "READY" ? "READY" : "BLOCKED";
    const blockingSummary = (concluded.findings as ReviewFinding[])
      .filter((f) => isBlockingSeverity(f.severity))
      .slice(0, 3)
      .map((f) => `${f.severity}${f.file ? ` ${f.file}${f.line === undefined ? "" : `:${f.line}`}` : ""} ${f.issue}`.trim())
      .join("；");
    const at = new Date().toISOString();
    st.acceptance = {
      status,
      verdict: parsed.verdict,
      // THE CONTENT THIS VERDICT BELONGS TO: the dispatch's when the round is
      // stale, the current one when it is fresh.
      ...(stale
        ? (dispatchedFingerprint === undefined ? {} : { fingerprint: dispatchedFingerprint })
        : { fingerprint: currentFingerprint }),
      at,
      ...(dispatchedJudgeId === undefined ? {} : { judgeId: dispatchedJudgeId }),
      findingsTotal: parsed.findingsTotal,
      ...(parsed.verdict === "READY"
        ? {}
        : {
            reason: stale
              ? "本轮验收跑的内容已经不是当前内容（结论在验收期间内容又变了），这份结论作废"
              : blockingSummary || `${parsed.findingsTotal} 条 findings（见验收轮的 report / findings 流）`,
          }),
    };
    persistRepo(ctx as unknown as ExtensionContext, targetRoot);
    appendTiming(targetRoot, {
      kind: "acceptance",
      at,
      repo: targetRoot,
      verdict: parsed.verdict,
      approxMs: Math.max(0, Date.now() - lastGateEventAt.current),
      approximate: true,
      findingsTotal: parsed.findingsTotal,
    });
    lastGateEventAt.current = Date.now();
    return `review-gate: 验收轮记录 ${parsed.verdict} for ${targetRoot}（findings: ${parsed.findingsTotal}）。` +
      (parsed.verdict === "READY"
        ? " 真实验收这一关已过；内容不变的话，再调一次 `declare_done` 就会完成。"
        : " 按 findings 修完再走一遍审查循环（`judge_submit`）；内容一改，这份结论自动失效并重新验收。") +
      (stale
        ? "\nSTALE：验收轮跑的内容与当前内容不同（指纹不匹配）—— 结论记成 BLOCKED（绑定它当初跑的那份内容），" +
          "下一次 `declare_done` 会重新派验收轮。"
        : "") +
      (cwdMismatch === undefined
        ? ""
        : `\nCWD CHECK FAILED: ${cwdMismatch}。验收裁决需要 judge 自己的 \`pwd\`，与派发的仓库不符时记成 BLOCKED。`);
  }

  return { recordQualityVerdict, recordAcceptanceVerdict };
}
