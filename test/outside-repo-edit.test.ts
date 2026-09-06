import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync,
  copyFileSync, readdirSync, symlinkSync, readFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { hermeticGitEnv } from "./helpers/git.ts";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

// Same reason as multi-repo-gate.test.ts: the extension runs for real here, so
// the surrounding gate session's own variables must not reach it.
neutraliseGateEnv();

// ---------------------------------------------------------------------------
// END-TO-END measurement for the seven-round bug: "a READY is demoted to
// PENDING by an edit the reviewer can never see".
//
// The path that produced it: the tool_result edit tracker resolves the edit's
// repo with `gitRootOfDir(dirname(path))`. A file OUTSIDE every git repo
// (`/tmp/report.md` — a child session's completion report) resolves to null,
// which fell straight through to the PRIMARY-repo branch: hasDocChange,
// invalidateBindings (READY→PENDING, PASS→NOT_RUN), the completion record
// deleted, the path pushed into this round's edited-file set. Nothing in the
// repo changed, yet another whole review round was owed.
//
// These tests pin BOTH directions. The outside-repo cases must leave the state
// untouched; the "looks outside but resolves INSIDE" cases (`sub/../x.ts`, a
// symlink pointing into the repo) must still demote — that is the one way this
// change could open a hole in the gate.
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The extension imports ../lib/... and typebox relative to its own file, so
// load it from a temp copy that mirrors the pi-package layout.
const INSTALL = mkdtempSync(join(tmpdir(), "rg-ore-install-"));
// HERMETIC HOME: session_start renders model layers and self-heals agent files
// into `~/.pi/agent/agents`.
const TEST_HOME = mkdtempSync(join(tmpdir(), "rg-ore-HOME-"));
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
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
});

const { default: reviewGate } = await import(join(INSTALL, "extensions", "review-gate.ts"));

// ---- fixtures ---------------------------------------------------------------

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: hermeticGitEnv(),
  }).trim();
}

function makeRepo(parent: string, name: string): string {
  const root = join(parent, name);
  git(parent, "init", "-b", "main", name);
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Gate Test");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib", "x.ts"), "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "init");
  return realpathSync(root);
}

const SESSION_ID = "test-session-1";

/**
 * A sidecar in the state a session is in right AFTER its reviewer said READY:
 * the round's changes are recorded, both verdicts are bound, and the task was
 * declared complete. That is exactly the state the bug destroyed.
 */
function forgeReviewedSidecar(root: string): void {
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "review-gate-state.json"), JSON.stringify({
    schema: 1,
    fingerprintVersion: 2,
    sessionId: SESSION_ID,
    taskMode: "loop",
    hasCodeChange: true,
    hasDocChange: false,
    completion: { at: "2026-09-18T00:00:00.000Z", merge: "none", summary: "done" },
    review: { verdict: "READY", fingerprint: "deadbeef", at: "2026-09-18T00:00:00.000Z" },
    precommit: { verdict: "PASS", fingerprint: "deadbeef", at: "2026-09-18T00:00:00.000Z" },
    sessionEditedFiles: ["lib/x.ts"],
    rounds: [],
    maxRounds: 10,
    bypass: { active: false, reason: null, at: null },
    updatedAt: "2026-09-18T00:00:00.000Z",
  }, null, 2));
}

interface Entry { customType?: string; data?: unknown }

function makeMockPi(cwd: string) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const entries: Entry[] = [];
  const pi = {
    registerTool: () => {},
    on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) => { handlers.set(ev, h); },
    appendEntry: (type: string, data: unknown) => { entries.push({ customType: type, data }); },
    sendMessage: () => {},
    sendUserMessage: () => {},
    registerCommand: () => {},
  };
  return {
    ...pi,
    handlers,
    entries,
    ctx: {
      hasUI: true,
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: { getEntries: () => entries, getSessionId: () => SESSION_ID },
      isIdle: () => false,
      cwd,
    },
  };
}

