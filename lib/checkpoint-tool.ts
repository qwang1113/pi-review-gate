/**
 * `review_checkpoint` — the pre-review commit channel. INTERNAL, not
 * registered with pi (philosophy three): the checkpoint is a step of
 * `judge_submit`, not a thing to sequence by hand. Moved out of
 * `extensions/review-gate.ts` (t8, 2026-09-26, wave 4 of the split).
 */

import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { firstBaseContaining, isNewInWorktree, readChangeBaseRefs } from "./change-baseline.ts";
import { planCheckpointSweep } from "./checkpoint-sweep.ts";
import { COMMIT_MSG_FORBIDDEN, isSensitiveFile } from "./constants.ts";
import {
  dependencyJustificationVerdict,
  formatDependencyJustificationVerdict,
  newDependencyNames,
} from "./dependency-justification.ts";
import { fileSizeVerdict, formatFileSizeVerdict, isSizeJudgedFile } from "./file-size-gate.ts";
import type { GateState } from "./gate-state.ts";
import { gitBaseEnv, gitOrNull, gitRaw, gitText } from "./git-exec.ts";
import { l5BlockReason, nonEnglishCommitMessage } from "./lang-detect.ts";
import type { LoopStage } from "./loop-stages.ts";
import { currentBranch } from "./repo-facts.ts";
import type { SessionRepos } from "./session-repos-host.ts";
import type { SessionCells } from "./session-cells.ts";
import type { AppealKind } from "./text-appeal.ts";
import type { ToolHost } from "./tool-host.ts";
import { isProtectedBranch } from "./workspace-branch.ts";

export interface CheckpointToolDeps {
  resolveToolRepo: SessionRepos["resolveToolRepo"];
  stateForRepo(root: string): GateState;
  persistRepo(ctx: ExtensionContext, root: string): void;
  refuseText(kind: AppealKind, text: string, reason: string, ctx: unknown): string | undefined;
  stageIsOn(stage: LoopStage, root?: string): boolean;
  precommitLaneRunning(root: string): boolean;
}

