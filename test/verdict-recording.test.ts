import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync,
  copyFileSync, readdirSync, readFileSync, symlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { hermeticGitEnv } from "./helpers/git.ts";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

/**
 * THE OPENER RECORDS A STRUCTURED CONCLUSION — end to end, from a channel
 * `report` record to a READY in the sidecar.
 *
 * WHY THIS EXISTS (2026-09-04, and it is not hypothetical). While this very
 * change was being reviewed, four review rounds concluded — round 4 READY —
 * and the gate state stayed `review.verdict: PENDING`, `rounds: []`. Two
 * explanations were possible and they demand opposite actions:
 *
 *   (a) the NEW recording path drops the verdict on some branch (a P0 to fix);
 *   (b) the running opener PROCESS was the pre-change build, whose recorder
 *       still required prose to parse, so a summary-less report recorded
 *       nothing — a migration artifact of hot-changing the wire format under a
 *       live session, and nothing to fix in the delivered code.
 *
 * A hypothesis is not evidence, so this test settles it: it feeds the CURRENT
 * recorder a record whose shape is byte-for-byte the one round 4 actually
 * wrote (no `summary`, structured `findings`, `cwd`, `docSync`) and asserts a
 * recorded READY. It covers the spilled shape too, because an oversized
 * findings array leaves `findings` undefined and a `findingsRef` in its place
 * — the branch a reviewer would rightly ask about.
 *
 * If this test ever fails, the answer is (a) and the failure is the bug.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = mkdtempSync(join(tmpdir(), "rg-rec-install-"));
const TEST_HOME = mkdtempSync(join(tmpdir(), "rg-rec-HOME-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = TEST_HOME;
const dirs: string[] = [];

before(() => {
  mkdirSync(join(INSTALL, "extensions"), { recursive: true });
  mkdirSync(join(INSTALL, "lib"), { recursive: true });
  copyFileSync(join(ROOT, "extensions", "review-gate.ts"), join(INSTALL, "extensions", "review-gate.ts"));
  for (const f of readdirSync(join(ROOT, "lib"))) {
    copyFileSync(join(ROOT, "lib", f), join(INSTALL, "lib", f));
  }
  mkdirSync(join(INSTALL, "node_modules"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules", "typebox"), join(INSTALL, "node_modules", "typebox"));
  // A STAND-IN FOR THE TRUSTED RUNNER (2026-09-15). `resolveTrustedRunner`
  // looks beside the EXTENSION (the package layout), and this fixture is a
  // copied package — so without one here the lane cannot run at all, and the
  // one behaviour that needs a lane actually in flight (a READY that outruns
  // its verification) would have no end-to-end test. It prints the single
  // sentinel the gate parses and writes a receipt that satisfies
  // `validatePrecommitReceipt`; the delay, read from the environment, is what
  // makes "the lane is still running" a window a test can act inside.
  mkdirSync(join(INSTALL, "scripts"), { recursive: true });
  writeFileSync(join(INSTALL, "scripts", "precommit-runner.mjs"), `
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ""; };
const delay = Number(process.env.RG_FAKE_RUNNER_DELAY_MS ?? "0");
await new Promise((r) => setTimeout(r, Number.isFinite(delay) ? delay : 0));
process.stdout.write("## Overall: ✅ PASS\\n");
const receipt = arg("--receipt");
if (receipt) {
  writeFileSync(receipt, JSON.stringify({
    schema: 1,
    nonce: arg("--nonce"),
    cwd: arg("--cwd"),
    mode: arg("--mode"),
    verdict: "PASS",
    testScope: "full",
    checksRun: 1,
    checksFailed: 0,
  }));
}
process.exit(0);
`);
});
after(() => {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  for (const d of [INSTALL, TEST_HOME, ...dirs]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const { default: reviewGate } = await import(join(INSTALL, "extensions", "review-gate.ts"));
const { reportConclusion } = await import(join(INSTALL, "lib", "orchestrator-channel.ts"));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: hermeticGitEnv() }).trim();
}

function makeRepo(): string {
  const parent = mkdtempSync(join(tmpdir(), "rg-rec-"));
  dirs.push(parent);
  const root = join(parent, "repo");
  git(parent, "init", "-b", "feat/x", "repo");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Gate Test");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, "add", "a.ts");
  git(root, "commit", "-m", "init");
  return realpathSync(root);
}

type Exec = (id: string, params: unknown, s: unknown, u: unknown, c: unknown) => Promise<unknown>;

interface Recorders {
  recordReviewVerdict: (concluded: unknown, repo: string, ctx: unknown) => Promise<string>;
  recordQualityVerdict: (concluded: unknown, repo: string, ctx: unknown) => Promise<string | undefined>;
}

function makeMockPi(cwd: string) {
  const tools = new Map<string, { execute: Exec }>();
  const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: unknown, ctx: unknown) => unknown }>();
  const pi = {
    registerTool: (t: { name: string }) => tools.set(t.name, t as unknown as { execute: Exec }),
    on: (ev: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(ev, h),
    appendEntry: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    registerMarkdownTransformer: () => {},
    registerCommand: (name: string, def: { handler: (args: unknown, ctx: unknown) => unknown }) => commands.set(name, def),
  };
  return {
    ...pi,
    tools,
    handlers,
    commands,
    ctx: {
      hasUI: true,
      // `select` picks the first row: the ONE dialog this fixture opens is the
      // user-authorized `/gate-bypass`, standing in for a precommit lane the
      // fixture repo has no checks to run.
      ui: { notify: () => {}, setStatus: () => {}, select: async (_t: string, options: string[]) => options[0] },
      sessionManager: { getEntries: () => [], getSessionId: () => "rec-session-1" },
      isIdle: () => false,
      get cwd() { return cwd; },
    },
  };
}

function internalTool(pi: unknown, name: string): Exec {
  const map = (pi as { __reviewGateInternalTools?: Map<string, Exec> }).__reviewGateInternalTools;
  const run = map?.get(name);
  assert.ok(run, `internal implementation ${name} must exist`);
  return run!;
}

function recorders(pi: unknown): Recorders {
  const r = (pi as { __reviewGateRecorders?: Recorders }).__reviewGateRecorders;
  assert.ok(r, "the extension must expose its recorders on the test seam");
  return r!;
}

/** The gate's own background lane, exposed for the one test that needs it. */
function seams(pi: unknown): { startFullLane: (root: string, ctx: unknown) => Promise<void> } {
  const s = (pi as { __reviewGateTestSeams?: { startFullLane: (root: string, ctx: unknown) => Promise<void> } })
    .__reviewGateTestSeams;
  assert.ok(s, "the extension must expose the lane on the test seam");
  return s!;
}