interface GateSnapshot {
  review: string;
  precommit: string;
  hasCodeChange: boolean;
  hasDocChange: boolean;
  completion: boolean;
  editedFiles: string[];
}

/** The newest gate state the extension persisted (it appends one per persist). */
function latestState(entries: Entry[]): GateSnapshot {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.customType !== "review-gate-state") continue;
    const st = (e.data as { state?: Record<string, unknown> }).state;
    if (!st) continue;
    return {
      review: (st.review as { verdict: string }).verdict,
      precommit: (st.precommit as { verdict: string }).verdict,
      hasCodeChange: st.hasCodeChange as boolean,
      hasDocChange: st.hasDocChange as boolean,
      completion: st.completion !== undefined,
      editedFiles: (st.sessionEditedFiles as string[] | undefined) ?? [],
    };
  }
  throw new Error("the extension persisted no gate state");
}

type Session = ReturnType<typeof makeMockPi>;

/** A started session whose repo already holds a READY review. */
async function startSession(repoRoot: string): Promise<Session> {
  forgeReviewedSidecar(repoRoot);
  const pi = makeMockPi(repoRoot);
  reviewGate(pi as never);
  await pi.handlers.get("session_start")!({}, pi.ctx);
  const before = latestState(pi.entries);
  assert.equal(before.review, "READY", "fixture: the session must start from a recorded READY");
  assert.equal(before.precommit, "PASS", "fixture: the session must start from a passed precommit");
  return pi;
}

/** One successful edit, exactly as the host reports it. */
async function fireEdit(pi: Session, editedPath: string): Promise<void> {
  await pi.handlers.get("tool_result")!({
    toolName: "write",
    isError: false,
    input: { path: editedPath },
    content: [{ type: "text", text: "ok" }],
  }, pi.ctx);
}

async function editThen(repoRoot: string, editedPath: string): Promise<GateSnapshot> {
  const pi = await startSession(repoRoot);
  await fireEdit(pi, editedPath);
  return latestState(pi.entries);
}

function newParent(tag: string): string {
  const p = mkdtempSync(join(tmpdir(), `rg-ore-${tag}-`));
  dirs.push(p);
  return realpathSync(p);
}

// ---------------------------------------------------------------------------
// OUTSIDE the repo — nothing the reviewer can see changed, so nothing moves.
// ---------------------------------------------------------------------------

test("an edit outside every repo (a /tmp report) leaves the READY alone", async () => {
  const parent = newParent("tmp");
  const repoA = makeRepo(parent, "repoA");
  const report = join(parent, "report.md");
  writeFileSync(report, "# done\n"); // the write already landed when tool_result fires

  const after = await editThen(repoA, report);
  assert.equal(after.review, "READY", "a report written outside the repo must not demote the review");
  assert.equal(after.precommit, "PASS", "…nor invalidate the precommit");
  assert.equal(after.hasDocChange, false, "…nor arm the doc gate");
  assert.equal(after.completion, true, "…nor un-finish the task");
  assert.deepEqual(after.editedFiles, ["lib/x.ts"], "…nor join this round's edited files");
});

test("a sibling directory that merely SHARES the repo's path prefix is outside", async () => {
  const parent = newParent("prefix");
  const repoA = makeRepo(parent, "repoA");
  // Neither is a git repo — just directories whose paths START with the
  // repo's. A prefix comparison without the `/` boundary would call both of
  // them "inside" and demote the READY.
  for (const [name, file] of [["repoA-backup", "x.ts"], ["repoA2", "y.ts"]] as const) {
    mkdirSync(join(parent, name), { recursive: true });
    const sibling = join(parent, name, file);
    writeFileSync(sibling, "export const a = 2;\n");

    const after = await editThen(repoA, sibling);
    assert.equal(after.review, "READY", `${name}/${file} is not inside the repo`);
    assert.equal(after.hasCodeChange, true, "the pre-existing arming is untouched");
    assert.deepEqual(after.editedFiles, ["lib/x.ts"]);
  }
});

