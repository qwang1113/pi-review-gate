import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  registerReviewPrepareTools,
  precommitBaselineFor,
  type PreparedReviewTarget,
  type ReviewPrepareToolDeps,
} from "../lib/review-prepare-tools.ts";
import type { ToolHost, ToolReply } from "../lib/tool-host.ts";
import { emptyState, type GateState, type RoundRecord } from "../lib/gate-state.ts";
import { decideReviewScope } from "../lib/review-scope.ts";

/**
 * `prepare_review` used to live inside the 8900-line extension, where the only
 * way to exercise its baseline resolution was to build a repository with a
 * rewritten history. It is now a lib/ module whose outside world arrives as
 * `deps` — so every branch below runs in microseconds against a fake, and a
 * behavior change during the move would have to survive an assertion instead
 * of a reviewer's eyes.
 */

interface Fake {
  deps: ReviewPrepareToolDeps;
  tools: Map<string, (params: Record<string, unknown>) => Promise<ToolReply>>;
  order: string[];
  st: GateState;
  root: string;
  targets: PreparedReviewTarget[];
  persisted: string[];
  revs: Record<string, string>;
  ancestors: Set<string>;
  changed: string[];
  clean: boolean;
  goal: { confirmed: boolean; text: string; truncated: boolean };
  repo: { ok: boolean; error: string };
  files: Record<string, string>;
}

/** A gate state with a checkpoint on record — the normal precondition. */
function stateWithCheckpoint(overrides: Partial<GateState> = {}): GateState {
  const st = emptyState("sess-1", 10);
  st.checkpoint = { sha: "cccccccccccc", prevSha: "pppppppppppp", at: "2026-08-29T00:00:00.000Z" };
  return { ...st, ...overrides };
}

function round(verdict: RoundRecord["verdict"], n: number): RoundRecord {
  return { round: n, findingsTotal: 0, fingerprints: [], verdict, at: "2026-08-29T00:00:00.000Z" };
}

function fake(overrides: Partial<Fake> = {}): Fake {
  const root = mkdtempSync(join(tmpdir(), "rg-prepare-review-"));
  const state: Fake = {
    deps: undefined as unknown as ReviewPrepareToolDeps,
    tools: new Map(),
    order: [],
    st: stateWithCheckpoint(),
    root,
    targets: [],
    persisted: [],
    // HEAD differs from every baseline candidate, so the happy path is the default.
    revs: { HEAD: "hhhhhhhhhhhh", "HEAD^{tree}": "tttttttttttt", "cccccccccccc^": "pppppppppppp" },
    ancestors: new Set<string>(),
    changed: ["lib/a.ts", "lib/b.ts"],
    clean: true,
    goal: { confirmed: false, text: "", truncated: false },
    repo: { ok: true, error: "" },
    files: {},
    ...overrides,
  };
  state.deps = {
    resolveRepo: () => (state.repo.ok ? { ok: true, root: state.root } : { ok: false, error: state.repo.error }),
    stateFor: () => state.st,
    persist: (_ctx, r) => { state.persisted.push(r); },
    sessionDir: () => "/sessions/main",
    goalConfirmed: () => state.goal.confirmed,
    goalTextForReviewers: () => (state.goal.confirmed ? { text: state.goal.text, truncated: state.goal.truncated } : undefined),
    loopGoalPath: (r) => join(r, ".pi", "loop-goal.md"),
    reviewScope: () => decideReviewScope({}),
    previousRoundFindings: () => [],
    settledConclusion: () => undefined,
    registerReviewTarget: (_r, target) => { state.targets.push(target); },
    git: {
      isAncestor: (_r, maybeAncestor, branch) => state.ancestors.has(`${maybeAncestor}..${branch}`),
      revParse: (_r, rev) => {
        const v = state.revs[rev];
        if (v === undefined) throw new Error(`unknown rev ${rev}`);
        return v;
      },
      changedFilesInRange: () => state.changed,
      worktreeClean: () => state.clean,
    },
    readText: (p) => state.files[p],
  };
  const host: ToolHost = {
    registerTool: (definition) => {
      state.order.push(definition.name);
      state.tools.set(definition.name, (params) => definition.execute("id", params, undefined, undefined, undefined));
    },
  };
  registerReviewPrepareTools(host, state.deps);
  return state;
}

