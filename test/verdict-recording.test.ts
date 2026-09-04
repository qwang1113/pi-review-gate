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
    registerCommand: (name: string, def: { handler: (args: unknown, ctx: unknown) => unknown }) => commands.set(name, def),
  };
  return {
    ...pi,
    tools,
    handlers,
    commands,
    ctx: {
      hasUI: true,
      // `confirm` answers yes: the ONE dialog this fixture opens is the
      // user-authorized `/gate-bypass`, standing in for a precommit lane the
      // fixture repo has no checks to run.
      ui: { notify: () => {}, setStatus: () => {}, confirm: async () => true },
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

function sidecar(repo: string): { review: { verdict: string; docSync?: string }; rounds?: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(repo, ".pi", "review-gate-state.json"), "utf8"));
}

/**
 * Bring one repo to the state a real round reaches just before its verdict
 * lands: an edit, a checkpoint commit, and a registered `baseline..HEAD`
 * target. Without the target a READY has nothing to bind to and is withheld —
 * so this is what makes "READY was recorded" a meaningful assertion.
 */
async function preparedRepo(): Promise<{ repo: string; pi: ReturnType<typeof makeMockPi>; ctx: unknown }> {
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
  return { repo, pi, ctx };
}

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