test("a SENSITIVE outside path is still recorded — visible to a supervisor, but not arming", async () => {
  // The one exception to skipping outside-repo edits: `sessionEditedFiles` is
  // what lib/orchestrator-boundaries.ts reads to decide whether a child wrote
  // somewhere it had no business writing, and its out-of-repo exemption keeps
  // SENSITIVE paths as violations. Writing a report to /tmp and writing to
  // `~/.ssh/config` are not the same act — only the first one is noise.
  const parent = newParent("sensitive");
  const repoA = makeRepo(parent, "repoA");
  const secret = join(parent, ".ssh", "config");
  mkdirSync(join(parent, ".ssh"), { recursive: true });
  writeFileSync(secret, "Host *\n");

  const after = await editThen(repoA, secret);
  assert.deepEqual(after.editedFiles, ["lib/x.ts", secret], "a supervisor must still see it");
  // …and recording it is NOT arming: nothing reviewable changed.
  assert.equal(after.review, "READY", "a write outside the repo invalidates no verdict");
  assert.equal(after.precommit, "PASS");
  assert.equal(after.hasDocChange, false);
  assert.equal(after.completion, true);
});

// ---------------------------------------------------------------------------
// SENTINELS — paths that LOOK outside but resolve INSIDE the repo. Every one
// of these must keep demoting; this is where the change could open a hole.
// ---------------------------------------------------------------------------

test("SENTINEL: a `..` path that climbs back into the repo still demotes the READY", async () => {
  const parent = newParent("dotdot");
  const repoA = makeRepo(parent, "repoA");
  const traversed = join(repoA, "lib", "..", "lib", "x.ts");

  const after = await editThen(repoA, traversed);
  assert.equal(after.review, "PENDING", "an in-repo file reached through `..` must invalidate the review");
  assert.equal(after.precommit, "NOT_RUN");
  assert.equal(after.completion, false, "an in-repo edit un-finishes the task");
});

test("SENTINEL: a symlink from outside pointing INTO the repo still demotes the READY", async () => {
  const parent = newParent("symlink");
  const repoA = makeRepo(parent, "repoA");
  const link = join(parent, "link.ts");
  symlinkSync(join(repoA, "lib", "x.ts"), link);

  const after = await editThen(repoA, link);
  assert.equal(after.review, "PENDING", "writing through a symlink writes the repo file itself");
  assert.equal(after.hasCodeChange, true);
});

test("SENTINEL: a new file in a not-yet-existing repo subdirectory still demotes the READY", async () => {
  const parent = newParent("newdir");
  const repoA = makeRepo(parent, "repoA");
  // `git rev-parse` fails on a directory that does not exist — the edit's repo
  // cannot be resolved that way, and the fallback must be "inside".
  const fresh = join(repoA, "brand", "new", "deep", "y.ts");

  const after = await editThen(repoA, fresh);
  assert.equal(after.review, "PENDING", "a new nested file is still a file in the repo");
  assert.equal(after.hasCodeChange, true);
});

test("SENTINEL: an ordinary in-repo edit is completely unchanged", async () => {
  const parent = newParent("plain");
  const repoA = makeRepo(parent, "repoA");

  const after = await editThen(repoA, join(repoA, "lib", "x.ts"));
  assert.equal(after.review, "PENDING");
  assert.equal(after.precommit, "NOT_RUN");
  assert.equal(after.completion, false);
});

test("SENTINEL: an edit in ANOTHER git repo still arms that repo, not the primary", async () => {
  const parent = newParent("crossrepo");
  const repoA = makeRepo(parent, "repoA");
  const repoB = makeRepo(parent, "repoB");

  const after = await editThen(repoA, join(repoB, "lib", "x.ts"));
  // The primary keeps its verdicts (the cross-repo branch never touches them)…
  assert.equal(after.review, "READY");
  // …and repoB got its own armed sidecar.
  const sidecarB = JSON.parse(
    readFileSync(join(repoB, ".pi", "review-gate-state.json"), "utf8"),
  ) as { hasCodeChange: boolean; review: { verdict: string } };
  assert.equal(sidecarB.hasCodeChange, true, "the other repo's own gate must arm");
  assert.equal(sidecarB.review.verdict, "PENDING");
});

