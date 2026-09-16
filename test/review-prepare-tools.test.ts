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
import type { ChangeIndexRow } from "../lib/parallel-review.ts";
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
  /**
   * What `merge-base <default branch> HEAD` resolves to. Undefined is the
   * "this repo names no default branch" case — the fallback that keeps the
   * empty range.
   */
  branchBase?: string;
  /** What the squash-point search resolves to (a rewritten reviewed chain). */
  squashPoint?: string;
  /** Overrides the numstat rows the change index is built from. */
  numstat?: ChangeIndexRow[];
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
    // The branch's own base. Same value as the checkpoint's parent by default,
    // so an expectation that did not care WHICH of the two it was keeps
    // holding — and the cases where it matters set it explicitly.
    branchBase: "pppppppppppp",
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
      // Same files as `changed`, with sizes so the change index has something
      // to batch. Tests that want the index path exercise it directly; tests
      // that want the FALLBACK throw from here.
      numstatInRange: () =>
        (state.numstat ?? state.changed.map((file, i) => ({ file, added: 10 + i, deleted: i }))),
      branchBaseBaseline: () => state.branchBase,
      squashPointBaseline: () => state.squashPoint,
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
  assert.match(textOf(reply), /What this round judges is the EXIT GOAL/);
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

test("no checkpoint on record, and no branch base to compare against — still an empty-range exit-goal audit", async () => {
  const f = fake();
  // Drop the checkpoint entirely, and let `merge-base <default branch> HEAD`
  // resolve nothing (a repo with no remote and no main/master). The gate has
  // no basis to claim anything about the branch, so the round stays the
  // exit-goal audit it has always been.
  f.st.checkpoint = undefined;
  f.branchBase = undefined;
  const reply = await call(f);
  assert.notEqual(reply.isError, true);
  assert.equal(reply.details?.prepared, true);
  assert.equal(reply.details?.range, "hhhhhhhhhhhh..hhhhhhhhhhhh");
  assert.equal(reply.details?.fileCount, 0);
  assert.match(textOf(reply), /What this round judges is the EXIT GOAL/);
  cleanup(f);
});

test("no checkpoint on record but the BRANCH carries commits ⇒ the range is the branch base..HEAD", async () => {
  const f = fake();
  // THE REGRESSION THIS PINS (2026-09-15): a session that never checkpointed
  // still sits on a branch holding whatever was committed before it — by
  // another session, or by the agent's own `git commit`. Calling that "no code
  // change to audit" is what made a 18-file delivery reach its reviewer as an
  // empty-range exit-goal round.
  f.st.checkpoint = undefined;
  f.branchBase = "bbbbbbbbbbbb";
  const reply = await call(f);
  assert.notEqual(reply.isError, true);
  assert.equal(reply.details?.baseline, "bbbbbbbbbbbb", "the branch base is the baseline when no checkpoint exists");
  assert.equal(reply.details?.range, "bbbbbbbbbbbb..hhhhhhhhhhhh");
  assert.equal(reply.details?.fileCount, 2, "the real file list reaches the CHANGE INDEX");
  assert.doesNotMatch(textOf(reply), /NO new commits are under review/, "a non-empty range is not worded as an empty one");
  cleanup(f);
});

test("a rewritten chain resolves through the squash point when the seam yields one", async () => {
  const f = fake();
  f.st.review = { verdict: "READY", fingerprint: "fp", at: "2026-08-29T00:00:00.000Z", commitSha: "rrrrrrrrrrrr" };
  // Not an ancestor ⇒ rewritten history; the content the READY was bound to
  // lives at the squash point, which is the baseline the next range starts at.
  f.squashPoint = "ssssssssssss";
  const reply = await call(f);
  assert.equal(reply.details?.baseline, "ssssssssssss");
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
  // LARGEST FIRST — the same order the change index renders in and the batch
  // plan is built from (the fake's sizes are a.ts +10/−0, b.ts +11/−1). A
  // `files` list in a different order than the plan built from it would be two
  // answers to one question.
  assert.deepEqual(reply.details?.files, ["lib/b.ts", "lib/a.ts"]);
  // The target a READY later binds to carries the TREE, not just the commits —
  // plus the scope this round was DISPATCHED under, which is the gate's half
  // of the audit pair the verdict recorder writes down (t6a). It is registered
  // here, at dispatch time, because the decision is a function of a worktree
  // that keeps moving while the reviewer works.
  assert.deepEqual(f.targets, [{
    baseline: "pppppppppppp",
    head: "hhhhhhhhhhhh",
    tree: "tttttttttttt",
    scope: { range: "pppppppppppp..hhhhhhhhhhhh", kind: "full" },
    // The changed files ride the target: the quality precondition is decided
    // at DISPATCH time and must not re-run `git diff` to learn what this round
    // touched (2026-09-15).
    files: ["lib/b.ts", "lib/a.ts"],
  }]);
  // The findings stream is a real, created directory — an adviser or reviewer
  // appends to it while the round runs.
  const stream = String(reply.details?.stream);
  assert.match(stream, /\.pi\/review-stream\/review-[a-z0-9]+-review\.jsonl$/);
  assert.ok(existsSync(join(f.root, ".pi", "review-stream")), "the stream directory is created");
  // THE QUALITY ROUND'S BRIEF IS BUILT IN THE SAME PASS (2026-09-15): the
  // routing rule decides whether it is dispatched, but the task text and its
  // own findings stream have to exist for that route to have something to
  // send — and building them here is what keeps `git numstat` to ONE read per
  // round. A prepare that quietly stopped producing them would make every code
  // round un-dispatchable (the chain fails closed rather than sending a judge
  // with no brief), so it is asserted, not assumed.
  const qualityTask = String(reply.details?.qualityTask ?? "");
  assert.match(qualityTask, /docs\/code-quality-rules\.md/, "the quality brief points at the checklist");
  assert.match(qualityTask, /pppppppppppp\.\.hhhhhhhhhhhh/, "…carries the same immutable range");
  assert.match(qualityTask, /ask_user/, "…and the scope-question rule");
  assert.doesNotMatch(qualityTask, /Review for: correctness/, "never the functional brief");
  const qualityStream = String(reply.details?.qualityStream ?? "");
  assert.match(qualityStream, /\.pi\/review-stream\/review-[a-z0-9]+-quality\.jsonl$/, "its own findings stream");
  assert.ok(existsSync(join(f.root, ".pi", "review-stream")), "…whose directory exists");
  assert.match(textOf(reply), /--- task text ---/, "the payload is delimited for the chain");
  cleanup(f);
});

