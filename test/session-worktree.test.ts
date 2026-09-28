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
import { join } from "node:path";

import {
  RELOCATE_COMMAND,
  RELOCATE_NO,
  RELOCATE_YES,
  isSessionWorktreePath,
  ownerRecordPath,
  ownsSessionWorktree,
  parseOwner,
  reclaimSessionWorktreeArgv,
  relocateChoice,
  sessionWorktreeBranch,
  sessionWorktreePath,
  shouldAdopt,
  shouldOfferRelocation,
} from "../lib/session-worktree.ts";
import { createSessionWorktree } from "../lib/session-worktree-host.ts";
import { ensureGateWorktreeRoot, gateWorktreeRoot } from "../lib/worktree-root.ts";

const REPO = "/Users/dev/workspace/pi-review-gate";
const CONVENTIONAL_ASCII = /^[a-z]+\([a-z-]+\): [\x20-\x7e]+$/;

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

test("reclamation commits the leftovers, THEN removes the directory — never the branch", () => {
  const owner = { sessionId: "s1", pid: 1, repo: REPO, branch: "rg-session-x", path: sessionWorktreePath(REPO, "x") };
  const steps = reclaimSessionWorktreeArgv(owner, "feat/renamed").map((s) => [...s]);
  assert.deepEqual(steps, [
    ["-C", owner.path, "add", "-A"],
    ["-C", owner.path, "commit", "-m", "chore(session): save leftovers of feat/renamed"],
    ["-C", REPO, "worktree", "remove", "--force", owner.path],
  ]);
  assert.match(steps[1]![4]!, CONVENTIONAL_ASCII, "the gate's own commit subject is English Conventional Commits");
  assert.ok(!steps.some((s) => s.includes("-D")), "the branch is the only copy — never deleted");
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

    // After the switch: the NEW session reclaims — leftovers first, then the dir.
    w.session = { id: owner.sessionId, cwd: path };
    const note = w.host.reclaimOwn()!;
    assert.match(note, /已回收/);
    assert.equal(existsSync(path), false, "the directory is gone");
    assert.equal(existsSync(ownerRecordPath(path)), false, "…and so is its record");
    const tail = w.gitCalls.slice(-3).map((a) => a.slice(2, 4).join(" "));
    assert.deepEqual(tail, ["add -A", "commit -m", "worktree remove"]);
  } finally {
    process.chdir(prevCwd);
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(repo, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a refused commit KEEPS the directory; nothing-to-commit does not; a stranger's checkout is left alone", () => {
  const path = sessionWorktreePath(REPO, `t${Date.now().toString(36)}`);
  const setup = () => {
    mkdirSync(path, { recursive: true });
    writeFileSync(ownerRecordPath(path), JSON.stringify({ sessionId: "me", pid: 1, repo: REPO, branch: "rg-session-t", path }));
  };
  try {
    setup();
    const refused = world({ refused: false, commitFails: "[review-gate] hook refused", repo: REPO });
    refused.session = { id: "me", cwd: path };
    assert.match(refused.host.reclaimOwn()!, /没有回收/);
    assert.equal(existsSync(path), true, "the work is only in that directory — it stays");
    assert.ok(!refused.gitCalls.some((a) => a[3] === "remove"), "the removal never ran");

    const stranger = world({ refused: false, repo: REPO });
    stranger.session = { id: "somebody-else", cwd: path };
    assert.equal(stranger.host.reclaimOwn(), undefined);
    assert.deepEqual(stranger.gitCalls, []);

    const clean = world({ refused: false, commitFails: "nothing to commit, working tree clean", repo: REPO });
    clean.session = { id: "me", cwd: path };
    assert.match(clean.host.reclaimOwn()!, /已回收/);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(path, { recursive: true, force: true });
    rmSync(ownerRecordPath(path), { force: true });
  }
});
