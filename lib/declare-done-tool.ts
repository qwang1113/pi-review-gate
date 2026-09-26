/**
 * `declare_done` — completion re-runs every gate server-side and then closes
 * what this session opened. Moved out of `extensions/review-gate.ts` (t8,
 * wave 4 of the split).
 *
 * The work stays on the branch it was done on — no gate merge (2026-09-07,
 * user decision); merging/rebasing/pushing is the user's own git workflow.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { acceptanceRoundInFlight } from "./acceptance-round.ts";
import type { createAcceptanceHost } from "./acceptance-host.ts";
import { prEvidencePresent, stationArrivalProblems, type DeliveryStation } from "./delivery-station.ts";
import type { GateState } from "./gate-state.ts";
import { unmetRequirements } from "./gate-state-requirements.ts";
import { removeJudge, tmuxServerFrom, windowClosable } from "./hierarchy.ts";
import type { JudgeRegistry } from "./judge-registry-host.ts";
import { LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK } from "./loop-goal.ts";
import type { TmuxRunner } from "./orchestrator-tmux.ts";
import { createProgressReporter, type ToolUpdate } from "./progress-stream.ts";
import { buildRejection } from "./rejection-copy.ts";
import { headCommitTree, unreviewedTreesSince } from "./repo-facts.ts";
import { resetLoopBudget, type SessionCells } from "./session-cells.ts";
import { closeSessionWindow } from "./session-factory.ts";
import { readInheritance } from "./session-inheritance.ts";
import { successorDoneRefusal } from "./session-handoff.ts";
import { existsSync, readFileSync } from "node:fs";
import { closeOwnSession, type TmuxScope } from "./session-tmux-scope.ts";
import { hasUnpushedCommits, probeOpenPr, type OpenPrArrival } from "./station-pr-evidence.ts";
import { isEnforcedMode } from "./task-mode.ts";
import type { ToolHost } from "./tool-host.ts";
import { describeNotifyOutcome, type UserNotifyKind, type UserNotifyOutcome } from "./user-notify.ts";
import { formatProxyDecisionReport, sessionProxyDecisions } from "./user-proxy.ts";
import { changedFiles } from "./worktree-changes.ts";
import type { createDialogProxy } from "./dialog-proxy.ts";

export interface DeclareDoneToolDeps {
  enforcementStateFor(root: string): GateState | undefined;
  stateForRepo(root: string): GateState;
  persistRepo(ctx: ExtensionContext, root: string): void;
  persist(ctx?: ExtensionContext): void;
  repoLabel(root: string): string;
  repoDirFor(root: string): string;
  copilotProblemsAcrossRepos(): string[];
  goalStageSatisfied(): boolean;
  deliveryStationFor(root: string): DeliveryStation | undefined;
  orchestrationDoneProblems(): string[];
  resetOrchestratorContinuations(): void;
  registry: Pick<JudgeRegistry, "ownJudges" | "judgeHierarchy" | "setHierarchy" | "dropAudits">;
  reapReviewScratch(judgeId: string): void;
  armAcceptanceRound: ReturnType<typeof createAcceptanceHost>["armAcceptanceRound"];
  runTmux: TmuxRunner;
  tmuxScope: TmuxScope;
  raiseBanner(opts: { kind: UserNotifyKind; detail: string; blocking?: boolean }): UserNotifyOutcome;
  releaseSessionName(): { released: boolean; error?: string };
  proxyDecisions(): ReturnType<ReturnType<typeof createDialogProxy>["all"]>;
}

export function registerDeclareDoneTool(host: ToolHost, cells: SessionCells, deps: DeclareDoneToolDeps): void {
  // This module's own once-flag (lib/session-cells.ts: single-owner state stays
  // private). Not persisted — a restart refusing once more is the safe side.
  let successorChecked = false;
  host.registerTool({
    name: "declare_done",
    label: "Declare Done",
    description:
      "Declare the current task complete. Re-validates every gate server-side. " +
      "The work stays on the branch it was done on — no gate merge (2026-09-07, user decision); " +
      "merging/rebasing/pushing is the user's own git workflow.",
    parameters: Type.Object({
      summary: Type.String({ description: "One-paragraph completion summary" }),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const summary = params.summary as string;
      // Completion re-runs every gate — minutes of work in the worst case.
      // One step per phase.
      const progress = createProgressReporter({
        title: "review-gate: declare_done",
        onUpdate: onUpdate as ToolUpdate | undefined,
      });
      progress.step("门禁复检");
      // NON-GIT SHORT-CIRCUIT (2026-09-02, user decision): outside a git
      // repository there is nothing the gate could have reviewed or
      // precommitted — declare_done has no gate to re-run.
      if (!cells.sessionInGit) {
        progress.step("完成");
        return {
          content: [{ type: "text", text: "review-gate: 非 git 目录 —— 门禁不介入，declare_done 直接完成（无仓库可审查/提交）。" }],
          details: { ok: true, nonGit: true },
        };
      }
      const state = cells.state;
      // A SUCCESSOR CHECKS ITS PREDECESSOR'S LAST USER MESSAGES FIRST (2026-09-26).
      // Enforced modes only: explore/normal completions are advisory in this file.
      if (isEnforcedMode(state.taskMode)) {
        const inherited = readInheritance();
        const docPath = inherited.handoffDoc;
        let doc: string | undefined;
        try { doc = docPath && existsSync(docPath) ? readFileSync(docPath, "utf8") : undefined; } catch { doc = undefined; }
        const refusal = successorDoneRefusal({
          isSuccessor: docPath !== undefined,
          checked: successorChecked,
          ...(docPath === undefined ? {} : { docPath }),
          ...(doc === undefined ? {} : { doc }),
        });
        if (refusal) {
          successorChecked = true;
          progress.fail("接任者核对");
          return { content: [{ type: "text", text: refusal }], details: { accepted: false, successorCheck: true }, isError: true };
        }
      }
      const primaryRepoRoot = cells.primaryRepoRoot;
      // R-30 — THE ORCHESTRATOR'S EXIT CONTRACT IS THE PLAN, and it is the
      // ONE the status tool already reports. Measured on 2026-08-30: with
      // every task done, no live children and no open decisions,
      // `orchestrator_status` said "没有了，可以 declare_done" while
      // declare_done rejected with "code review gate is PENDING / precommit
      // has not run" — criteria a project manager can never satisfy, because
      // constraint 2 forbids it from writing the code a review would judge.
      // Two answers to one question is a bug wherever it appears; here it was
      // a functional deadlock, so both callers now run the same function.
      const orchestratorMode = state.taskMode === "orchestrator";
      // P-multi: completion requires EVERY repo this session has edited to
      // pass its own review + precommit.
      const problems: string[] = [];
      if (orchestratorMode) {
        // WHAT THIS DELIBERATELY DOES NOT CHECK (round-1 Nit): unreviewed
        // changes a serial child left in the shared worktree. A supervisor
        // writes no code (constraint 2) and every ship still goes through the
        // SESSION that made the change, with its own review and precommit.
        problems.push(...deps.orchestrationDoneProblems());
      } else {
        for (const root of cells.sessionRepos) {
          const st = deps.enforcementStateFor(root);
          if (st) {
            // `requireFullTests`: declaring the task done means the work is
            // about to be published, and the fast lane never proved the suite
            // passes — the agent cannot finish on a narrowed check.
            for (const p of unmetRequirements(st, headCommitTree(root), false, {
              requireDocSync: cells.projectConfig.docSync,
              requireFullTests: true,
              unreviewedCommits: unreviewedTreesSince(root, st.review),
            })) {
              problems.push(root === primaryRepoRoot ? p : `[${deps.repoLabel(root)}] ${p}`);
            }
          } else {
            // An edited repo always has a state (edit hook initializes it);
            // this is defense against future drift. Fail-closed.
            problems.push(`[${deps.repoLabel(root)}] gate state missing (fail-closed)`);
          }
        }
      }

      // Owned judge panes cascade-close HERE (hierarchy design): finished ones
      // are reclaimed, running ones are abandoned — an unrecorded round never
      // enters the review chain. In loop/orchestrator mode this runs for real;
      // explore/normal only report it as advisory.
      //
      // `ownJudges()` and NOT `ownLiveJudges()`: a dead pane still leaves a
      // registry entry, a scratch worktree and (for an auditor) a pending audit
      // to reclaim. The opener filter keeps it off a PEER's review.
      //
      // AN IN-FLIGHT ACCEPTANCE ROUND IS NOT ABANDONED HERE (reviewer P1,
      // 2026-09-22): this tool dispatched it and told the agent to WAIT, so a
      // second `declare_done` must reach `acceptanceDecision`'s AWAITING branch
      // instead of dispatching a second round on top of a working judge. ONLY
      // that role, and ONLY while its own record says AWAITING.
      const { registry } = deps;
      const ownedJudges = registry.ownJudges().filter((child) =>
        !(child.role === "acceptance" && acceptanceRoundInFlight(deps.stateForRepo(child.repoRoot).acceptance)),
      );
      if (ownedJudges.length > 0 && isEnforcedMode(state.taskMode)) {
        const run = (argv: readonly string[]) => deps.runTmux(argv);
        const closed: string[] = [];
        const tmuxServer = tmuxServerFrom(process.env);
        for (const child of ownedJudges) {
          // `windowClosable`, not just "has a window id": a persisted id from a
          // tmux server that has since restarted names whatever now holds that
          // number, and this is a kill (2026-09-05, adviser P1).
          if (windowClosable(child, tmuxServer)) {
            try {
              // The target is `<session>:<@window>` from the entry itself, so a
              // leftover id can only reach a window of THIS session's own tmux
              // session — never one the user owns.
              if (closeSessionWindow(run, { ownSession: child.tmuxSession, windowId: child.windowId }).ok) {
                closed.push(child.windowId);
              }
            } catch { /* best effort */ }
          }
          try { deps.reapReviewScratch(child.judgeId); } catch { /* best effort */ }
          registry.setHierarchy(removeJudge(registry.judgeHierarchy(), child.judgeId));
          if (child.role === "goal-auditor") registry.dropAudits(child.repoRoot);
        }
        progress.step(`联关 ${ownedJudges.length} 个 review window${closed.length ? `（已关 ${closed.join("、")}）` : ""}`);
      } else if (ownedJudges.length > 0) {
        for (const child of ownedJudges) {
          problems.push(`[${deps.repoLabel(child.repoRoot)}] judge window ${child.windowId ?? "(无 window)"} (${child.role}) 仍开着——explore/normal 下仅提醒，不代关。`);
        }
      }
      // L7/L8 — completion-only requirements. Neither is in
      // unmetRequirements(): the Copilot loop needs commits to make progress
      // (gating ships on it would deadlock it), and the goal approval is a
      // dialog fact the git hooks cannot see.
      const completionProblems: string[] = [];
      if (!orchestratorMode) {
        completionProblems.push(...deps.copilotProblemsAcrossRepos());
        if (isEnforcedMode(state.taskMode) && !deps.goalStageSatisfied()) {
          completionProblems.push(LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
        }
        // DID THIS ROUND ARRIVE AT ITS STATION (2026-09-06)? LOOP MODE ONLY —
        // the reason an orchestrator is not judged here is written on
        // `orchestrationDoneProblems`. Every fact is the gate's OWN; the GitHub
        // question runs ONLY when the free local facts cannot prove arrival.
        // PER REPO, not once for the session (round-1 reviewer P2).
        if (isEnforcedMode(state.taskMode) && deps.goalStageSatisfied()) {
          for (const root of cells.sessionRepos) {
            const station = deps.deliveryStationFor(root);
            if (station === undefined) continue; // no contract for that repo
            const st = root === primaryRepoRoot ? state : deps.stateForRepo(root);
            // UNVERIFIABLE counts as dirty: "I could not read the worktree"
            // is not evidence that the work was committed.
            const files = changedFiles(root);
            const observedPrCreate = st.shippedKinds?.includes("pr-create") === true;
            const recordedPr = typeof st.copilot?.pr === "number" ? st.copilot.pr : null;
            let probe: OpenPrArrival | null = null;
            let unpushed = false;
            if (station === "pr") {
              // ASK GITHUB ONLY WHEN THE FREE EVIDENCE IS SILENT (round-1 quality P1).
              if (!prEvidencePresent({ observedPrCreate, recordedPr })) {
                // Named in the progress line: this one can take seconds.
                progress.step(`查询 PR 状态（${deps.repoLabel(root)}）`);
                probe = await probeOpenPr(deps.repoDirFor(root));
              }
              // …but HAVING a PR is not arriving: work still sitting locally
              // has not been delivered. Pure local git, no network.
              unpushed = hasUnpushedCommits(deps.repoDirFor(root));
            }
            const arrival = stationArrivalProblems(station, {
              dirty: files === undefined || files.length > 0,
              observedPrCreate,
              recordedPr,
              openPr: probe?.number ?? null,
              unpushed,
            });
            for (const p of arrival) {
              completionProblems.push(root === primaryRepoRoot ? p : `[${deps.repoLabel(root)}] ${p}`);
            }
          }
        }

        // Orchestration exit contract (constraints 3, 4, 10, 11): the question
        // is whether the WHOLE job is finished.
        completionProblems.push(...deps.orchestrationDoneProblems());
      }
      problems.push(...completionProblems);

      if (state.taskMode === "explore" || state.taskMode === "normal") {
        // Explore's defining behavior: the agent may end the task on its own
        // judgment. Gate status is reported as advisory only.
        cells.loopArmed = false;
        deps.persist(ctx as unknown as ExtensionContext);
        return {
          content: [{
            type: "text",
            text: (state.taskMode === "normal"
              ? `review-gate: normal mode — completion accepted without gates. ${summary}`
              : `review-gate: explore task completed by AI judgment. ${summary}` +
                (problems.length ? "\nAdvisory gate status:\n" + problems.map((p) => `  - ${p}`).join("\n") : "")),
          }],
          details: { accepted: true, advisoryProblems: problems },
        };
      }
      if (problems.length > 0) {
        progress.fail(`${problems.length} 项未满足`);
        const staleReady = problems.some((p) => p.includes("modified after the last READY"));
        return {
          content: [{
            type: "text",
            text: buildRejection({
              what: `declare_done 被拒 —— ${problems.length} 项门禁未满足`,
              why: "下面是门禁**重新核对**出的未满足项（服务端复检，不看你的 summary）：\n" +
                problems.map((p) => `  - ${p}`).join("\n"),
              by: "agent",
              next: (orchestratorMode
                // R-30: an orchestrator has no review of its own to run.
                ? "把上面这些做完再退出（这就是 `orchestrator_wait` 回执第 5 块「还差什么」，两处用的是同一个判据函数）。"
                : "跑完审查循环再试：按 findings 修 → `judge_submit({role:\"reviewer\"})` → READY → 再调 `declare_done`。") +
                (staleReady
                  ? "\n注意：READY 之后的任何代码或文档编辑都会让它失效（handoff / 设计 / plan 文档也算）。" +
                    "把所有编辑（含文档）全部做完，再把最后一轮 review + precommit 当作 declare_done 之前的最后两步。"
                  : ""),
            }),
          }],
          details: { accepted: false, problems },
          isError: true,
        };
      }
      // ── L9 — THE REAL-ACCEPTANCE ROUND (2026-09-22, user decision) ──
      //
      // The gate's OWN dispatch, at completion: the agent has no tool that
      // starts this round and deliberately never will. It runs AFTER every
      // other gate is satisfied. LOOP SEMANTICS ONLY, never an orchestrator —
      // and UNDECIDED COUNTS AS THE LOOP (real-session P1): `isEnforcedMode`
      // is the ONE answer to “does this session run the loop's semantics?”.
      const acceptanceNotes: string[] = [];
      if (isEnforcedMode(state.taskMode) && !orchestratorMode) {
        progress.step("真实验收");
        const acceptance = await deps.armAcceptanceRound(ctx, progress, acceptanceNotes);
        if (acceptance) return acceptance;
      }
      progress.done("全部满足");
      cells.loopArmed = false;
      // R3-5 — RECORD THE COMPLETION, in this session's own sidecar. This one
      // write is what the `done` state is judged from
      // (lib/orchestrator-child-state.ts), so it happens BEFORE the loop
      // bookkeeping below and is never cleared by it.
      state.completion = {
        at: new Date().toISOString(),
        merge: "none", // no landing step anymore (2026-09-07)
        ...(String(summary ?? "").trim()
          ? { summary: String(summary).trim().slice(0, 500) }
          : {}),
      };
      // A completed unit of work closes its review loop — for EVERY repo this
      // session edited (P-multi). This only clears already-satisfied history:
      // the next code edit re-arms hasCodeChange, so it cannot loosen the gate.
      for (const root of cells.sessionRepos) {
        const st = root === primaryRepoRoot ? state : deps.stateForRepo(root);
        st.rounds = [];
        st.lastPolishReason = undefined;
        st.strategicResetFired = false;
        // The delivery-station EVIDENCE is per TASK too (round-2 reviewer P2).
        st.shippedKinds = undefined;
        if (root !== primaryRepoRoot) deps.persistRepo(ctx as unknown as ExtensionContext, root);
      }
      state.rounds = [];
      state.lastPolishReason = undefined;
      state.strategicResetFired = false;
      state.shippedKinds = undefined;

      // P1 fix: the L2 auto-continuation budget must reset with the task too —
      // task B in the same session would otherwise get ZERO continuations.
      resetLoopBudget(cells);
      deps.resetOrchestratorContinuations(); // goal 6 — reset with the loop budget
      deps.persist(ctx as unknown as ExtensionContext);
      // KIND ONE of three (lib/user-notify.ts): the round's exit contract was
      // met. Raised on the accepted path only.
      const notified = deps.raiseBanner({ kind: "finished", detail: String(summary ?? "") });
      // ── CLOSE MY OWN TMUX SESSION (2026-09-25) ── gated on the ownership
      // marker; a failure is REPORTED, never blocking. ENFORCED MODES ONLY
      // (explore/normal returned above and leave their children running).
      const sessionClose = closeOwnSession((argv) => deps.runTmux(argv), deps.tmuxScope);
      // ── AND THE NAME GOES BACK WITH IT (t2, 2026-09-25) ── reported, never
      // blocking; lib/session-registry.ts's sweep is the backstop.
      const namingRelease = deps.releaseSessionName();
      return {
        content: [{
          type: "text",
          text: `review-gate: done accepted. ${summary}` +
            // WHAT THE USER'S OWN SWITCHES SKIPPED (quality round P2,
            // 2026-09-22) — from the record, never from the summary.
            (acceptanceNotes.length ? `\n真实验收：${acceptanceNotes.join("；")}` : "") +
            // R-22 — a round that shipped without a precommit says so.
            (state.checkpoint?.precommitBypassed
              ? "\n注意：本次交付的 checkpoint 是在 `/gate-bypass` 覆盖 precommit 前置的情况下完成的" +
                "（用户授权，理由已记在 bypass 里）—— 全量测试没有在这份内容上跑过。"
              : "") +
            // Honest about the banner: `missing` means the user was NOT told.
            (notified.status === "sent" ? "" : `\n（通知：${describeNotifyOutcome(notified)}）`) +
            (sessionClose.ok ? "" : `\n（专属 tmux session 未清干净：${sessionClose.error}）`) +
            (namingRelease.released ? "" : `\n（会话名字未腾出：${namingRelease.error ?? "未知原因"}）`) +
            // WHO DECIDED WHAT (2026-09-19), printed by the GATE from the state
            // record — only THIS session's (and its handoff predecessor's).
            formatProxyDecisionReport(
              sessionProxyDecisions(deps.proxyDecisions(), [state.sessionId ?? undefined, readInheritance().predecessorSession]),
            ),
        }],
        details: { accepted: true, precommitBypassed: state.checkpoint?.precommitBypassed === true },
      };
    },
  });
}
