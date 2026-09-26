/**
 * `run_precommit` — the ONLY path to a precommit PASS. INTERNAL, not
 * registered with pi: precommit is the first step of `judge_submit`, which
 * always runs the FULL lane before it freezes anything. Moved out of
 * `extensions/review-gate.ts` (t8, 2026-09-26, wave 4 of the split).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GateState } from "./gate-state.ts";
import { appendTiming } from "./gate-timings.ts";
import { runTrustedPrecommit } from "./precommit-runner.ts";
import { createProgressReporter, type ToolUpdate } from "./progress-stream.ts";
import { samePlace } from "./repo-facts.ts";
import type { SessionCells } from "./session-cells.ts";
import type { SessionRepos } from "./session-repos-host.ts";
import type { ToolHost } from "./tool-host.ts";

export interface PrecommitToolDeps {
  resolveToolRepo: SessionRepos["resolveToolRepo"];
  stateForRepo(root: string): GateState;
  persistRepo(ctx: ExtensionContext, root: string): void;
  repoLabel(root: string): string;
}

export function registerPrecommitTool(host: ToolHost, cells: SessionCells, deps: PrecommitToolDeps): void {
  host.registerTool({
    name: "run_precommit",
    label: "Run Precommit",
    description:
      "ADVANCED / internal: `judge_submit({role:\"reviewer\"})` runs this itself as step 1 of the " +
      "submission chain — call it directly only to check the lane on its own. " +
      "Runs the trusted precommit checks and records the verdict. This is the ONLY way to " +
      "record a precommit PASS — the gate never trusts a PASS parsed from bash output. " +
      "The extension spawns the bundled runner itself and verifies a private nonce receipt.",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({ description: "'fast' (default) or 'full'" })),
      repo: Type.Optional(Type.String({
        description:
          "Absolute path of the repository to run the checks in. REQUIRED once the session has edited " +
          "more than one repository — the PASS binds to that repo's own worktree fingerprint and " +
          "unblocks only that repo.",
      })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      // Available in every mode: explore allows edits/bash, so the agent may
      // legitimately want to verify its investigation with the trusted runner.
      const mode = params.mode === "full" ? "full" : "fast";
      // P-multi: precommit runs in — and binds its PASS to — the repo named by
      // `repo` (mandatory once several repos are in play), falling back to the
      // last-edited repo in a single-repo session; never just the session cwd.
      // The target DIR for the primary repo stays the session cwd (its
      // precommit may be repo-subdir-aware); other repos run at their root.
      // stateForRepo(primary) IS `state`, so no global swap is needed: the
      // local `st` writes land on the right object and persistRepo persists
      // to the right sidecar. (A global `state = stateForRepo(...)` swap
      // across the long `await runTrustedPrecommit` was rejected: a parallel
      // edit tool_result in that window would arm the WRONG repo's state and
      // persist it to the primary sidecar — losing hasCodeChange, a fail-open.)
      const target = deps.resolveToolRepo(params.repo as string | undefined);
      if (!target.ok) {
        return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
      }
      const targetRoot = target.root;
      // NON-GIT SHORT-CIRCUIT: the runner's change detection and fingerprint
      // binding are git-backed; outside a repository the run would fail its
      // own checks and leak fatal noise. Nothing to verify there — refuse.
      if (!cells.sessionInGit) {
        return {
          content: [{ type: "text", text: "review-gate: 非 git 目录 —— run_precommit 不可用（无仓库可检查）。" }],
          details: { ok: false },
          isError: true,
        };
      }
      const targetDir = targetRoot === cells.primaryRepoRoot ? cells.cwd : targetRoot;
      const st = deps.stateForRepo(targetRoot);
      // Same liveness rule as the verdict recorder: running precommit proves the
      // agent is not waiting on the user — clear any stale question pause.
      delete st.pausedQuestion;
      // P1 fix: pass the target dir explicitly (runTrustedPrecommit used to
      // derive its own process.cwd(), which can differ from ctx.cwd).
      // targetDir is where the checks RUN; targetRoot is the repo the run log
      // belongs to (`.pi/` is only gate-owned at the root — see keepRunLog).
      // Live progress: the runner's own log is shown UNDER a step line that
      // carries the lane and the elapsed time. The frames go to `onUpdate`
      // only; the verdict text below is what the agent gets.
      const progress = createProgressReporter({
        title: `review-gate: precommit (${mode})`,
        onUpdate: onUpdate as ToolUpdate | undefined,
      });
      progress.step(mode === "full" ? "lint + typecheck + build + 全量测试" : "lint + typecheck + build + 相关测试");
      const outcome = await runTrustedPrecommit(targetDir, targetRoot, mode, signal, (partial) => {
        progress.tail(partial.content.map((c) => c.text).join("\n"));
      });
      progress.done(outcome.verdict);

      if (outcome.verdict === "PASS") {
        // Bind PASS to the fingerprint recomputed AFTER the runner finished
        // (a lint:fix step may have modified files). `testScope` travels with
        // the binding because it decides what this PASS may authorize: a fast
        // lane narrowed to the changed files can clear a commit, never a push.
        st.precommit = {
          verdict: "PASS",
          fingerprint: outcome.fingerprint,
          at: new Date().toISOString(),
          mode,
          testScope: outcome.testScope,
          // CARRIED, never decided here: the pass-coverage record is written
          // (and revoked) by `nextFullPassTree` at the lane's own completion,
          // which is the only place that knows the tree the lane STARTED on.
          ...(st.precommit.lastFullPassTree ? { lastFullPassTree: st.precommit.lastFullPassTree } : {}),
        };
      } else {
        // P0 fix: "ERROR" is a runner-protocol outcome, NOT a GateState
        // PrecommitVerdict enum member. Persisting it would make loadSidecar
        // and the git pre-commit hook reject the whole sidecar as forged.
        // Map ERROR → NOT_RUN (accurate: no trusted verdict was recorded);
        // FAIL / NO_CHECKS_RUN persist as themselves. The error detail still
        // reaches the model via the tool result text below.
        const persisted = outcome.verdict === "ERROR" ? "NOT_RUN" : outcome.verdict;
        st.precommit = {
          verdict: persisted,
          fingerprint: null,
          at: new Date().toISOString(),
          mode,
          testScope: outcome.testScope,
          // Same carry-forward as the PASS branch above.
          ...(st.precommit.lastFullPassTree ? { lastFullPassTree: st.precommit.lastFullPassTree } : {}),
        };
      }
      deps.persistRepo(ctx as unknown as ExtensionContext, targetRoot);

      // Observability (diagnostics only, never read by an enforcement path):
      // one line per run so "why did this take 5 minutes?" stays answerable
      // after the fact. See lib/gate-timings.ts.
      appendTiming(targetRoot, {
        kind: "precommit",
        at: new Date().toISOString(),
        repo: targetRoot,
        mode,
        testScope: outcome.testScope ?? "unknown",
        verdict: outcome.verdict,
        totalMs: outcome.totalMs ?? 0,
        steps: outcome.timings ?? [],
        fingerprint: outcome.fingerprint.slice(0, 12),
      });
      // A precommit run is a gate event: the NEXT review round's approximate
      // duration measures from here, not from before this run.
      cells.lastGateEventAt.current = Date.now();

      // Naming the lane in the reply is what stops the agent from discovering
      // at push time that its PASS does not qualify.
      const lane = `[lane ${mode}, tests: ${outcome.testScope ?? "unknown"}${outcome.configSource ? `, config: ${outcome.configSource}` : ""}]`;
      const pushNote = outcome.verdict === "PASS" && outcome.testScope !== "full"
        ? ' This clears a `git commit`; `git push` / `gh pr create` need a run with mode "full".'
        : "";
      // testScope skipped = the test step was DROPPED (no related-test
      // strategy), so the commit-time PASS never executed the suite. This
      // must be loud: a user seeing only "PASS" would reasonably assume
      // tests ran.
      const skippedNote = outcome.verdict === "PASS" && outcome.testScope === "skipped"
        ? " ⚠️ WARNING: NO tests ran in this lane — the test script could not be narrowed to related tests and was skipped entirely; this PASS did NOT execute the test suite. A `git push` / `gh pr create` requires a full run that does."
        : "";
      const detail =
        outcome.verdict === "PASS" ? `PASS ${lane} (${outcome.checksRun} checks ran, 0 failed).${pushNote}${skippedNote}`
        : outcome.verdict === "FAIL" ? `FAIL ${lane} (${outcome.checksFailed}/${outcome.checksRun} checks failed).`
        : outcome.verdict === "NO_CHECKS_RUN" ? `NO CHECKS RUN ${lane} — zero runnable checks; this is NOT a pass. Configure real checks or /gate-bypass.`
        : `ERROR (${outcome.error ?? "runner could not be trusted"}) — fail-closed.`;

      // Diagnostics pointer. The full runner output is ALWAYS captured to a
      // file; what changes with the verdict is whether the agent is told to go
      // read it. Output is never inlined here — a failing test suite can emit
      // megabytes. Failed check NAMES are included so it can jump to the
      // right section instead of paging through the whole log.
      const failed = outcome.failedSteps.length ? ` Failed: ${outcome.failedSteps.join(", ")}.` : "";
      const logNote = !outcome.logPath
        ? " (run log unavailable — the runner produced no readable output)"
        : outcome.verdict === "PASS"
          ? ` Full output: ${outcome.logPath}`
          : `${failed} Full output: ${outcome.logPath} — read it (or grep it) to see what failed; it is the complete runner output, not a summary.`;

      return {
        // Name the REPO in the text (not just details). The PASS binds to the
        // repo root, so that is what is echoed; the working directory is only
        // shown when it is genuinely a different place (compared through
        // realpath — a symlinked cwd never string-matches git's root).
        content: [{
          type: "text",
          text: `review-gate: precommit for ${targetRoot}` +
            (samePlace(targetDir, targetRoot) ? "" : ` (ran in ${targetDir})`) + `: ${detail}` + logNote,
        }],
        details: {
          verdict: outcome.verdict, checksRun: outcome.checksRun, checksFailed: outcome.checksFailed,
          repo: deps.repoLabel(targetRoot), logPath: outcome.logPath, failedSteps: outcome.failedSteps,
        },
        isError: outcome.verdict !== "PASS",
      };
    },
  });
}