function cleanup(f: Fake): void {
  rmSync(f.root, { recursive: true, force: true });
}

function textOf(reply: ToolReply): string {
  return reply.content.map((c) => c.text).join("\n");
}

async function call(f: Fake, params: Record<string, unknown> = {}): Promise<ToolReply> {
  const run = f.tools.get("prepare_review");
  assert.ok(run, "prepare_review must be registered");
  return run(params);
}

test("the module registers exactly prepare_review", () => {
  const f = fake();
  assert.deepEqual(f.order, ["prepare_review"]);
  cleanup(f);
});

test("an unresolvable repo is reported, and nothing else happens", async () => {
  const f = fake();
  f.repo = { ok: false, error: "review-gate: which repo?" };
  const reply = await call(f);
  assert.equal(reply.isError, true);
  assert.equal(textOf(reply), "review-gate: which repo?");
  assert.deepEqual(f.targets, [], "a rejected call registers no review target");
  cleanup(f);
});


test("polish gate armed + no reason ⇒ refused WITHOUT building any task text", async () => {
  const f = fake();
  // Two consecutive READY rounds is the READY-streak trigger (lib/polish-gate.ts).
  f.st.rounds = [round("READY", 1), round("READY", 2)];
  const reply = await call(f);
  assert.equal(reply.isError, true);
  assert.equal(reply.details?.prepared, false);
  assert.equal(reply.details?.polishRequired, true);
  assert.ok(typeof reply.details?.why === "string" && (reply.details.why as string).length > 0);
  assert.match(textOf(reply), /prepare_review REFUSED/);
  assert.doesNotMatch(textOf(reply), /--- task text ---/, "a refusal renders no task text");
  assert.deepEqual(f.targets, [], "and registers no review target");
  assert.deepEqual(f.persisted, [], "and persists nothing");
  cleanup(f);
});

test("a blank reason does not satisfy the polish gate", async () => {
  const f = fake();
  f.st.rounds = [round("READY", 1), round("READY", 2)];
  const reply = await call(f, { reason: "   " });
  assert.equal(reply.isError, true);
  assert.equal(reply.details?.polishRequired, true);
  cleanup(f);
});

test("a supplied reason is trimmed, persisted BEFORE the task, and rides to the reviewer", async () => {
  const f = fake();
  f.st.rounds = [round("READY", 1), round("READY", 2)];
  const reply = await call(f, { reason: "  the user asked for a follow-up  " });
  assert.notEqual(reply.isError, true);
  assert.equal(reply.details?.prepared, true);
  assert.deepEqual(f.st.lastPolishReason, {
    reason: "the user asked for a follow-up",
    at: f.st.lastPolishReason!.at,
    round: 3,
  });
  assert.deepEqual(f.persisted, [f.root], "the reason is persisted for the next reviewer");
  cleanup(f);
});

test("the polish reason is NOT persisted when the gate is not armed", async () => {
  const f = fake();
  const reply = await call(f, { reason: "unsolicited" });
  assert.notEqual(reply.isError, true);
  assert.equal(f.st.lastPolishReason, undefined);
  assert.deepEqual(f.persisted, []);
  cleanup(f);
});

