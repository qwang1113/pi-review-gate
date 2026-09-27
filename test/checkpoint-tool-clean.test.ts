/**
 * N1 (2026-09-27): the checkpoint's "clean" is the fingerprint's clean (D20).
 *
 * Measured: with only a foreign untracked file left (an unignored `.pi/` file
 * no edit/write of this session produced; any foreign untracked path behaves
 * the same), a re-submission without changes
 * went past a `git status --porcelain` check that counted that file, and the
 * commit died on git's raw "nothing added to commit". Plus the dry run the
 * submission chain asks BEFORE it starts the lane.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerCheckpointTool, type CheckpointToolDeps } from "../lib/checkpoint-tool.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import { DEFAULT_MAX_ROUNDS } from "../lib/constants.ts";
import { git, neutraliseHostGitConfig } from "./helpers/git.ts";

neutraliseHostGitConfig();

type Result = { content: { text: string }[]; details: Record<string, unknown>; isError?: boolean };

function setup(opts: { own?: string[]; precommit?: "PASS" | "NOT_RUN"; refused?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rg-n1-"));
  git(root, ["init", "-q", "-b", "feat/demo"]);
  // The product's git strips GIT_CONFIG_*: identity and signing live in the repo.
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "chore: init"]);
  const st: GateState = {
    ...emptyState("s1", DEFAULT_MAX_ROUNDS),
    precommit: opts.precommit === "NOT_RUN"
      ? { verdict: "NOT_RUN", fingerprint: null, at: "2026-09-27T00:00:00.000Z" }
      : { verdict: "PASS", fingerprint: "t", at: "2026-09-27T00:00:00.000Z", testScope: "full" },
    sessionEditedFiles: opts.own ?? [],
  };
  let execute: ((...a: unknown[]) => Promise<Result>) | undefined;
  registerCheckpointTool(
    { registerTool: (d: { execute: typeof execute }) => { execute = d.execute; } } as never,
    { sessionInGit: true, state: {} } as never,
    {
      resolveToolRepo: () => ({ ok: true, root }),
      stateForRepo: () => st,
      persistRepo: () => {},
      refuseText: (_k, text, reason) => { opts.refused?.push(text); return reason; },
      stageIsOn: () => true,
      precommitLaneRunning: () => false,
    } as CheckpointToolDeps,
  );
  const call = (params: Record<string, unknown>) =>
    execute!("id", { message: "chore: checkpoint", ...params }, undefined, undefined, {});
  return { root, call, head: () => git(root, ["rev-parse", "HEAD"]) };
}

test("N1: only a foreign untracked file left ⇒ 'nothing to commit', not git's raw failure", async () => {
  const { root, call, head } = setup();
  try {
    // Not under `.pi/`: the product's git reads the HOST's global excludes (it
    // strips GIT_CONFIG_*), and a host that ignores `.pi*` would hide the file.
    mkdirSync(join(root, "scratch"));
    writeFileSync(join(root, "scratch", "stranger.json"), "{}\n");
    const before = head();
    const out = await call({});
    assert.notEqual(out.isError, true, out.content[0]?.text);
    assert.equal(out.details.committed, false);
    assert.match(out.content[0].text, /nothing to commit/);
    assert.equal(head(), before, "no commit was made");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("N1: a foreign file beside real work stays out; the refusal checks judge committed paths only", async () => {
  const { root, call, head } = setup({ own: ["new.ts"] });
  try {
    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    writeFileSync(join(root, "new.ts"), "export const n = 1;\n");
    // A foreign `.env` is never committed, so it is no reason to refuse.
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    const before = head();
    const out = await call({});
    assert.notEqual(out.isError, true, out.content[0]?.text);
    assert.equal(out.details.committed, true);
    assert.notEqual(head(), before);
    const committed = git(root, ["diff-tree", "-r", "--no-commit-id", "--name-only", "HEAD"]).split("\n");
    assert.deepEqual(committed.sort(), ["a.ts", "new.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("N1: the dry run never judges the message — refuseText would spend a single-use appeal pass", async () => {
  const refused: string[] = [];
  const { root, call } = setup({ refused });
  try {
    writeFileSync(join(root, "a.ts"), "export const a = 4;\n");
    const dry = await call({ dryRun: true, message: "feat: 中文主题" });
    assert.notEqual(dry.isError, true, dry.content[0]?.text);
    assert.deepEqual(refused, [], "no text check ran, so no appeal pass could be consumed");
    assert.equal((await call({ message: "feat: 中文主题" })).isError, true, "the real checkpoint still refuses it");
    assert.equal(refused.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("N1: the dry run needs no precommit PASS, commits nothing, and still refuses what the real one would", async () => {
  const { root, call, head } = setup({ own: [".env"], precommit: "NOT_RUN" });
  try {
    writeFileSync(join(root, "a.ts"), "export const a = 3;\n");
    const before = head();
    const dry = await call({ dryRun: true });
    assert.notEqual(dry.isError, true, dry.content[0]?.text);
    assert.equal(dry.details.dryRun, true);
    assert.equal(head(), before, "a dry run commits nothing");
    assert.match(git(root, ["status", "--porcelain"]), /a\.ts/, "…and stages nothing either");
    // Without the lane the real checkpoint still demands the PASS.
    assert.equal((await call({})).isError, true);
    // A path this session wrote that is sensitive: the dry run refuses it.
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    const refused = await call({ dryRun: true });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /sensitive/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