function sidecar(repo: string): {
  review: { verdict: string; fingerprint?: string | null; docSync?: string };
  rounds?: Array<Record<string, unknown>>;
  pendingReady?: {
    conclusion: { verdict: string; findings: unknown[] };
    tree: string;
    head: string;
    round: number;
    at: string;
  };
  lastReadyReview?: unknown;
} {
  return JSON.parse(readFileSync(join(repo, ".pi", "review-gate-state.json"), "utf8"));
}

/**
 * Bring one repo to the state a real round reaches just before its verdict
 * lands: an edit, a checkpoint commit, and a registered `baseline..HEAD`
 * target. Without the target a READY has nothing to bind to and is withheld —
 * so this is what makes "READY was recorded" a meaningful assertion.
 */
async function preparedRepo(recordQualityPass = true): Promise<{ repo: string; pi: ReturnType<typeof makeMockPi>; ctx: unknown }> {
  const repo = makeRepo();
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const ctx = pi.ctx;
  await pi.handlers.get("session_start")!({}, ctx);
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
  await pi.handlers.get("tool_result")!(
    { toolName: "edit", isError: false, input: { path: join(repo, "a.ts") }, content: [] }, ctx,
  );
  // The checkpoint's OTHER prerequisite is a precommit PASS, which would mean
  // spawning the real runner in a fixture that has no checks to run. The
  // user-authorized bypass is the sanctioned way past it and touches nothing
  // this test is about: the recorder reads the report, not the precommit lane.
  await pi.commands.get("gate-bypass")!.handler("fixture: recorder test, precommit lane is not under test", ctx);
  const checkpoint = await internalTool(pi, "review_checkpoint")(
    "id", { message: "chore: checkpoint", repo }, undefined, undefined, ctx,
  ) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(checkpoint.isError, undefined, `checkpoint failed: ${checkpoint.content?.[0]?.text}`);
  const prepared = await internalTool(pi, "prepare_review")(
    "id", { repo }, undefined, undefined, ctx,
  ) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(prepared.isError, undefined, `prepare failed: ${prepared.content?.[0]?.text}`);
  // THE QUALITY ROUND OF THIS ROUND HAS PASSED (2026-09-16). `recordReviewVerdict`
  // refuses a functional READY that no quality standing covers, so a fixture
  // that wants to exercise the FUNCTIONAL recorder has to model the round the
  // parallel chain produces: the quality judge concluded READY for this exact
  // head a moment before the reviewer's own report arrives. `recordQualityPass:
  // false` is the OTHER half — the refusal the parallel design introduced.
  if (recordQualityPass) {
    const quality = await recorders(pi).recordQualityVerdict(
      { verdict: "READY", findings: [], cwd: repo, docSync: "NOT_NEEDED" }, repo, ctx,
    );
    assert.match(String(quality), /质量轮记录 READY/, `quality fixture failed: ${quality}`);
  }
  return { repo, pi, ctx };
}

