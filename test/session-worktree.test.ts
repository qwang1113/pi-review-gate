/**
 * A SECOND SESSION IN A HELD REPO GETS ITS OWN CHECKOUT (2026-09-28).
 *
 * The pure half (paths, argv, ownership) and the host's decisions — ask or not,
 * switch or not, reclaim or keep — with git and pi faked. What real git and a
 * real pi do with them is the acceptance round's job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { git, neutraliseHostGitConfig } from "./helpers/git.ts";
import { fileURLToPath } from "node:url";
import { isGateIntegrityPath } from "../lib/sensitive-grant.ts";
import { isSensitiveFile } from "../lib/constants.ts";

import {
  RELOCATE_COMMAND,
  RELOCATE_NO,
  RELOCATE_YES,
  isSessionWorktreePath,
  ownerRecordPath,
  ownsSessionWorktree,
  parseOwner,
  RELOCATED_STATION_FLOOR,
  VERIFIED_BRANCHES_RELPATH,
  finishRefusal,
  formatVerifiedBranches,
  isVerifiedTree,
  parseVerifiedBranches,
  raiseStationToFloor,
  relocateChoice,
  removeSessionWorktreeArgv,
  stationFloorNotice,
  sessionWorktreeBranch,
  sessionWorktreePath,
  shouldAdopt,
  shouldOfferRelocation,
} from "../lib/session-worktree.ts";
import { createSessionWorktree } from "../lib/session-worktree-host.ts";
import { ensureGateWorktreeRoot, gateWorktreeRoot } from "../lib/worktree-root.ts";

const REPO = "/Users/dev/workspace/pi-review-gate";

test("the session checkout lives under the gate's /tmp root, on an rg-session branch", () => {
  assert.equal(gateWorktreeRoot(), join(realpathSync("/tmp"), "rg-worktrees"));
  const path = sessionWorktreePath(REPO, "ab12cd34");
  assert.equal(path, join(gateWorktreeRoot(), "pi-review-gate-s-ab12cd34"));
  assert.equal(isSessionWorktreePath(path), true);
  assert.equal(isSessionWorktreePath(REPO), false, "the repo itself is never one");
  assert.equal(isSessionWorktreePath(join(gateWorktreeRoot(), "pi-review-gate-rg-child")), false,
    "an orchestration child's checkout is not a session's to reclaim");
  assert.equal(sessionWorktreeBranch("ab12cd34"), "rg-session-ab12cd34");
});

test("ensureGateWorktreeRoot creates the root on first use", () => {
  const root = ensureGateWorktreeRoot();
  assert.equal(root, gateWorktreeRoot());
  assert.equal(existsSync(root), true);
});

test("removal is the directory only — never a commit, never the branch", () => {
  const owner = { sessionId: "s1", pid: 1, repo: REPO, branch: "rg-session-x", path: sessionWorktreePath(REPO, "x") };
  assert.deepEqual([...removeSessionWorktreeArgv(owner)], ["-C", REPO, "worktree", "remove", "--force", owner.path]);
});

test("ownership: only the named session reclaims; a /new in the same process adopts", () => {
  const owner = parseOwner(JSON.stringify({ sessionId: "s1", pid: 42, repo: REPO, branch: "b", path: "/p" }));
  assert.ok(owner);
  assert.equal(ownsSessionWorktree(owner, "s1"), true);
  assert.equal(ownsSessionWorktree(owner, "s2"), false, "somebody else's checkout is never reclaimed");
  assert.equal(ownsSessionWorktree(undefined, "s1"), false);
  assert.equal(shouldAdopt(owner, "s2", 42), true, "same process, new session id ⇒ take the record over");
  assert.equal(shouldAdopt(owner, "s2", 43), false, "another process never takes it");
  assert.equal(parseOwner("{"), undefined);
  assert.equal(parseOwner(JSON.stringify({ sessionId: "s1" })), undefined, "a half record is no record");
});

test("the offer goes only to a REFUSED session with a dialog, once — and recommends switching", () => {
  assert.equal(shouldOfferRelocation({ refused: true, hasUI: true, alreadyOffered: false }), true);
  assert.equal(shouldOfferRelocation({ refused: false, hasUI: true, alreadyOffered: false }), false);
  assert.equal(shouldOfferRelocation({ refused: true, hasUI: false, alreadyOffered: false }), false, "headless keeps the refusal");
  assert.equal(shouldOfferRelocation({ refused: true, hasUI: true, alreadyOffered: true }), false);
  const spec = relocateChoice(REPO);
  assert.deepEqual(spec.options, [RELOCATE_YES, RELOCATE_NO]);
  assert.equal(spec.recommended, RELOCATE_YES);
});

// ── the host, with git and pi faked ──────────────────────────────────────────

interface World {
  host: ReturnType<typeof createSessionWorktree>;
  asked: number;
  sent: Array<{ text: string; opts: unknown }>;
  gitCalls: string[][];
  command?: (args: string, ctx: unknown) => Promise<void>;
  session: { id: string | undefined; cwd: string };
}

function world(opts: { refused: boolean; answer?: string; commitFails?: string; repo: string }): World {
  const w: World = { asked: 0, sent: [], gitCalls: [], session: { id: "old-session", cwd: opts.repo } } as unknown as World;
  w.host = createSessionWorktree({
    pi: {
      registerCommand: (name, o) => { if (name === RELOCATE_COMMAND) w.command = o.handler as World["command"]; },
      sendUserMessage: (text, o) => { w.sent.push({ text, opts: o }); },
    },
    cwd: () => w.session.cwd,
    sessionId: () => w.session.id,
    refused: () => opts.refused,
    askChoice: async () => { w.asked++; return opts.answer; },
    log: () => {},
    git: (_cwd, argv) => {
      w.gitCalls.push([...argv]);
      if (argv[2] === "worktree" && argv[3] === "add") mkdirSync(argv[6]!, { recursive: true });
      if (argv[2] === "worktree" && argv[3] === "remove") rmSync(argv[5]!, { recursive: true, force: true });
      if (argv[2] === "commit" && opts.commitFails) return { ok: false, output: opts.commitFails };
      return { ok: true, output: "" };
    },
  });
  w.host.register();
  return w;
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const uiCtx = (hasUI: boolean) => ({ hasUI, ui: { notify: () => {} } }) as never;

test("declining (or no dialog) keeps the refusal: no checkout, no switch", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-sw-repo-"));
  const no = world({ refused: true, answer: RELOCATE_NO, repo });
  no.host.offerAfterRefusal(uiCtx(true));
  await flush();
  assert.equal(no.asked, 1);
  assert.deepEqual(no.gitCalls, [], "nothing was cut");
  assert.deepEqual(no.sent, []);

  const headless = world({ refused: true, answer: RELOCATE_YES, repo });
  headless.host.offerAfterRefusal(uiCtx(false));
  await flush();
  assert.equal(headless.asked, 0, "no dialog to ask in ⇒ the refusal stands");

  const free = world({ refused: false, answer: RELOCATE_YES, repo });
  free.host.offerAfterRefusal(uiCtx(true));
  await flush();
  assert.equal(free.asked, 0, "a session that holds the repo is never asked");
  rmSync(repo, { recursive: true, force: true });
});

test("yes ⇒ cut under /tmp, a session file that starts THERE, and the switch through the gate's own command", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-sw-repo-"));
  const agentDir = mkdtempSync(join(tmpdir(), "rg-sw-agent-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const prevCwd = process.cwd();
  try {
    // The dialog hands back the ROW it drew, not the bare option text.
    const w = world({ refused: true, answer: `A. ${RELOCATE_YES}（推荐）`, repo });
    w.host.offerAfterRefusal(uiCtx(true));
    await flush();
    const add = w.gitCalls.find((a) => a[3] === "add")!;
    const path = add[6]!;
    assert.equal(isSessionWorktreePath(path), true, "the checkout is under /tmp/rg-worktrees");
    assert.match(add[5]!, /^rg-session-/);
    assert.equal(w.sent.length, 1);
    const [cmd, file] = w.sent[0]!.text.split(" ");
    assert.equal(cmd, `/${RELOCATE_COMMAND}`);
    assert.deepEqual(w.sent[0]!.opts, { expandPromptTemplates: true }, "how pi runs an extension command with a command ctx");
    const header = JSON.parse(readFileSync(file!, "utf8").split("\n")[0]!);
    assert.equal(header.type, "session");
    assert.equal(header.cwd, path, "the new runtime's cwd comes from this header");
    const owner = parseOwner(readFileSync(ownerRecordPath(path), "utf8"))!;
    assert.equal(owner.sessionId, header.id, "the record names the NEW session — the one that will reclaim it");
    assert.equal(owner.repo, repo);

    // The command switches only into a file the gate prepared.
    const switched: string[] = [];
    const ctx = { ui: { notify: () => {} }, switchSession: async (f: string) => { switched.push(f); return { cancelled: false }; } };
    await w.command!("/etc/passwd", ctx);
    assert.deepEqual(switched, [], "a foreign file is refused");
    await w.command!(file!, ctx);
    assert.deepEqual(switched, [file]);

    // After the switch: the NEW session is the one in its own worktree.
    w.session = { id: owner.sessionId, cwd: path };
    assert.equal(w.host.inOwnWorktree(), true);
    // Leaving without declare_done: the directory goes as it stands — no commit.
    writeFileSync(join(path, "unsaved.txt"), "dropped");
    const before = w.gitCalls.length;
    assert.match(w.host.removeOwn()!, /已回收/);
    assert.equal(existsSync(path), false, "the directory is gone, uncommitted work with it");
    assert.equal(existsSync(ownerRecordPath(path)), false, "…and so is its record");
    assert.deepEqual(w.gitCalls.slice(before).map((a) => a.slice(2, 4).join(" ")), ["worktree remove"],
      "nothing is ever committed on the session's behalf");
  } finally {
    process.chdir(prevCwd);
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(repo, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a stranger's checkout is left alone", () => {
  const path = sessionWorktreePath(REPO, `t${Date.now().toString(36)}`);
  try {
    mkdirSync(path, { recursive: true });
    writeFileSync(ownerRecordPath(path), JSON.stringify({ sessionId: "me", pid: 1, repo: REPO, branch: "rg-session-t", path }));
    const stranger = world({ refused: false, repo: REPO });
    stranger.session = { id: "somebody-else", cwd: path };
    assert.equal(stranger.host.inOwnWorktree(), false);
    assert.equal(stranger.host.removeOwn(), undefined);
    assert.equal(stranger.host.finishOwn({ reviewVerdict: "READY", reviewTree: "t", acceptanceStatus: "READY" }), undefined);
    assert.deepEqual(stranger.gitCalls, []);
    assert.equal(existsSync(path), true);
  } finally {
    rmSync(path, { recursive: true, force: true });
    rmSync(ownerRecordPath(path), { force: true });
  }
});

test("finishRefusal: dirty, unreviewed HEAD, or unfinished acceptance all refuse", () => {
  const ok = { clean: true, headTree: "t1", reviewVerdict: "READY", reviewTree: "t1", acceptanceStatus: "READY" };
  assert.equal(finishRefusal(ok), undefined);
  assert.equal(finishRefusal({ ...ok, acceptanceStatus: "SKIPPED" }), undefined, "a recorded skip finishes");
  assert.equal(finishRefusal({ ...ok, acceptanceStatus: "DISABLED" }), undefined);
  assert.match(finishRefusal({ ...ok, clean: false })!, /未提交/);
  assert.match(finishRefusal({ ...ok, reviewTree: "t0" })!, /审查 READY/);
  assert.match(finishRefusal({ ...ok, reviewVerdict: "PENDING" })!, /审查 READY/);
  for (const a of ["BLOCKED", "AWAITING", undefined]) {
    assert.match(finishRefusal({ ...ok, acceptanceStatus: a })!, /验收/);
  }
});

test("the relocated session's station floor is commit; others are untouched", () => {
  assert.equal(raiseStationToFloor("precommit", RELOCATED_STATION_FLOOR), "commit");
  assert.equal(raiseStationToFloor("pr", RELOCATED_STATION_FLOOR), "pr");
  assert.equal(raiseStationToFloor("precommit", undefined), "precommit");
  assert.match(stationFloorNotice("precommit", RELOCATED_STATION_FLOOR)!, /最低 commit/);
  assert.equal(stationFloorNotice("pr", RELOCATED_STATION_FLOOR), undefined);
  assert.equal(stationFloorNotice("precommit", undefined), undefined);
});

test("the verified-branch record is gate-owned: an agent edit is blocked and ungrantable", () => {
  assert.equal(isGateIntegrityPath(`/r/${VERIFIED_BRANCHES_RELPATH}`), true);
  assert.equal(isSensitiveFile(`/r/${VERIFIED_BRANCHES_RELPATH}`), true);
  assert.deepEqual(parseVerifiedBranches("{"), [], "corrupt ⇒ no record");
  assert.deepEqual(parseVerifiedBranches(JSON.stringify([{ branch: "b", tree: "t" }])), [], "half a record is none");
});

test("declare_done runs finishOwn LAST — after every gate and the acceptance round — and removes the dir only after it", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "declare-done-tool.ts"), "utf8");
  const problems = src.indexOf("details: { accepted: false, problems },");
  const acceptance = src.indexOf("if (acceptance) return acceptance;");
  const finish = src.indexOf("deps.sessionWorktree.finishOwn(");
  const done = src.indexOf('progress.done("全部满足");');
  const remove = src.indexOf("deps.sessionWorktree.removeOwn()");
  assert.ok(problems > 0 && acceptance > problems, "the ship-gate refusal and the acceptance round come first");
  assert.ok(finish > acceptance && finish < done, "finishOwn is the last gate, so an earlier refusal never reaches it");
  assert.ok(remove > done, "the directory goes only once the round is accepted");
});

// ── real git: finishOwn writes the record, the pre-push script honours it ──

// The host under test spawns git itself, so the host's global config is
// neutralised for the whole process, not only for the fixture calls.
neutraliseHostGitConfig();
const g = (cwd: string, ...args: string[]): string => git(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", ...args]);

test("finishOwn on a real repo: refuses dirty, records clean+reviewed, pre-push releases only that tree", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "rg-sw-real-")));
  const token = `r${Date.now().toString(36)}`;
  const path = sessionWorktreePath(repo, token);
  const branch = sessionWorktreeBranch(token);
  try {
    g(repo, "init", "-q");
    writeFileSync(join(repo, "a.txt"), "a");
    g(repo, "add", "-A"); g(repo, "commit", "-qm", "init");
    ensureGateWorktreeRoot();
    g(repo, "worktree", "add", "-q", "-b", branch, path, "HEAD");
    writeFileSync(ownerRecordPath(path), JSON.stringify({ sessionId: "me", pid: 1, repo, branch, path }));
    const host = createSessionWorktree({
      pi: { registerCommand: () => {}, sendUserMessage: () => {} },
      cwd: () => path, sessionId: () => "me", refused: () => false,
      askChoice: async () => undefined, log: () => {},
    });
    writeFileSync(join(path, "b.txt"), "b");
    const dirty = host.finishOwn({ reviewVerdict: "READY", reviewTree: "x", acceptanceStatus: "READY", sessionEditedFiles: ["b.txt"] });
    assert.match(dirty!.refusal, /未提交/, "an untracked file THIS session wrote is uncommitted work");
    writeFileSync(join(path, "a.txt"), "a2");
    assert.match(host.finishOwn({ reviewVerdict: "READY", reviewTree: "x", acceptanceStatus: "READY" })!.refusal, /未提交/,
      "a tracked modification is uncommitted work");
    g(path, "checkout", "--", "a.txt");
    assert.equal(existsSync(join(repo, VERIFIED_BRANCHES_RELPATH)), false, "a refusal writes nothing");

    g(path, "add", "-A"); g(path, "commit", "-qm", "work");
    // A FOREIGN untracked file (the session never wrote it) is never committed
    // by the checkpoint, so it must not block (lib/checkpoint-sweep.ts).
    writeFileSync(join(path, "foreign.log"), "x");
    const tree = g(path, "rev-parse", "HEAD^{tree}");
    const commit = g(path, "rev-parse", "HEAD");
    // A READY binds to the REVIEWED COMMIT'S TREE (lib/verdict-host.ts bindTree).
    assert.match(host.finishOwn({ reviewVerdict: "READY", reviewTree: "stale", acceptanceStatus: "READY" })!.refusal, /审查 READY/);
    assert.match(host.finishOwn({ reviewVerdict: "READY", reviewTree: tree, acceptanceStatus: "BLOCKED" })!.refusal, /验收/);
    assert.equal(host.finishOwn({ reviewVerdict: "READY", reviewTree: tree, acceptanceStatus: "READY" }), undefined);
    const records = parseVerifiedBranches(readFileSync(join(repo, VERIFIED_BRANCHES_RELPATH), "utf8"));
    assert.deepEqual(records.map((r) => [r.branch, r.commit, r.tree, r.acceptance]), [[branch, commit, tree, "READY"]]);
    assert.equal(isVerifiedTree(records, tree), true);
    assert.match(formatVerifiedBranches(records).join("\n"), new RegExp(`已验分支[\\s\\S]*${branch}`), "/gate-status lists it");
    assert.deepEqual(formatVerifiedBranches([]), []);

    assert.match(host.removeOwn()!, /已回收/);
    assert.equal(existsSync(path), false);
    assert.equal(g(repo, "rev-parse", branch), commit, "the branch stays in the main repo");

    const zero = "0".repeat(40);
    const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "pre-push-verified.cjs");
    const push = (stdin: string) => spawnSync(process.execPath, [script], { cwd: repo, input: stdin }).status;
    assert.equal(push(`refs/heads/${branch} ${commit} refs/heads/${branch} ${zero}\n`), 0, "the recorded tree is released");
    const head = g(repo, "rev-parse", "HEAD");
    assert.equal(push(`refs/heads/main ${head} refs/heads/main ${zero}\n`), 1, "an unrecorded tree falls back");
    assert.equal(push(`refs/heads/${branch} ${commit} refs/heads/${branch} ${zero}\nrefs/heads/main ${head} refs/heads/main ${zero}\n`), 1,
      "one unrecorded ref is enough to fall back");
    assert.equal(push(`(delete) ${zero} refs/heads/old ${commit}\nrefs/heads/${branch} ${commit} refs/heads/${branch} ${zero}\n`), 0,
      "a delete does not count against the push");
    assert.equal(push(""), 1, "nothing pushed ⇒ not released");
    writeFileSync(join(repo, VERIFIED_BRANCHES_RELPATH), "{broken");
    assert.equal(push(`refs/heads/${branch} ${commit} refs/heads/${branch} ${zero}\n`), 1, "a corrupt record releases nothing");
  } finally {
    try { g(repo, "worktree", "remove", "--force", path); } catch { /* already gone */ }
    rmSync(path, { recursive: true, force: true });
    rmSync(ownerRecordPath(path), { force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