test("a git failure listing the range is not fatal — an empty file list is still a round", async () => {
  const f = fake();
  f.deps.git.numstatInRange = () => { throw new Error("bad range"); };
  f.deps.git.changedFilesInRange = () => { throw new Error("bad range"); };
  const reply = await call(f);
  assert.notEqual(reply.isError, true);
  assert.equal(reply.details?.fileCount, 0);
  assert.deepEqual(reply.details?.files, []);
  cleanup(f);
});

test("numstat is preferred; a failed numstat still leaves the plain file list", async () => {
  const f = fake();
  f.deps.git.numstatInRange = () => { throw new Error("bad range"); };
  const reply = await call(f);
  assert.notEqual(reply.isError, true);
  assert.deepEqual(reply.details?.files, ["lib/a.ts", "lib/b.ts"],
    "the name-only read stands in when the sizes cannot be read");
  const task = textOf(reply);
  assert.match(task, /Changed files \(2\)/, "…and the task text falls back to the bare list");
  assert.doesNotMatch(task, /CHANGE INDEX/);
  cleanup(f);
});

test("the reviewer's task text carries the CHANGE INDEX, batches and all", async () => {
  const f = fake();
  const reply = await call(f);
  const task = textOf(reply);
  assert.match(task, /CHANGE INDEX — 2 file\(s\), \+21\/−1 in/,
    "what moved, with sizes, in one place");
  assert.match(task, /git diff \S+ -- 'lib\/b\.ts' 'lib\/a\.ts'/,
    "the batch is a command, not advice — QUOTED, and largest-first (b.ts has more lines than a.ts)");
  assert.match(task, /IN PARALLEL/, "the parallel-read rule travels with the plan");
  assert.doesNotMatch(task, /Changed files \(2\)/, "the bare list is a second, poorer copy of the same fact");
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

test("the baseline is the last CONCLUDED round — and the branch base when there is none", async () => {
  // 2026-09-16. The fallback used to be the newest checkpoint's parent, which
  // moved the baseline PAST any round that produced no conclusion at all — a
  // re-submit that interrupted it, a precommit FAIL, a crash. Measured that
  // day: a whole round's changes (d28714e..a70f2a1) dropped out of every later
  // range while the gate went on believing the chain was reviewed.
  const f = fake();
  // The fixture's DEFAULT gives `branchBase` and the checkpoint's `prevSha` the
  // same value, so older expectations keep holding — which would also make THIS
  // case pass with the old fallback restored (round-1 review P2, 2026-09-16).
  // They are pulled apart here so the assertion can actually fail.
  f.branchBase = "bbbbbbbbbbbb";
  assert.equal((await call(f)).details?.baseline, "bbbbbbbbbbbb",
    "no verdict at all ⇒ the branch base, never the checkpoint's parent");
  cleanup(f);

  // A BLOCKED round is a round that CONCLUDED: the next range starts where it
  // left off, so the reviewer is not made to re-read what a round already
  // judged. (This is the half that only READY used to record.)
  const g = fake();
  g.st.review = { verdict: "BLOCKED", fingerprint: "tttttttttttt", at: "2026-08-29T00:00:00.000Z", commitSha: "cccccccccccc" };
  g.ancestors.add("cccccccccccc..HEAD");
  assert.equal((await call(g)).details?.baseline, "cccccccccccc",
    "a concluded (BLOCKED) round's commit is the baseline");
  cleanup(g);

  // An unreadable verdict (an older sidecar) degrades to the branch base too:
  // "I cannot tell what was concluded" must not read as "everything was".
  const h = fake();
  h.st.review = { verdict: "BLOCKED", fingerprint: "tttttttttttt", at: "2026-08-29T00:00:00.000Z" };
  assert.equal((await call(h)).details?.baseline, "pppppppppppp");
  cleanup(h);

  // …and when git cannot NAME a base at all (no remote, no main, no master —
  // every sandbox, and a real shape for a local-only repo), the checkpoint's
  // own parent is the fallback. An EMPTY range is not the safe answer here:
  // it demands a clean worktree and then blesses nothing.
  const k = fake();
  k.branchBase = undefined;
  assert.equal((await call(k)).details?.baseline, "pppppppppppp",
    "no branch base ⇒ the checkpoint's parent, never an empty range");
  cleanup(k);
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
