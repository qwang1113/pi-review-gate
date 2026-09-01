import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  registerAdvisoryPrepareTools,
  resolveGoalRepo,
  type AdvisoryPrepareToolDeps,
} from "../lib/advisory-prepare-tools.ts";
import type { ToolHost, ToolReply } from "../lib/tool-host.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import { goalTextHash, normalizeGoalText } from "../lib/loop-goal.ts";
import { git } from "./helpers/git.ts";

/**
 * The two advisory preparations used to live inside the 8900-line extension,
 * where exercising the adviser's confirmation-based baseline meant a real
 * repository, a real goal file and a real artifact on disk. They are now a
 * lib/ module whose outside world arrives as `deps` — so the rules below run
 * against an in-memory filesystem, and a behavior change during the move would
 * have to survive an assertion instead of a reviewer's eyes.
 */

const ROOT = "/repo";
const GOAL_TEXT = "# 目标\n\n意图：把三个 prepare 工具搬进 lib/。\n";
const GOAL_HASH = goalTextHash(GOAL_TEXT);
const ARTIFACT = join(ROOT, ".pi", "review-stream", `adviser-${GOAL_HASH}.jsonl`);

interface Fake {
  deps: AdvisoryPrepareToolDeps;
  tools: Map<string, (params: Record<string, unknown>) => Promise<ToolReply>>;
  order: string[];
  st: GateState;
  files: Record<string, string>;
  dirs: string[];
  persisted: string[];
  goalConfirmed: boolean;
  goalTruncated: boolean;
  increments: Record<string, { files: string[] }>;
  headTree: string;
  repo: { ok: boolean; error: string };
  cwd: string;
}

/** One valid conclusion line, as the adviser appends it to its artifact. */
function conclusionLine(goalHash: string, at: string): string {
  return JSON.stringify({
    at,
    goalHash,
    verdict: "SUPPORTS",
    points: [{ severity: "P2", issue: "consider a narrower seam" }],
  });
}

function fake(overrides: Partial<Fake> = {}): Fake {
  // A REAL throwaway git repo for `cwd`: `resolveGoalRepo` (used by
  // prepare_goal_audit) resolves the default repo through `gitRootOfDir`,
  // so a fake path would never resolve. Created once per fake.
  const tmp = mkdtempSync(join(tmpdir(), "rg-adv-"));
  git(tmp, ["init", "-q"]);
  git(tmp, ["config", "user.name", "t"]);
  git(tmp, ["config", "user.email", "t@t"]);
  const state: Fake = {
    deps: undefined as unknown as AdvisoryPrepareToolDeps,
    tools: new Map(),
    order: [],
    st: emptyState("sess-1", 10),
    files: {},
    dirs: [],
    persisted: [],
    goalConfirmed: true,
    goalTruncated: false,
    increments: {},
    headTree: "tree-now",
    repo: { ok: true, error: "" },
    cwd: tmp,
    ...overrides,
  };
  state.files[join(ROOT, ".pi", "loop-goal.md")] ??= GOAL_TEXT;
  state.deps = {
    resolveRepo: () => (state.repo.ok ? { ok: true, root: ROOT } : { ok: false, error: state.repo.error }),
    cwd: state.cwd,
    stateFor: () => state.st,
    persist: (_ctx, root) => { state.persisted.push(root); },
    sessionDir: () => "/sessions/main",
    goalConfirmed: () => state.goalConfirmed,
    goalTextForReviewers: () => (state.goalConfirmed ? { text: GOAL_TEXT, truncated: state.goalTruncated } : undefined),
    loopGoalPath: (root) => join(root, ".pi", "loop-goal.md"),
    readText: (p) => state.files[p],
    ensureDir: (p) => { state.dirs.push(p); },
    incrementSinceTree: (_root, tree) => state.increments[tree],
    headCommitTree: () => state.headTree,
  };
  const host: ToolHost = {
    registerTool: (definition) => {
      state.order.push(definition.name);
      state.tools.set(definition.name, (params) => definition.execute("id", params, undefined, undefined, undefined));
    },
  };
  registerAdvisoryPrepareTools(host, state.deps);
  return state;
}

function textOf(reply: ToolReply): string {
  return reply.content.map((c) => c.text).join("\n");
}

async function call(f: Fake, tool: string, params: Record<string, unknown> = {}): Promise<ToolReply> {
  const run = f.tools.get(tool);
  assert.ok(run, `${tool} must be registered`);
  return run(params);
}

test("the module registers exactly the two advisory prepare tools, in order", () => {
  const f = fake();
  assert.deepEqual(f.order, ["prepare_adviser", "prepare_goal_audit"]);
});

// ---------- prepare_adviser ----------

test("prepare_adviser: an unresolvable repo is reported and nothing is written", async () => {
  const f = fake();
  f.repo = { ok: false, error: "review-gate: which repo?" };
  const reply = await call(f, "prepare_adviser");
  assert.equal(reply.isError, true);
  assert.equal(textOf(reply), "review-gate: which repo?");
  assert.deepEqual(f.dirs, [], "no artifact directory is created for a rejected call");
  assert.deepEqual(f.persisted, []);
});