/**
 * A repo prepared WITHOUT the bypass (2026-09-15).
 *
 * The other tests here need the real precommit lane out of the way, and the
 * bypass is the sanctioned way past it — but a bypass is ALSO exactly what
 * makes `readyLacksVerification` return false, so that fixture can never reach
 * the case this one exists for: a reviewer that concludes before its lane
 * lands. This one commits through git directly (the checkpoint tool is not
 * what is under test) and leaves `precommit` at NOT_RUN with no full-lane tree
 * on record — the state a round is in when the lane is still running.
 */
async function preparedRepoBeforeItsLane(): Promise<{
  repo: string;
  pi: ReturnType<typeof makeMockPi>;
  ctx: unknown;
}> {
  const repo = makeRepo();
  const pi = makeMockPi(repo);
  reviewGate(pi as never);
  const ctx = pi.ctx;
  await pi.handlers.get("session_start")!({}, ctx);
  // The gate writes its sidecar under `.pi/`, and this fixture commits through
  // git by hand: without the ignore, the gate's own state makes the worktree
  // dirty and `prepare_review` refuses the round before anything can be tested.
  writeFileSync(join(repo, ".gitignore"), ".pi/\n");
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "feat: change");
  const prepared = await internalTool(pi, "prepare_review")("id", { repo }, undefined, undefined, ctx) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  assert.equal(prepared.isError, undefined, `prepare failed: ${prepared.content?.[0]?.text}`);
  return { repo, pi, ctx };
}

test("a READY with no full-lane PASS and NO lane running is REFUSED, not held (round-1 P1)", async () => {
  // The hold is only legitimate while something can still come back for the
  // conclusion — the lane's own landing, or the next round's prepare. With no
  // lane in flight, parking it would stop the round forever (nothing else ever
  // revisits a parked conclusion) while the reply told the agent NOT to
  // re-submit. This fixture has no lane running, so it IS that case.
  const { repo, pi, ctx } = await preparedRepoBeforeItsLane();
  const concluded = reportConclusion(readerIO(new Map()), reportRecord(repo, { findings: [], findingsCount: 0 }));

  const text = await recorders(pi).recordReviewVerdict(concluded, repo, ctx);

  assert.match(text, /recorded verdict BLOCKED/, text);
  assert.match(text, /UNVERIFIED/, "the reply names verification as the reason, not findings");
  assert.doesNotMatch(text, /不要重跑/,
    "and it must never tell the agent to wait for a lane that is not running");
  const st = sidecar(repo);
  assert.equal(st.review.verdict, "BLOCKED", "refused, exactly as before this mechanism existed");
  assert.equal(st.pendingReady, undefined, "nothing is parked");
  assert.equal(st.rounds?.length, 1, "and the round is recorded as it always was");
});