test("SENTINEL: a NEW file in a not-yet-existing directory of another repo arms THAT repo", async () => {
  // Round-2 reviewer P1 — the hole this change could have opened. `git
  // rev-parse` fails on the directory (it does not exist), so the edit was
  // unattributed; once "unattributed" stopped meaning "the primary repo", the
  // file was skipped entirely and a real source file in repoB could ship
  // unreviewed. Attribution climbs to the nearest existing ancestor now.
  const parent = newParent("othernew");
  const repoA = makeRepo(parent, "repoA");
  const repoB = makeRepo(parent, "repoB");

  const after = await editThen(repoA, join(repoB, "brand", "new", "deep", "y.ts"));
  assert.equal(after.review, "READY", "the primary repo's verdict is not the one at stake");
  const sidecarB = JSON.parse(
    readFileSync(join(repoB, ".pi", "review-gate-state.json"), "utf8"),
  ) as { hasCodeChange: boolean; review: { verdict: string } };
  assert.equal(sidecarB.hasCodeChange, true, "the OTHER repo's gate must arm");
  assert.equal(sidecarB.review.verdict, "PENDING");
});

test("SENTINEL: a symlink pointing into ANOTHER repo arms that repo, not nothing", async () => {
  // The same hole in its rarer shape: /tmp is in no repository, so only the
  // RESOLVED path can say where the write lands.
  const parent = newParent("otherlink");
  const repoA = makeRepo(parent, "repoA");
  const repoB = makeRepo(parent, "repoB");
  const link = join(parent, "into-b.ts");
  symlinkSync(join(repoB, "lib", "x.ts"), link);

  const after = await editThen(repoA, link);
  assert.equal(after.review, "READY", "the primary repo saw no edit");
  const sidecarB = JSON.parse(
    readFileSync(join(repoB, ".pi", "review-gate-state.json"), "utf8"),
  ) as { hasCodeChange: boolean };
  assert.equal(sidecarB.hasCodeChange, true, "the repo the symlink writes into must arm");
});

test("an in-repo edit git cannot attribute points the active repo back home", async () => {
  // Round-1 reviewer P2. The retarget used to ask `editRepo === primaryRepoRoot`,
  // so an edit git could not attribute left a multi-repo session recording its
  // verdicts against the OTHER repo. The distinguishing case has to be one git
  // still cannot attribute AFTER the ancestor climb (round-3 reviewer P1: a new
  // nested directory no longer is one — the climb resolves it to repoA, and the
  // old guard would have passed it too). A symlink out of a directory that is
  // in no repository is: only RESOLVING the file says it writes into repoA.
  const parent = newParent("retarget");
  const repoA = makeRepo(parent, "repoA");
  const repoB = makeRepo(parent, "repoB");
  const link = join(parent, "into-a.ts");
  symlinkSync(join(repoA, "lib", "x.ts"), link);

  const pi = await startSession(repoA);
  await fireEdit(pi, join(repoB, "lib", "x.ts"));            // active → repoB
  await fireEdit(pi, link);                                  // …must come home

  // The verdict recorder names the last-edited repo in its ambiguity refusal —
  // that label IS the active repo.
  const recorders = (pi as unknown as {
    __reviewGateRecorders?: {
      recordReviewVerdict: (c: unknown, r: string, x: unknown) => Promise<string>;
    };
  }).__reviewGateRecorders;
  assert.ok(recorders, "the extension must expose its recorders on the test seam");
  const refusal = await recorders!.recordReviewVerdict(
    { verdict: "READY", docSync: "NOT_NEEDED", findings: [] },
    "",
    pi.ctx,
  );
  assert.match(refusal, /more than one repository/);
  const active = refusal.split("\n").filter((l) => l.includes("(last edited)"));
  assert.equal(active.length, 1);
  assert.ok(active[0].includes(repoA), `the session repo must be active again, got: ${active[0]}`);
});