test("prepare_adviser: the FIRST consultation is a full brief with no changed-file list", async () => {
  const f = fake();
  const reply = await call(f, "prepare_adviser");
  assert.notEqual(reply.isError, true);
  assert.equal(reply.details?.incremental, false);
  assert.equal(reply.details?.artifactPath, ARTIFACT);
  assert.deepEqual(reply.details?.changedFiles, [],
    "no previous conclusion and no baseline ⇒ nothing to re-list, not an unknown");
  assert.equal(reply.details?.title, `adviser-${GOAL_HASH.slice(0, 6)}`);
  assert.match(textOf(reply), /adviser brief ready \(full\)/);
  assert.match(textOf(reply), /--- task text ---/, "the payload is delimited for the chain");
  assert.deepEqual(f.dirs, [join(ROOT, ".pi", "review-stream")],
    "the artifact directory is created before the first consultation");
  // The baseline is recorded so the NEXT consultation can compute an increment.
  assert.deepEqual(f.st.adviserBaselines?.[GOAL_HASH], { tree: "tree-now", prevTree: null, confirmed: 0 });
  assert.deepEqual(f.persisted, [ROOT]);
});

test("prepare_adviser: a SECOND consultation carries the previous conclusion and the increment", async () => {
  const f = fake();
  f.files[ARTIFACT] = conclusionLine(GOAL_HASH, "2026-08-29T01:00:00.000Z");
  f.st.adviserBaselines = { [GOAL_HASH]: { tree: "tree-a", prevTree: null, confirmed: 0 } };
  f.increments["tree-a"] = { files: ["lib/x.ts"] };
  const reply = await call(f, "prepare_adviser");
  assert.equal(reply.details?.incremental, true, "the previous conclusion is carried forward");
  assert.deepEqual(reply.details?.changedFiles, ["lib/x.ts"],
    "the increment is measured from the CONFIRMED consultation's start tree");
  assert.match(textOf(reply), /adviser brief ready \(incremental\)/);
  // One conclusion landed since `confirmed: 0`, so the baseline advances and
  // remembers where it came from.
  assert.deepEqual(f.st.adviserBaselines?.[GOAL_HASH], { tree: "tree-now", prevTree: "tree-a", confirmed: 1 });
});

test("prepare_adviser: an ABORTED consultation does not advance the baseline and re-lists its changes", async () => {
  const f = fake();
  // The artifact still holds exactly the conclusions the baseline was recorded
  // with ⇒ the last consultation appended nothing ⇒ roll back to prevTree.
  f.files[ARTIFACT] = conclusionLine(GOAL_HASH, "2026-08-29T01:00:00.000Z");
  f.st.adviserBaselines = { [GOAL_HASH]: { tree: "tree-b", prevTree: "tree-a", confirmed: 1 } };
  f.increments["tree-a"] = { files: ["lib/x.ts", "lib/y.ts"] };
  f.increments["tree-b"] = { files: ["lib/y.ts"] };
  const reply = await call(f, "prepare_adviser");
  assert.deepEqual(reply.details?.changedFiles, ["lib/x.ts", "lib/y.ts"],
    "the aborted consultation's changes must not vanish from the next brief");
  assert.deepEqual(f.st.adviserBaselines?.[GOAL_HASH], { tree: "tree-b", prevTree: "tree-a", confirmed: 1 },
    "an aborted consultation never advances the baseline");
});

test("prepare_adviser: a cross-session conclusion with no baseline demands a FULL re-check", async () => {
  const f = fake();
  f.files[ARTIFACT] = conclusionLine(GOAL_HASH, "2026-08-29T01:00:00.000Z");
  const reply = await call(f, "prepare_adviser");
  assert.equal(reply.details?.changedFiles, null,
    "an increment this session never saw is UNKNOWN, never 'no changes'");
  assert.equal(reply.details?.incremental, true);
});

test("prepare_adviser: an unknowable increment stays null rather than reading as empty", async () => {
  const f = fake();
  f.st.adviserBaselines = { [GOAL_HASH]: { tree: "tree-a", prevTree: "tree-a", confirmed: 0 } };
  // No increment registered for tree-a ⇒ deps returns undefined.
  const reply = await call(f, "prepare_adviser");
  assert.equal(reply.details?.changedFiles, null);
});

test("prepare_adviser: an unapproved goal gets a STABLE per-session identity", async () => {
  const f = fake();
  f.goalConfirmed = false;
  const first = await call(f, "prepare_adviser");
  const second = await call(f, "prepare_adviser");
  assert.match(String(first.details?.artifactPath), /adviser-no-goal-sess-1\.jsonl$/,
    "repeated consultations in one session must reuse each other's conclusions");
  assert.equal(first.details?.artifactPath, second.details?.artifactPath);
});