test("a READY that outruns its lane is HELD, and that lane's own landing replays it (2026-09-15)", async () => {
  const { repo, pi, ctx } = await preparedRepoBeforeItsLane();
  const judgeScope = { range: "deadbeef..cafebabe", kind: "incremental" };
  const concluded = reportConclusion(
    readerIO(new Map()),
    reportRecord(repo, { findings: [], findingsCount: 0, scope: judgeScope }),
  );

  // Start the lane the way `judge_submit` does, and record the verdict while it
  // is STILL RUNNING — the measured race (16s of review against a 34s lane,
  // seven seconds short) reproduced on purpose.
  process.env.RG_FAKE_RUNNER_DELAY_MS = "250";
  const lane = seams(pi).startFullLane(repo, ctx);
  try {
    const text = await recorders(pi).recordReviewVerdict(concluded, repo, ctx);
    assert.match(text, /HELD/, `the round must be held, not refused: ${text}`);
    assert.match(text, /不要重跑/, "and the agent is told not to burn a round on identical content");
    assert.match(text, /作废/, "…and what the THIRD ending looks like: an edit during the lane voids the hold");
    // The correction matters as much as the endings: the first wording told the
    // agent an edit voids the hold, which is the opposite of what this gate
    // wants it to keep doing during a review (round-3 P2).
    assert.match(text, /照常编辑工作区/, "…and that editing during the lane does NOT void it");
    const held = sidecar(repo);
    assert.equal(held.review.verdict, "PENDING", "nothing ships on a verdict that was never made");
    assert.equal(held.pendingReady?.conclusion.verdict, "READY");
    assert.equal(held.rounds?.length ?? 0, 0, "and the round does not join the history yet");
  } finally {
    await lane;
    delete process.env.RG_FAKE_RUNNER_DELAY_MS;
  }

  // The lane landed PASS on that very tree: the gate replays the conclusion
  // through the SAME recorder, so the round ends as the READY it always was —
  // no re-submission, and no second implementation of the recording rules.
  const st = sidecar(repo);
  assert.equal(st.pendingReady, undefined, "a replayed conclusion is not left parked");
  assert.equal(st.review.verdict, "READY", "the held round lands as the READY it always was");
  assert.equal(st.rounds?.length, 1, "and joins the round history exactly as it would have");

  // CONTROL — exit-goal criterion 2: the SAME conclusion recorded straight
  // through (no hold in the way) leaves the same record. A second
  // implementation of the recording rules is what this comparison would fail.
  const direct = await preparedRepoBeforeItsLane();
  await direct.pi.commands.get("gate-bypass")!.handler("fixture: control", direct.ctx);
  const controlConclusion = reportConclusion(
    readerIO(new Map()),
    reportRecord(direct.repo, { findings: [], findingsCount: 0, scope: judgeScope }),
  );
  assert.deepEqual(controlConclusion.scope, judgeScope, "the fixture's scope must survive reportConclusion");
  await recorders(direct.pi).recordReviewVerdict(controlConclusion, direct.repo, direct.ctx);
  const straight = sidecar(direct.repo);
  assert.equal(straight.review.verdict, "READY", "the control must reach READY, or it proves nothing");
  assert.equal(st.review.verdict, straight.review.verdict);
  assert.equal(st.review.fingerprint, straight.review.fingerprint,
    "both bind to the reviewed TREE — not to a timestamp or a sha");
  assert.equal(st.review.docSync, straight.review.docSync);
  assert.deepEqual(st.rounds?.[0]?.fingerprints, straight.rounds?.[0]?.fingerprints);
  assert.equal(st.rounds?.[0]?.verdict, straight.rounds?.[0]?.verdict);
  assert.equal(st.rounds?.[0]?.findingsTotal, straight.rounds?.[0]?.findingsTotal);
  // The AUDIT PAIR's judged half is where a dropped `scope` would have shown up
  // (round-1 P2): the parked record carries it, so the replayed round states
  // what its reviewer read, exactly as a straight one does.
  const heldScope = st.rounds?.[0]?.scope as { reported?: unknown } | undefined;
  const straightScope = straight.rounds?.[0]?.scope as { reported?: unknown } | undefined;
  assert.deepEqual(heldScope?.reported, straightScope?.reported);
  assert.deepEqual(heldScope?.reported, judgeScope, "and it is the judge's own scope, not a placeholder");
});