export function registerCheckpointTool(host: ToolHost, cells: SessionCells, deps: CheckpointToolDeps): void {
  host.registerTool({
    name: "review_checkpoint",
    label: "Review Checkpoint",
    description:
      "ADVANCED / internal: `judge_submit({role:\"reviewer\"})` runs this itself as step 2 of the " +
      "submission chain — call it directly only " +
      "to freeze work without submitting it. " +
      "Commits the current worktree as a checkpoint commit — the ONLY way to commit before a READY " +
      "review. Requires a precommit PASS (it bypasses READY only, never precommit), validates the " +
      "message is English (L5), commits everything (git add -A), records the commit sha and the " +
      "branch it landed on, and refuses any branch that is not this session's work branch. " +
      "Every review round judges baseline..HEAD, so checkpoints are the review unit.",
    parameters: Type.Object({
      message: Type.String({ description: "English commit message (Conventional Commits style)" }),
      note: Type.Optional(Type.String({
        description: "The agent's round note in its own words (the same text judge_submit receives as task) — the dependency-justification gate reads the justification from it, because the English-only commit message may have dropped the original wording.",
      })),
      repo: Type.Optional(Type.String({
        description: "Absolute repo path (required once the session edited several repos)",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const target = deps.resolveToolRepo(params.repo as string | undefined);
      if (!target.ok) {
        return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
      }
      const root = target.root;
      // NON-GIT SHORT-CIRCUIT: a checkpoint IS a commit — outside a
      // repository there is no commit to make. Refuse before any git call
      // (currentBranch below would otherwise leak fatal to the terminal).
      if (!cells.sessionInGit) {
        return {
          content: [{ type: "text", text: "review-gate: 非 git 目录 —— checkpoint 不可用（无仓库可提交）。" }],
          details: { committed: false },
          isError: true,
        };
      }
      // A checkpoint IS a commit, so it lands on the CURRENT branch — no
      // work-branch rule anymore (2026-09-07, user decision). The ONE hard
      // line left (2026-09-16, user decision): a checkpoint on a PROTECTED
      // branch (main/master/dev/develop) is REFUSED outright — no dialog,
      // no channel ask ("无论如何都不能在保护分支上面做 commit，checkpoint
      // 也不行"), exactly like the agent's own `git commit`.
      const here = currentBranch(root);
      // ANOTHER live session holds this worktree ⇒ no commit, of any kind.
      //
      // This is the gate's OWN commit path, and it does `git add -A` with the
      // hooks silenced — so a refused session would sweep the HOLDER's
      // uncommitted work into a commit and move HEAD under it. The agent's own
      // `git commit` is already refused (unmetRequirements), which is exactly
      // why this one has to be too (reviewer P1, 2026-09-05).
      if (cells.state.exclusivityRefusal) {
        return {
          content: [{ type: "text", text: cells.state.exclusivityRefusal }],
          details: { committed: false },
          isError: true,
        };
      }

      if (here && isProtectedBranch(here)) {
        return {
          content: [{ type: "text", text:
            `review-gate: checkpoint 拒绝 — 不能在受保护分支 ${here} 上提交（checkpoint 也是 commit）。\n` +
            "请先切到功能分支：`git checkout -b <type>/<slug>`，名字用英文 kebab-case 概括这次改动" +
            "（如 `feat/aum-blacklist-purge`、`fix/auth-token-expiry`），**不要**用会话 id 或 `rg-child-…` 这类内部 handle" +
            " —— 这个分支名会跟着 PR 走，是要给人看的。然后重新 checkpoint。" }],
          details: { committed: false },
          isError: true,
        };
      }
      const message = String(params.message ?? "").trim();
      if (message.length === 0) {
        return {
          content: [{ type: "text", text: "review-gate: review_checkpoint rejected — the commit message is empty." }],
          details: { committed: false },
          isError: true,
        };
      }
      // P2 (round-4): REVIEW_GATE_BYPASS=1 also silences hooks/commit-msg —
      // the AI-attribution guard — so this tool must replicate it.
      const attribution = COMMIT_MSG_FORBIDDEN.some((re) => re.test(message));
      if (attribution) {
        const reason = deps.refuseText("ai-attribution", message,
          "review_checkpoint rejected — commit message contains AI attribution. Rewrite without it.", ctx);
        if (reason) {
          return { content: [{ type: "text", text: reason }], details: { committed: false }, isError: true };
        }
      }
      // L5 (HARD): the same single rule as the bash commit path, through the
      // same function — no non-Latin letter in subject or body.
      const nonEn = nonEnglishCommitMessage(message);
      if (nonEn) {
        const kind: AppealKind = nonEn.part === "subject" ? "commit-subject" : "commit-body";
        const reason = deps.refuseText(kind, nonEn.text,
          `review_checkpoint rejected — ${l5BlockReason({ kind, text: nonEn.text })} 用英文重写。`, ctx);
        if (reason) {
          return { content: [{ type: "text", text: reason }], details: { committed: false }, isError: true };
        }
      }
      const st = deps.stateForRepo(root);
      // R-22 — WHAT `/gate-bypass` COVERS, decided by the user on 2026-08-30.
      //
      // The measured deadlock: a child's precommit failed for a reason that
      // had nothing to do with its change (an environment variable the
      // orchestration injected poisoned the test subprocess, R-15). The user
      // authorized `/gate-bypass`, the bypass took effect — and `judge_submit`
      // still refused, because the bypass only ever covered the SHIP gate.
      //
      // A bypass is the USER's authorization, and it now covers this
      // prerequisite too — but it never hides: the round is recorded as
      // bypassed, the reviewer is told, and declare_done says so.
      //
      // SCOPE (round-1 Nit): the bypass is a SESSION-level switch, not a
      // one-shot token — every later checkpoint in that session skips this
      // prerequisite too, which is why each of them stamps `precommitBypassed`
      // and the receipt below says so out loud every time.
      const precommitBypassed = st.bypass.active;
      // A STAGE THAT IS OFF IS NOT A PREREQUISITE (2026-09-22, user decision):
      // with `precommit` switched off the lane never runs, and a checkpoint
      // that demanded its PASS would be unsatisfiable — the same deadlock the
      // bypass above exists for, so it is released the same way (and said out
      // loud on the receipt below, where the bypass is named too).
      const precommitStageOn = deps.stageIsOn("precommit", root);
      // B1 (2026-09-10): a checkpoint MAY land while its verification is IN
      // FLIGHT — that is the whole point of running the long lane beside the
      // chain instead of in front of it. The receipt is the live promise, not
      // a file: a restarted session has none, and a checkpoint with no live
      // verification is refused exactly as before (fail-closed). A FAIL that
      // arrives afterwards withdraws the round's READY (see
      // `recordReviewVerdict`) and wakes the agent with the reason.
      const verifyingNow =
        precommitStageOn &&
        !precommitBypassed &&
        deps.precommitLaneRunning(root) &&
        st.precommit.verdict === "NOT_RUN";

      if (precommitStageOn && !precommitBypassed && !verifyingNow && st.precommit.verdict !== "PASS") {
        return {
          content: [{
            type: "text",
            text: `review-gate: checkpoint rejected — precommit is ${st.precommit.verdict} (a checkpoint bypasses READY only, never precommit). ` +
              "`judge_submit({role:\"reviewer\"})` runs the full lane before this step, so fix what it reported and submit the round again. " +
              "如果 precommit 是因为与本次改动无关的环境问题失败的，那是用户的决定：让用户 `/gate-bypass <理由>`，" +
              "bypass 会连这条前置一起覆盖，并把「本轮 precommit 被 bypass」写进记录。",
          }],
          details: { committed: false },
          isError: true,
        };
      }
      // Round-4 P2: dev-flow requires the FULL suite (lint + typecheck +
      // build + test) before a checkpoint and 送审 — a fast-lane PASS would
      // otherwise let a round go to review with the suite never run.
      if (precommitStageOn && !precommitBypassed && !verifyingNow && st.precommit.testScope !== "full") {
        return {
          content: [{
            type: "text",
            text: `review-gate: checkpoint rejected — the precommit PASS covers ${st.precommit.testScope ?? "unknown"}, not the full suite (dev-flow: 全量通过才允许送审). \`judge_submit({role:"reviewer"})\` always runs the FULL lane, so re-submit the round rather than reusing this narrowed PASS.`,
          }],
          details: { committed: false },
          isError: true,
        };
      }

      try {
        // The L3 pre-commit hook would reject this commit (no READY yet). The
        // tool IS the gate here: it verified precommit PASS (full) + English
        // + AI-attribution above — the checks the hooks perform — so
        // REVIEW_GATE_BYPASS=1 for the hook layer is the mechanism, not a
        // loophole.
        const status = gitRaw(root, ["status", "--porcelain"]);
        if (status.trim() === "") {
          return {
            content: [{ type: "text", text: "review-gate: review_checkpoint — nothing to commit (worktree is clean)." }],
            details: { committed: false },
          };
        }
        // Round-4 P2: refuse sensitive paths and report what is swept in.
        // Round-5 P2: porcelain has rename (`R  old -> new`) and quoted
        // non-ASCII (`A  "\344\270…"`) forms — take the DESTINATION side of
        // a rename and strip surrounding quotes before matching.
        // Round-6 P2 (measured): NEVER trim the whole status before slicing —
        // porcelain v1 lines carry a leading space in the X (index) column,
        // and `" M path".trim()` → `"M path"` shifts the path left, so
        // slice(3) eats the first character of the path.
        const changedLines = status.split("\n").filter((l) => l.trim().length > 0);
        const pathOf = (l: string): string => {
          let p = l.slice(3).trim();
          const arrow = p.indexOf(" -> ");
          if (arrow !== -1) p = p.slice(arrow + 4);
          if (p.startsWith("\"") && p.endsWith("\"")) p = p.slice(1, -1);
          return p;
        };
        const paths = changedLines.map(pathOf);
        const sensitive = paths.filter((p) => isSensitiveFile(pathResolve(root, p)));
        if (sensitive.length > 0) {
          return {
            content: [{
              type: "text",
              text: `review-gate: review_checkpoint rejected — sensitive path(s) in the worktree: ${sensitive.join(", ")}. Handle them by hand before checkpointing.`,
            }],
            details: { committed: false },
            isError: true,
          };
        }
        // FILE-SIZE gate (task book §9). Runs HERE, at the checkpoint, not at
        // edit time: blocking mid-write would fire while a file is half
        // written and force a blind restructure, whereas at the checkpoint
        // the whole shape exists and splitting it is mechanical. Only a NEW
        // oversized file blocks — an existing one gets a reminder.
        // MERGE-AWARE BASE (2026-09-15, dashboard). "Absent from HEAD" and
        // "created by this session" are the same statement ONLY when HEAD is
        // the sole parent; lib/change-baseline.ts carries the full account.
        const changeBases = readChangeBaseRefs(root);
        const sizeFacts = paths
          .filter(isSizeJudgedFile)
          .map((p) => {
            let content: string;
            try {
              content = readFileSync(pathResolve(root, p), "utf8");
            } catch {
              return undefined; // deleted (or unreadable): nothing to judge
            }
            const lines = content.length === 0 ? 0 : content.replace(/\n$/, "").split("\n").length;
            return { path: p, lines, isNew: isNewInWorktree(root, p, changeBases) };
          })
          .filter((f): f is { path: string; lines: number; isNew: boolean } => f !== undefined);
        const sizeCheck = fileSizeVerdict(sizeFacts);
        if (sizeCheck.blocking.length > 0) {
          return {
            content: [{
              type: "text",
              text: "review-gate: review_checkpoint rejected — " + formatFileSizeVerdict(sizeCheck),
            }],
            details: { committed: false, oversizedNewFiles: sizeCheck.blocking.length },
            isError: true,
          };
        }

        // DEPENDENCY-JUSTIFICATION gate (minimalism §5, 2026-09-08). Runs HERE,
        // at the checkpoint, next to the file-size gate. Only a NEW dependency
        // without a written justification blocks — worth stays with the judges.
        const depGate = (() => {
          // Root manifest only: a nested package.json (sub-package / fixture)
          // must be compared against ITS OWN base, not the root's (reviewer P2,
          // 2026-09-08). Nested manifests stay the reviewer's judgement call.
          if (!paths.some((p) => p === "package.json")) return { blocking: [] as string[] };
          let worktreeText: string | undefined;
          try {
            worktreeText = readFileSync(pathResolve(root, "package.json"), "utf8");
          } catch {
            return { blocking: [] as string[] }; // unreadable ⇒ no facts, never a block
          }
          // THE SAME MERGE-AWARE BASE as the size gate above (2026-09-15).
          // Mid-merge `HEAD:package.json` is the BRANCH side, so every
          // dependency `main` added would arrive as "new". The first base that
          // carries the manifest is the one to compare against.
          const manifestBase = firstBaseContaining(root, "package.json", changeBases);
          let baseText: string | undefined;
          if (manifestBase) {
            try {
              baseText = gitRaw(root, ["show", `${manifestBase}:package.json`]);
            } catch {
              baseText = undefined; // unreadable ⇒ no facts, never a block
            }
          } else {
            baseText = undefined; // no base (new repo / new manifest) ⇒ every key is new
          }
          const added = newDependencyNames(worktreeText, baseText);
          if (added.length === 0) return { blocking: [] as string[] };
          // The justification rides the agent's own words: the round note that
          // built this message, or the message itself.
          return dependencyJustificationVerdict(
            added.map((name) => ({ name })),
            { note: typeof params.note === "string" ? params.note : "", message },
          );
        })();
        if (depGate.blocking.length > 0) {
          return {
            content: [{
              type: "text",
              text: "review-gate: review_checkpoint rejected — " + formatDependencyJustificationVerdict(depGate),
            }],
            details: { committed: false, unjustifiedDeps: depGate.blocking.length },
            isError: true,
          };
        }

        // WHAT THIS COMMIT TAKES — AND WHAT IT LEAVES (drill F3, 2026-09-20).
        //
        // `git add -A` took EVERYTHING, including files this session never
        // wrote and no `.gitignore` covers (measured: the seeded
        // `node_modules` symlink went into the history). So the sweep keeps
        // every TRACKED change and the untracked paths THIS SESSION wrote
        // through edit/write (`st.sessionEditedFiles`), and leaves every other
        // untracked-and-unignored path where it is.
        //
        // The leftover list comes from `ls-files -z`, NOT from the porcelain
        // lines above: git QUOTES and escapes unusual names in `status`, and
        // handing that form back as a pathspec matches nothing.
        const untracked = gitRaw(root, ["ls-files", "--others", "--exclude-standard", "-z"])
          .split("\0").filter((p) => p.length > 0);
        const leftOut = planCheckpointSweep({ untracked, own: st.sessionEditedFiles ?? [] }).leftOut;
        gitText(root, ["add", "-A"], { timeout: 0 });
        if (leftOut.length > 0) {
          // Unstage, do not skip: `add -A` is still the right primitive for
          // the tracked half (deletes and renames included), and `reset`
          // leaves the leftover files exactly where they were.
          gitText(root, ["reset", "-q", "--", ...leftOut]);
        }
        // No timeout: the commit runs the repo's own hooks.
        gitText(root, ["commit", "-m", message], {
          timeout: 0,
          env: { ...gitBaseEnv(), REVIEW_GATE_BYPASS: "1" },
        });
        const sha = gitText(root, ["rev-parse", "HEAD"]);
        // THE COMMITTED FILES, READ FROM THE COMMIT (drill F4): the receipt
        // reports what the commit actually carries, not the worktree.
        const sweptIn = gitRaw(root, ["diff-tree", "-r", "--no-commit-id", "--name-only", "-z", "--root", sha])
          .split("\0").filter((p) => p.length > 0);
        // Round-4 P2: the sha is persisted so prepare_review can compute
        // baseline..HEAD against it. Round-8 P1: record HEAD^ as prevSha —
        // the baseline start for the NEXT prepare. Root commit: no parent —
        // prepare falls back to <sha>^.
        const prevSha = gitOrNull(root, ["rev-parse", "HEAD^"]) ?? "";
        st.checkpoint = {
          sha,
          prevSha,
          at: new Date().toISOString(),
          // R-22 — the bypass travels WITH the checkpoint.
          ...(precommitBypassed ? { precommitBypassed: true } : {}),
        };

        deps.persistRepo(ctx as unknown as ExtensionContext, root);
        return {
          content: [{
            type: "text",
            text: `review-gate: checkpoint committed ${sha.slice(0, 12)} — \"${message}\". This commit is the review unit for the next round (baseline..HEAD).` +
              `\n\nCHECKPOINT_SHA=${sha}\nFiles: ${sweptIn.length} — ${sweptIn.slice(0, 20).join(", ")}${sweptIn.length > 20 ? " …" : ""}` +
              // WHAT DID NOT GO IN, SAID OUT LOUD (drill F3/F4).
              (leftOut.length > 0
                ? `\n\n**未提交（${leftOut.length}）**：${leftOut.slice(0, 20).join(", ")}${leftOut.length > 20 ? " …" : ""}` +
                  "\n这些路径没有被 gitignore，也不是本会话通过 edit/write 写过的文件 —— 门禁没有把它们带进这次提交（它们仍在 worktree 里）。" +
                  "若其中有本轮的改动，请用 edit/write 工具重写一遍再送审：否则它不会进入审查范围 `baseline..HEAD`。"
                : "") +
              (precommitBypassed
                // R-22: never let a bypassed round read like a clean one.
                ? "\n\n**本轮 precommit 被 `/gate-bypass` 覆盖**（用户授权）：全量测试并没有在这份内容上跑过。" +
                  "这条事实已经记进 checkpoint，reviewer 与 declare_done 都会看到 —— 请在送审说明里写清 bypass 的理由。" +
                  "注意 bypass 是**会话级**的：在本会话里它对之后每一次 checkpoint 同样生效，" +
                  "根因修好之后请让用户 `/gate-reset`（或重开会话），别让它一直挂着。"

                : precommitStageOn
                ? "\n\nThe required full precommit already ran typecheck + build + the COMPLETE test suite on this exact content " +
                  "(cache: an unchanged input set is reused in seconds — do NOT manually re-run the full suite or `tsc`; " +
                  "run only targeted tests for files you keep editing, and let the round's own full lane be the single gate)."
                // THE SWITCH SAYS IT, NOT A SILENCE (2026-09-22).
                : "\n\n**precommit 环节已关闭**（用户设定的环节开关）：本轮不跑全量测试，ship 也不要求 precommit PASS。") +
              (sizeCheck.advisory.length ? "\n\n" + formatFileSizeVerdict(sizeCheck) : ""),
          }],
          details: { committed: true, sha, precommitBypassed, files: sweptIn, leftOut },
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `review-gate: review_checkpoint failed — ${reason}` }],
          details: { committed: false },
          isError: true,
        };
      }
    },
  });
}
