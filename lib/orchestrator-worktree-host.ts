/**
 * ONE CHECKOUT PER WRITER, as this session runs it (2026-09-10): the second
 * child in a repo gets its own worktree, and the manager names its fate when
 * the child is done. Every derivation — paths, branches, the settlement's git
 * sequence and its failure readings — is lib/orchestrator-worktree.ts's; this
 * host only executes it. Moved out of `extensions/review-gate.ts` (t8, 2026-09-26).
 */

import { existsSync } from "node:fs";
import { gitText } from "./git-exec.ts";
import {
  childWorktreeBranch,
  childWorktreePath,
  createWorktreeArgv,
  looksLikeAlreadyGone,
  looksLikeMergeConflict,
  planSettlement,
} from "./orchestrator-worktree.ts";
import { findChild, noteWorktreeBranch, type OrchestratorRuntime } from "./orchestrator-registry.ts";
import { listedWorktreeBranch } from "./repo-facts.ts";
import type { SessionCells } from "./session-cells.ts";
import { seedWorktree } from "./worktree-seed.ts";

type Settlement = "keep" | "merge" | "discard";

export function createWorktreeSettlement(
  cells: SessionCells,
  deps: { persistOrchestration(runtime: OrchestratorRuntime): void },
) {
  function createWorktree(repoRoot: string, childId: string) {
    const path = childWorktreePath(repoRoot, childId);
    const branch = childWorktreeBranch(childId);
    try {
      gitText(repoRoot, createWorktreeArgv(repoRoot, childId), { timeout: 0 });
    } catch (error) {
      const detail = (error as { stderr?: Buffer | string }).stderr;
      return {
        ok: false as const,
        reason: String(detail ?? (error as Error).message).trim().split("\n").slice(-3).join(" "),
      };
    }
    // SEED IT BEFORE THE CHILD SEES IT (2026-09-15, onchain). `git worktree
    // add` reproduces the COMMIT, and a repository's local environment is by
    // definition not in it: the project's gate config, its `.env` and its
    // `node_modules` are all gitignored. Measured cost of skipping this: a
    // child whose precommit silently ran `yarn test` (the whole midway
    // suite) instead of the repository's configured scoped jest — 143 files
    // failing for reasons that had nothing to do with its change — while the
    // project manager had to talk it through copying a config file by hand.
    // lib/worktree-seed.ts owns what may be taken, and why.
    const seeded = seedWorktree(repoRoot, path);
    return {
      ok: true as const,
      path,
      branch,
      ...(seeded.length > 0 ? { note: seeded.join("\n") } : {}),
    };
  }

  // SETTLE IT (2026-09-10): the manager names the fate of a finished child's
  // checkout; the git sequence is lib/orchestrator-worktree.ts's, so the
  // conflict path is decided there rather than discovered here.
  function settleWorktree({ childId, taskId, repoRoot, settlement }: {
    childId: string;
    taskId: string;
    repoRoot: string;
    settlement: Settlement;
  }) {
    const worktreePath = childWorktreePath(repoRoot, childId);
    // THE BRANCH THE CHECKOUT IS ACTUALLY ON (2026-09-18, reviewer P2). The
    // task book lets a child whose station reaches `pr` rename the gate's
    // `rg-child-…` handle before it pushes (lib/orchestrator-delivery.ts
    // `buildBranchLine`); settling the DERIVED name after that fails with
    // "branch not found", which reports the manager's checkout as broken
    // right after they did what the gate asked.
    //
    // THREE SOURCES, IN THIS ORDER, because each one covers what the previous
    // cannot. The repository's own listing is the ONLY acceptable first
    // source — reading the directory asks git, which walks UP to an enclosing
    // repository when that path is not one, and the name it answers with ends
    // up in a destructive `branch -D` (quality round P1, 2026-09-18). A merge
    // RECLAIMS the directory (2026-09-15, user decision), so the `discard`
    // its receipt asks for next has nothing left to list — it needs the name
    // this session recorded when it DID read one (below), and the derived
    // name is the last resort for a child with no worktree record at all.
    const state = cells.state;
    const registered = state.orchestrator ? findChild(state.orchestrator, childId)?.worktree?.branch : undefined;
    const branch = listedWorktreeBranch(repoRoot, worktreePath) ?? registered ?? childWorktreeBranch(childId);
    const plan = planSettlement(settlement, repoRoot, childId, taskId, branch);
    if (plan.steps.length === 0) {
      return { ok: true, text: `worktree 保留在 ${worktreePath}（分支 ${branch}）—— 没有动它` };
    }
    // IDEMPOTENT ON AN ALREADY-RECLAIMED CHECKOUT (2026-09-15). A `merge`
    // reclaims the directory, so a SECOND settlement — or the `discard` a
    // manager issues afterwards to take the branch away too — contains steps
    // aimed at a directory that is already gone. `git -C <missing> add -A`
    // answers "not a git repository", which is a fact about the path and not
    // about the work, so those steps are DROPPED rather than reported as a
    // failure: the branch steps and the merge itself still run.
    const steps = existsSync(worktreePath)
      ? plan.steps
      : plan.steps.filter((step) => step[1] !== worktreePath);
    const run = (argv: readonly string[]): { ok: boolean; output: string } => {
      try {
        // No timeout: a merge or commit step may run the user's hooks.
        return { ok: true, output: gitText(repoRoot, argv, { timeout: 0 }) };
      } catch (error) {
        // BOTH STREAMS (round-5 P1): git writes the merge-conflict text and
        // "nothing to commit" to STDOUT and exits non-zero. Reading only
        // stderr meant neither of those two matches could ever fire — the
        // planned abort never ran, and a child who left nothing uncommitted
        // was reported as a failure.
        const e = error as { stdout?: Buffer | string; stderr?: Buffer | string };
        const out = [e.stdout, e.stderr].map((v) => (v === undefined ? "" : String(v))).join("");
        return { ok: false, output: out.trim() || (error as Error).message };
      }
    };
    // Reclamation after a SUCCESSFUL merge is reported, never fatal: the
    // work is already in the manager's checkout, and failing the whole
    // settlement over an unclean worktree directory would be lying about
    // where the work is.
    const reclamation: string[] = [];
    for (const step of steps) {
      const result = run(step);
      if (result.ok) continue;
      const sub = step[2];
      if (sub === "commit" && /nothing to commit|no changes added/i.test(result.output)) continue;
      if (settlement === "merge" && sub === "merge" && looksLikeMergeConflict(result.output)) {
        for (const undo of plan.onConflict ?? []) run(undo);
        return {
          ok: false,
          text:
            `合并 ${childId} 的 worktree 时**冲突** —— 已中止，你的工作区回到合并前的样子。\n` +
            `它的分支 \`${branch}\` 仍在 ${childWorktreePath(repoRoot, childId)}，一行都没丢。` +
            `需要人工解决：在那边 \`git rebase ${repoRoot}\`（或你习惯的方式）后再 \`orchestrator_close\` 一次。\n\n` +
            result.output.trim().split("\n").slice(0, 12).join("\n"),
        };
      }
      if (sub === "worktree" || sub === "branch") {
        // IDEMPOTENT, so a retry can CONVERGE (round-10 P2). The decision is
        // `looksLikeAlreadyGone` in lib/orchestrator-worktree.ts — pure, and
        // unit-tested there, because "is this failure actually success" is
        // exactly the kind of rule that must not be inlined into a closure.
        if (looksLikeAlreadyGone(result.output)) continue;
        reclamation.push(result.output.trim().slice(0, 200));
        continue;
      }
      return { ok: false, text: `worktree 结算失败（git ${sub ?? "?"}）：${result.output.trim().slice(0, 600)}` };
    }
    // REMEMBER WHAT THE CHECKOUT TURNED OUT TO BE ON (reviewer P2,
    // 2026-09-18). Both settlements that get here REMOVE the directory, and
    // the branch name is then the only thing left to settle with — without
    // this, the very `discard` the receipt below asks for deletes the derived
    // name, misses a renamed branch, and reports it reclaimed anyway.
    const runtime = cells.state.orchestrator;
    const noted = runtime === undefined ? undefined : noteWorktreeBranch(runtime, childId, branch);
    if (runtime !== undefined && noted !== undefined && noted !== runtime) deps.persistOrchestration(noted);
    // BOTH SETTLEMENTS THAT REMOVE SOMETHING RUN RECLAMATION — `discard`
    // (checkout + branch) and `merge` (checkout only, 2026-09-15) — so both
    // can report a failed one. `keep` plans no steps at all and returns
    // above. A merge that CONFLICTED never got here: the sequence stopped at
    // the merge step, and its abort leaves the child's checkout exactly
    // where the human now needs it.
    return {
      ok: true,
      // The RECLAMATION outcome rides back with the settlement, because the
      // caller has to know whether the checkout is actually GONE: forgetting
      // a record whose directory still exists strands it — and a retry is
      // exactly what a failed removal should leave open (round-9 P2).
      reclaimed: reclamation.length === 0,
      text: settlement === "merge"
        ? `已把 ${childId} 的改动合并到当前分支（**已暂存、未提交** —— 看过再 commit）。\n` +
          (reclamation.length === 0
            ? `它的隔离 checkout（${worktreePath}）**已回收** —— 目录不再占地方。\n`
            : `⚠️ 合并成功，但这个隔离 checkout 没能回收：${reclamation.join(" / ")}\n路径 ${worktreePath}。\n`) +
          `分支 \`${branch}\` **保留**：这次合并还只是 staged，` +
          `万一你要 \`git merge --abort\` / reset，它就是那份工作的锚（删了它就只剩 reflog）。提交后用 ` +
          `\`orchestrator_close({childId:"${childId}", worktree:"discard"})\` 连分支一起收回 —— ` +
          `那个调用对已关闭的子会话**同样有效**（它只结算 checkout，不再开门）。`
        : reclamation.length > 0
          ? `⚠️ ${childId} 的 worktree **没能回收**（工作区或分支还留着）：${reclamation.join(" / ")}\n` +
            `路径 ${childWorktreePath(repoRoot, childId)}，分支 \`${branch}\`。\n` +
            `再调一次 \`orchestrator_close({childId:"${childId}", worktree:"discard"})\` 会重试——` +
            `已经删掉的那一半会被当作已完成，不会重复报错。`
          : `已回收 ${childId} 的 worktree 与分支（丢弃）。`,
    };
  }

  return { createWorktree, settleWorktree };
}