test("…and a round whose verification is already satisfied records its READY straight through", async () => {
  // The other half of the pair: with no hold in the way (here the user's own
  // `/gate-bypass` stands in for a satisfied verification — the fixture repo has
  // no precommit runner to run), the very same conclusion is recorded as it
  // always was. The HOLD-and-replay path itself is judged by
  // `parkedReadyFate` (pure, in test/review-adjudicate.test.ts) and by the lane
  // callback's structure in test/extension-structure.test.ts: this fixture
  // cannot start a real lane, so a held round cannot be produced here.
  const { repo, pi, ctx } = await preparedRepoBeforeItsLane();
  await pi.commands.get("gate-bypass")!.handler("fixture: verification is not under test here", ctx);
  const concluded = reportConclusion(readerIO(new Map()), reportRecord(repo, { findings: [], findingsCount: 0 }));

  const text = await recorders(pi).recordReviewVerdict(concluded, repo, ctx);

  assert.match(text, /recorded verdict READY/, text);
  const st = sidecar(repo);
  assert.equal(st.review.verdict, "READY");
  assert.equal(st.pendingReady, undefined, "nothing is ever parked on the straight-through path");
  assert.equal(st.rounds?.length, 1, "the round joins the history exactly as it would have");
  assert.equal(st.rounds?.[0]?.findingsTotal, 0);
});

/** The EXACT record shape a reviewer round writes today (round 4, verbatim). */
function reportRecord(repo: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reportId: "rep-mtn939uk-ar89l2",
    kind: "report",
    from: "child",
    at: "2026-09-04T17:51:29.180Z",
    round: 4,
    verdict: "READY",
    findingsCount: 3,
    findings: [
      {
        severity: "P2",
        file: "test/gate-state.test.ts",
        line: 660,
        issue: "两条行内注释仍把已删除的去重机制说成现状。",
        evidence: ":660「// what a deduplicated repeated-fence round yields」",
      },
    ],
    cwd: repo,
    docSync: "UPDATED",
    ...over,
  };
}

/** A read-only ChannelIO over an in-memory file map (resolves spill files). */
function readerIO(files: Map<string, string>) {
  return {
    ensureDir() {}, appendLine() {}, writeText() {}, now: () => 1,
    readText: (p: string) => files.get(p),
  };
}

test("a functional READY with NO quality standing is REFUSED, never recorded (2026-09-16)", async () => {
  // THE REFUSAL THE PARALLEL DESIGN INTRODUCES, and the reason it is safe to let
  // both judges start together: what the quality round gates moved from the
  // DISPATCH to the RECORD. A standing that is absent while no quality judge is
  // left to deliver one means nobody is coming back — fail closed (exactly the
  // `unverified-idle` rule). A standing that is absent while this round's
  // quality judge is still running HOLDS the conclusion instead, which needs a
  // live pane and is covered by `decideQualityHold` (pure, in
  // test/quality-round.test.ts) and by the wiring pins in
  // test/extension-structure.test.ts.
  const { repo, pi, ctx } = await preparedRepo(false);
  const concluded = reportConclusion(readerIO(new Map()), reportRecord(repo, { findings: [], findingsCount: 0 }));

  const text = await recorders(pi).recordReviewVerdict(concluded, repo, ctx);

  assert.match(text, /recorded verdict BLOCKED/, `the READY must be refused, not recorded: ${text}`);
  assert.match(text, /QUALITY PRECONDITION/, "…and the agent is told WHICH binding failed");
  assert.equal(sidecar(repo).review.verdict, "BLOCKED", "nothing a quality round never passed may ship");
});