test("HEAD equal to the baseline is an empty range — accepted as an exit-goal audit", async () => {
  const f = fake();
  // prevSha becomes the baseline; make HEAD identical to it.
  f.revs.HEAD = "pppppppppppp";
  f.revs["HEAD^{tree}"] = "tttttttttttt";
  const reply = await call(f);
  assert.notEqual(reply.isError, true);
  assert.equal(reply.details?.prepared, true);
  assert.equal(reply.details?.range, "pppppppppppp..pppppppppppp");
  assert.equal(reply.details?.fileCount, 0);
  assert.deepEqual(reply.details?.files, []);
  assert.match(textOf(reply), /review round ready/);
  assert.match(textOf(reply), /0 file\(s\)/);
  // The task text tells the reviewer this round audits the EXIT GOAL.
  assert.match(textOf(reply), /EXIT GOAL is met/);
  // The empty-range round still registers a target (HEAD tree binding).
  assert.equal(f.targets.length, 1);
  cleanup(f);
});

test("empty range + dirty worktree ⇒ refused (round-2 P2: a READY must never bless unseen content)", async () => {
  const f = fake();
  f.revs.HEAD = "pppppppppppp";
  f.revs["HEAD^{tree}"] = "tttttttttttt";
  f.clean = false;
  const reply = await call(f);
  assert.equal(reply.isError, true);
  assert.equal(reply.details?.prepared, false);
  assert.equal(reply.details?.dirtyWorktree, true);
  assert.match(textOf(reply), /worktree is dirty/);
  assert.deepEqual(f.targets, [], "a refused round registers no review target");
  cleanup(f);
});

test("worktreeClean throwing is fail-closed — treated as NOT clean (round-4 P2)", async () => {
  const f = fake();
  f.revs.HEAD = "pppppppppppp";
  f.revs["HEAD^{tree}"] = "tttttttttttt";
  f.deps.git.worktreeClean = () => { throw new Error("git exploded"); };
  const reply = await call(f);
  assert.equal(reply.isError, true, "a throwing probe must refuse, never bless");
  assert.equal(reply.details?.prepared, false);
  assert.equal(reply.details?.dirtyWorktree, true);
  assert.match(textOf(reply), /dirty \(or unreadable\)/);
  assert.deepEqual(f.targets, [], "no target may be registered for a refused round");
  cleanup(f);
});

test("no checkpoint on record is allowed — an empty-range exit-goal audit", async () => {
  const f = fake();
  // Drop the checkpoint entirely; HEAD is the baseline, so the range is empty.
  f.st.checkpoint = undefined;
  const reply = await call(f);
  assert.notEqual(reply.isError, true);
  assert.equal(reply.details?.prepared, true);
  assert.equal(reply.details?.range, "hhhhhhhhhhhh..hhhhhhhhhhhh");
  assert.equal(reply.details?.fileCount, 0);
  assert.match(textOf(reply), /EXIT GOAL is met/);
  cleanup(f);
});

test("an unreadable HEAD fails the tool with the git error, not an exception", async () => {
  const f = fake();
  delete f.revs.HEAD;
  const reply = await call(f);
  assert.equal(reply.isError, true);
  assert.equal(reply.details?.prepared, false);
  assert.match(textOf(reply), /cannot read HEAD: unknown rev HEAD/);
  cleanup(f);
});

test("the happy path registers the reviewed range and reports it", async () => {
  const f = fake();
  const reply = await call(f);
  assert.notEqual(reply.isError, true);
  assert.equal(reply.details?.prepared, true);
  assert.equal(reply.details?.baseline, "pppppppppppp");
  assert.equal(reply.details?.head, "hhhhhhhhhhhh");
  assert.equal(reply.details?.range, "pppppppppppp..hhhhhhhhhhhh");
  assert.equal(reply.details?.fileCount, 2);
  assert.deepEqual(reply.details?.files, ["lib/a.ts", "lib/b.ts"]);
  // The target a READY later binds to carries the TREE, not just the commits.
  assert.deepEqual(f.targets, [{ baseline: "pppppppppppp", head: "hhhhhhhhhhhh", tree: "tttttttttttt" }]);
  // The findings stream is a real, created directory — an adviser or reviewer
  // appends to it while the round runs.
  const stream = String(reply.details?.stream);
  assert.match(stream, /\.pi\/review-stream\/review-[a-z0-9]+-review\.jsonl$/);
  assert.ok(existsSync(join(f.root, ".pi", "review-stream")), "the stream directory is created");
  assert.match(textOf(reply), /--- task text ---/, "the payload is delimited for the chain");
  cleanup(f);
});