test("prepare_adviser: an unreadable goal file falls back to the session identity", async () => {
  const f = fake();
  delete f.files[join(ROOT, ".pi", "loop-goal.md")];
  const reply = await call(f, "prepare_adviser");
  assert.match(String(reply.details?.artifactPath), /adviser-no-goal-sess-1\.jsonl$/,
    "the artifact identity hashes the RAW file, so an unreadable one cannot be hashed");
});

test("prepare_adviser: a truncated goal is pointed at its file", async () => {
  const f = fake();
  f.goalTruncated = true;
  const truncated = await call(f, "prepare_adviser");
  assert.match(textOf(truncated), /loop goal 因长度被截断/);
  assert.match(textOf(truncated), /loop-goal\.md/);

  const g = fake();
  const whole = await call(g, "prepare_adviser");
  assert.doesNotMatch(textOf(whole), /loop goal 因长度被截断/);
});

// ---------- prepare_goal_audit ----------

test("resolveGoalRepo: a repo this session has NOT edited is still resolvable (gitRootOfDir, not sessionRepos)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-goal-repo-"));
  // A bare dir with no .git is NOT a repo: refuse (fail-closed).
  const bare = resolveGoalRepo(tmp, tmpdir());
  assert.equal(bare.ok, false);
  assert.match(bare.error ?? "", /not inside a readable git repository/);
  // A real git repo IS resolvable even though no session ever edited it.
  git(tmp, ["init", "-q"]);
  git(tmp, ["config", "user.name", "t"]);
  git(tmp, ["config", "user.email", "t@t"]);
  git(tmp, ["commit", "--allow-empty", "-m", "init"]);
  const repo = resolveGoalRepo(tmp, tmpdir());
  assert.equal(repo.ok, true);
  assert.equal((repo as { ok: true; root: string }).root, realpathSync(tmp), "gitRootOfDir returns the canonical path");
  rmSync(tmp, { recursive: true, force: true });
});

test("prepare_goal_audit: an unresolvable repo is reported", async () => {
  const f = fake();
  f.cwd = "/no-such-dir";
  const reply = await call(f, "prepare_goal_audit", { goal: "草稿", repo: "/no-such-dir/repo" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /not inside a readable git repository/);
});

test("prepare_goal_audit: an empty (or whitespace-only) draft is refused", async () => {
  const f = fake();
  for (const goal of [undefined, "", "   \n  "]) {
    const reply = await call(f, "prepare_goal_audit", goal === undefined ? {} : { goal });
    assert.equal(reply.isError, true, `goal=${JSON.stringify(goal)} must be refused`);
    assert.match(textOf(reply), /the goal text is empty/);
    assert.deepEqual(reply.details, {});
  }
});

test("prepare_goal_audit: the FIRST audit of a draft carries no carryover", async () => {
  const f = fake();
  const reply = await call(f, "prepare_goal_audit", { goal: "# 目标\n\n意图：搬迁。\n" });
  assert.notEqual(reply.isError, true);
  assert.equal(reply.details?.reaudit, false);
  const hash = goalTextHash(normalizeGoalText("# 目标\n\n意图：搬迁。\n"));
  assert.equal(reply.details?.hash, hash.slice(0, 12));
  assert.equal(reply.details?.title, `goal-audit-${hash.slice(0, 6)}`);
  assert.match(textOf(reply), /goal-auditor task ready \(first audit\)/);
  assert.match(textOf(reply), /--- task text ---/, "the payload is delimited for the chain");
});

test("prepare_goal_audit: a DIFFERENT draft after a recorded audit becomes a re-audit with carryover", async () => {
  const f = fake();
  f.st.goalPrereview = {
    hash: goalTextHash("旧草稿"),
    verdict: "FAIL",
    at: "2026-08-29T01:00:00.000Z",
    findings: [{ severity: "P1", issue: "退出标准不可检查" }],
    draft: "旧草稿",
  };
  const reply = await call(f, "prepare_goal_audit", { goal: "新草稿" });
  assert.equal(reply.details?.reaudit, true);
  assert.match(textOf(reply), /goal-auditor task ready \(re-audit with carryover\)/);
  assert.match(textOf(reply), /退出标准不可检查/, "the previous objections travel into the re-audit");
  assert.match(textOf(reply), /旧草稿/, "and so does the draft they were made about");
});

test("prepare_goal_audit: re-submitting the IDENTICAL draft is not a re-audit", async () => {
  const f = fake();
  const draft = "同一份草稿";
  f.st.goalPrereview = {
    hash: goalTextHash(normalizeGoalText(draft)),
    verdict: "FAIL",
    at: "2026-08-29T01:00:00.000Z",
    draft,
  };
  const reply = await call(f, "prepare_goal_audit", { goal: draft });
  assert.equal(reply.details?.reaudit, false,
    "carryover answers 'what changed since the last draft' — for the same text there is nothing to carry");
});