test("the opener records a READY from a summary-less structured report (round 4's exact shape)", async () => {
  const { repo, pi, ctx } = await preparedRepo();
  assert.equal(sidecar(repo).review.verdict, "PENDING", "nothing is recorded before the round lands");

  const record = reportRecord(repo);
  assert.equal((record as { summary?: string }).summary, undefined,
    "the fixture must carry NO prose — that is the whole point of the shape under test");

  const concluded = reportConclusion(readerIO(new Map()), record);
  const text = await recorders(pi).recordReviewVerdict(concluded, repo, ctx);

  assert.match(text, /recorded verdict READY/, `the recorder must report what it did: ${text}`);
  const st = sidecar(repo);
  assert.equal(st.review.verdict, "READY", "a summary-less report must still record its verdict");
  assert.equal(st.review.docSync, "UPDATED", "the attestation travels with the verdict it came from");
  assert.equal(st.rounds?.length, 1, "the round joins the history plateau detection reads");
  assert.equal(st.rounds?.[0]?.verdict, "READY");
  assert.equal(st.rounds?.[0]?.findingsTotal, 1);
  assert.deepEqual(st.rounds?.[0]?.polishFiles, ["test/gate-state.test.ts"],
    "the per-file polish data comes off the structured findings");
});

test("…and from the SPILLED shape, where the findings live in a side file", async () => {
  const { repo, pi, ctx } = await preparedRepo();
  // An oversized findings array leaves the record with `findingsRef` and no
  // `findings` at all — the branch that would silently record zero findings if
  // the reader did not resolve it.
  const findings = [
    { severity: "P1", file: "lib/a.ts", line: 12, issue: "边界未处理" },
    { severity: "P2", file: "lib/b.ts", line: 40, issue: "措辞" },
  ];
  const files = new Map<string, string>([["/spill/rep.findings", JSON.stringify(findings)]]);
  const record = reportRecord(repo, {
    verdict: "BLOCKED", // a P1 is open, so this is what an honest round reports
    findings: undefined,
    findingsRef: { path: "/spill/rep.findings", chars: 999 },
  });
  delete (record as Record<string, unknown>).findings;

  const concluded = reportConclusion(readerIO(files), record);
  assert.equal(concluded.findings.length, 2, "the spill must be resolved before recording");
  const text = await recorders(pi).recordReviewVerdict(concluded, repo, ctx);

  assert.match(text, /recorded verdict BLOCKED/, text);
  const st = sidecar(repo);
  assert.equal(st.review.verdict, "BLOCKED");
  assert.equal(st.rounds?.[0]?.findingsTotal, 2, "a spilled round records its real finding count");
  assert.deepEqual(st.rounds?.[0]?.blockingFiles, ["lib/a.ts"]);
});

test("an empty findings array records a clean READY — it is not mistaken for 'nothing to record'", async () => {
  const { repo, pi, ctx } = await preparedRepo();
  const concluded = reportConclusion(readerIO(new Map()), reportRecord(repo, { findings: [], findingsCount: 0 }));
  const text = await recorders(pi).recordReviewVerdict(concluded, repo, ctx);
  assert.match(text, /recorded verdict READY/, text);
  const st = sidecar(repo);
  assert.equal(st.review.verdict, "READY");
  assert.equal(st.rounds?.[0]?.findingsTotal, 0);
});