test("a git failure listing the range is not fatal — an empty file list is still a round", async () => {
  const f = fake();
  f.deps.git.changedFilesInRange = () => { throw new Error("bad range"); };
  const reply = await call(f);
  assert.notEqual(reply.isError, true);
  assert.equal(reply.details?.fileCount, 0);
  assert.deepEqual(reply.details?.files, []);
  cleanup(f);
});

test("the baseline is the last REVIEWED commit when it is still an ancestor of HEAD", async () => {
  const f = fake();
  f.st.review = { verdict: "READY", fingerprint: "fp", at: "2026-08-29T00:00:00.000Z", commitSha: "rrrrrrrrrrrr" };
  f.ancestors.add("rrrrrrrrrrrr..HEAD");
  const reply = await call(f);
  assert.equal(reply.details?.baseline, "rrrrrrrrrrrr",
    "two checkpoints since the last READY must both stay inside the range");
  cleanup(f);
});

test("a READY commit that is NO LONGER an ancestor falls back rather than trusting it", async () => {
  const f = fake();
  f.st.review = { verdict: "READY", fingerprint: "fp", at: "2026-08-29T00:00:00.000Z", commitSha: "rrrrrrrrrrrr" };
  // Not registered as an ancestor ⇒ the chain was rewritten. The squash-point
  // search and the branch base both run against a repo with no such history,
  // so the resolution lands on the checkpoint parent — never on the stale sha.
  const reply = await call(f);
  assert.notEqual(reply.details?.baseline, "rrrrrrrrrrrr", "a rewritten chain never baselines on the stale READY");
  cleanup(f);
});

test("no prevSha falls back to the checkpoint's parent, and to the checkpoint itself when that fails", async () => {
  const f = fake();
  f.st.checkpoint = { sha: "cccccccccccc", prevSha: "", at: "2026-08-29T00:00:00.000Z" };
  const viaParent = await call(f);
  assert.equal(viaParent.details?.baseline, "pppppppppppp", "the parent is read from git");

  const g = fake();
  g.st.checkpoint = { sha: "cccccccccccc", prevSha: "", at: "2026-08-29T00:00:00.000Z" };
  delete g.revs["cccccccccccc^"]; // a root commit, or an unreachable sha
  const viaSelf = await call(g);
  assert.equal(viaSelf.details?.baseline, "cccccccccccc",
    "a root commit must not throw out of the tool");
  cleanup(f);
  cleanup(g);
});

test("a bypassed checkpoint is spelled out for the reviewer", async () => {
  const f = fake();
  f.st.checkpoint = { sha: "cccccccccccc", prevSha: "pppppppppppp", at: "2026-08-29T00:00:00.000Z", precommitBypassed: true };
  const reply = await call(f);
  assert.match(textOf(reply), /precommit 被用户的 `\/gate-bypass` 覆盖/,
    "the reviewer must know the full suite never ran on this content");
  cleanup(f);
});

test("a truncated goal is pointed at its file, an untruncated one is not", async () => {
  const f = fake();
  f.goal = { confirmed: true, text: "目标", truncated: true };
  const truncated = await call(f);
  assert.match(textOf(truncated), /loop goal 因长度被截断/);
  assert.match(textOf(truncated), /loop-goal\.md/);

  const g = fake();
  g.goal = { confirmed: true, text: "目标", truncated: false };
  const whole = await call(g);
  assert.doesNotMatch(textOf(whole), /loop goal 因长度被截断/);
  cleanup(f);
  cleanup(g);
});

test("precommitBaselineFor returns nothing when no PASS is on record", () => {
  const st = stateWithCheckpoint();
  assert.equal(precommitBaselineFor("/nonexistent-repo", st, () => undefined), undefined);
});
