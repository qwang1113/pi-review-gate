/**
 * N1 residual (2026-09-27): the empty-range exit-goal round's "clean" is the
 * checkpoint's clean. Measured by a1: with only a foreign untracked file left,
 * the checkpoint read clean, the round became HEAD..HEAD, and prepare_review
 * refused "the worktree is dirty" because its wiring still asked a bare
 * `git status --porcelain`. These run the REAL wiring (`buildReviewPrepareDeps`)
 * against a real repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyState, type GateState } from "../lib/gate-state.ts";
import { DEFAULT_MAX_ROUNDS } from "../lib/constants.ts";
import { registerReviewPrepareTools } from "../lib/review-prepare-tools.ts";
import { buildReviewPrepareDeps, type PrepareWiringDeps } from "../lib/review-prepare-wiring.ts";
import { decideReviewScope } from "../lib/review-scope.ts";
import type { SessionCells } from "../lib/session-cells.ts";
import type { ToolHost, ToolReply } from "../lib/tool-host.ts";
import { git, neutraliseHostGitConfig } from "./helpers/git.ts";

neutraliseHostGitConfig();

async function prepare(setup: (root: string) => void, own: string[]): Promise<ToolReply> {
  const root = mkdtempSync(join(tmpdir(), "rg-n1r-"));
  try {
    // No remote, no main/master: no branch base, no checkpoint ⇒ HEAD..HEAD.
    git(root, ["init", "-q", "-b", "feat/demo"]);
    git(root, ["config", "user.name", "t"]);
    git(root, ["config", "user.email", "t@t"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "chore: init"]);
    setup(root);
    const st: GateState = { ...emptyState("s1", DEFAULT_MAX_ROUNDS), sessionEditedFiles: own };
    const wiring = {
      repos: {
        resolveToolRepo: () => ({ ok: true, root }),
        stateForRepo: () => st,
        persistRepo: () => {},
        reviewScopeFor: () => decideReviewScope({}),
        previousRoundFindings: () => [],
        settledConclusion: () => undefined,
      },
      loopGoalConfirmed: () => false,
      goalTextForReviewers: () => undefined,
      loopGoalPath: (r: string) => join(r, ".pi", "loop-goal.md"),
      reviewTargets: new Map(),
    } as unknown as PrepareWiringDeps;
    const deps = buildReviewPrepareDeps({ cwd: root } as unknown as SessionCells, wiring);
    deps.sessionDir = () => join(root, ".sessions");
    let run: ((p: Record<string, unknown>) => Promise<ToolReply>) | undefined;
    const host: ToolHost = {
      registerTool: (d) => { run = (p) => d.execute("id", p, undefined, undefined, undefined); },
    };
    registerReviewPrepareTools(host, deps);
    return await run!({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("only a FOREIGN untracked file left ⇒ the empty-range round is accepted", async () => {
  const reply = await prepare((root) => writeFileSync(join(root, "scratch notes.txt"), "x\n"), []);
  assert.notEqual(reply.isError, true, reply.content.map((c) => c.text).join("\n"));
  assert.equal(reply.details?.dirtyWorktree, undefined);
});

test("an untracked file THIS session wrote ⇒ still dirty", async () => {
  const reply = await prepare((root) => writeFileSync(join(root, "new.ts"), "x\n"), ["new.ts"]);
  assert.equal(reply.isError, true);
  assert.equal(reply.details?.dirtyWorktree, true);
});

test("an uncommitted change to a tracked file ⇒ still dirty", async () => {
  const reply = await prepare((root) => writeFileSync(join(root, "a.ts"), "export const a = 2;\n"), []);
  assert.equal(reply.isError, true);
  assert.equal(reply.details?.dirtyWorktree, true);
});