test("a report the gate cannot read a verdict from records NOTHING (fail-closed)", async () => {
  const { repo, pi, ctx } = await preparedRepo();
  const concluded = reportConclusion(readerIO(new Map()), reportRecord(repo, { verdict: "" }));
  const text = await recorders(pi).recordReviewVerdict(concluded, repo, ctx);
  assert.match(text, /没有可识别的 verdict/, text);
  assert.equal(sidecar(repo).review.verdict, "PENDING", "the gate stays shut rather than guessing");
  assert.equal(sidecar(repo).rounds?.length ?? 0, 0);
});

/*
 * THE TWO BINDINGS A READY HANGS ON — pinned because the 2026-09-05 audit-round
 * convergence MOVED the call site that reaches this recorder (the settle path
 * and judge_wait both go through `settleAuditRound` now). The recorder's body
 * was deliberately left untouched; these two tests are what proves the move
 * did not change what a READY means. They also cannot be checked by the
 * session doing the refactor — it runs the extension that was loaded at
 * startup — so a unit test is the only place they can live.
 */

test("BINDING (a): a READY whose HEAD moved after prepare is recorded as BLOCKED", async () => {
  const { repo, pi, ctx } = await preparedRepo();
  // A second checkpoint lands after prepare_review registered the target —
  // exactly what happens when the agent keeps fixing while the review runs.
  // The reviewer judged the OLDER commit, so its READY cannot bind to what is
  // in place now.
  writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "chore: a later commit the reviewer never saw");

  const concluded = reportConclusion(readerIO(new Map()), reportRecord(repo));
  const text = await recorders(pi).recordReviewVerdict(concluded, repo, ctx);

  assert.match(text, /recorded verdict BLOCKED/, text);
  assert.match(text, /STALE TARGET/, "the agent is told WHY its READY became a BLOCKED");
  const st = sidecar(repo);
  assert.equal(st.review.verdict, "BLOCKED", "unreviewed content can never ship on someone else's READY");
  assert.equal((st.review as { fingerprint?: string | null }).fingerprint, null,
    "a withheld READY binds to nothing");
});

test("BINDING (b): a recorded READY binds to the reviewed commit's TREE", async () => {
  const { repo, pi, ctx } = await preparedRepo();
  const reviewedTree = git(repo, "rev-parse", "HEAD^{tree}");
  const reviewedHead = git(repo, "rev-parse", "HEAD");

  const concluded = reportConclusion(readerIO(new Map()), reportRecord(repo));
  const text = await recorders(pi).recordReviewVerdict(concluded, repo, ctx);

  assert.match(text, /recorded verdict READY/, text);
  const st = sidecar(repo) as unknown as {
    review: { verdict: string; fingerprint?: string | null; commitSha?: string };
    lastReadyReview?: { treeOid?: string };
  };
  // CONTENT binding, not commit binding: a squash rewrites the sha and
  // preserves the tree, so this is what survives one.
  assert.equal(st.review.fingerprint, reviewedTree, "the READY binds to the reviewed TREE");
  assert.equal(st.review.commitSha, reviewedHead, "…and remembers the commit it came from, for the next baseline");
  assert.equal(st.lastReadyReview?.treeOid, reviewedTree, "the incremental baseline moves to that same tree");
});

// The cwd check is the third thing a READY must satisfy, and it is checked in
// the same place — a round recorded against the wrong repository is BLOCKED.
test("BINDING (c): a READY that reports someone else's cwd is recorded as BLOCKED", async () => {
  const { repo, pi, ctx } = await preparedRepo();
  const concluded = reportConclusion(readerIO(new Map()), reportRecord(repo, { cwd: "/evil/elsewhere" }));
  const text = await recorders(pi).recordReviewVerdict(concluded, repo, ctx);
  assert.match(text, /recorded verdict BLOCKED/, text);
  assert.match(text, /CWD CHECK FAILED/, text);
  assert.equal(sidecar(repo).review.verdict, "BLOCKED");
});

