/**
 * THE RUN'S OWN CHECKOUT, ON A REAL REPOSITORY.
 *
 * Why this file exists at all (2026-10-03): a scheduled run used to work in the
 * task's repository, so "that repo is busy" — the user's session, an earlier run
 * of any task there — was a reason to SKIP the slot. Six slots in one day were
 * lost to it on this machine. The fix gives every run its own checkout, and the
 * checkout's whole life (cut from HEAD, seeded, and then landed or recycled by
 * its outcome and its station) is `git` behaviour: it cannot be faked and still
 * be tested.
 *
 * The scheduler's own tests fake this seam (`test/daemon-scheduler.test.ts`):
 * they verify WHEN a checkout is cut and what a slot it could not cut does,
 * which is not a git question at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createScheduleWorktree,
  readScheduleWorktreeOwner,
  scheduleOwnerRecordPath,
  scheduleWorktreeBranch,
  scheduleWorktreePath,
  scheduleWorktreeToken,
  settleScheduleWorktree,
  type ScheduleWorktreeOwner,
} from "../lib/schedule-worktree.ts";
import { gateWorktreeRoot } from "../lib/worktree-root.ts";
import { git } from "./helpers/git.ts";

/** A real repository with one commit, on `main`, and NO host hooks of its own. */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-sched-wt-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "gate-test@example.invalid"]);
  git(dir, ["config", "user.name", "gate test"]);
  // THE HOST'S HOOKS DO NOT BELONG IN A FIXTURE: this machine installs a global
  // pre-commit hook (the gate's own), and a fixture that inherits it would be
  // testing that hook instead of this module. The one test that WANTS a hook
  // installs its own (see "a hook that REFUSES…").
  const hooks = mkdtempSync(join(tmpdir(), "rg-sched-wt-hooks-"));
  made.push(hooks);
  git(dir, ["config", "core.hooksPath", hooks]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** Every directory this file creates is removed again, root included. */
const made: string[] = [];
function track<T extends string>(path: T): T {
  made.push(path);
  return path;
}
test.after(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

function cut(repo: string, runId = "run-aaaa1111"): ScheduleWorktreeOwner {
  const result = createScheduleWorktree({ repo, runId });
  if (!result.ok) assert.fail(result.problem);
  made.push(result.worktree.path, scheduleOwnerRecordPath(result.worktree.path));
  return result.worktree;
}

/** Commit `files` inside the checkout, on the run's own branch. */
function commitIn(worktree: ScheduleWorktreeOwner, files: Record<string, string>, message = "feat: run output"): void {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(worktree.path, name), content);
  }
  git(worktree.path, ["add", "-A"]);
  git(worktree.path, ["commit", "-q", "-m", message]);
}

// ---------------------------------------------------------------------------
// pure naming
// ---------------------------------------------------------------------------

test("a run's token comes from its run id, and the checkout is named after its repo", () => {
  assert.equal(scheduleWorktreeToken("run-aaaa1111"), "runaaaa1111");
  assert.equal(scheduleWorktreeBranch("runaaaa1111"), "rg-schedule-runaaaa1111");
  assert.equal(
    scheduleWorktreePath("/somewhere/Repo.Name", "runaaaa1111"),
    join(gateWorktreeRoot(), "Repo.Name-sch-runaaaa1111"),
  );
});

// ---------------------------------------------------------------------------
// cutting
// ---------------------------------------------------------------------------

test("a run's checkout is cut from HEAD, seeded, and carries an owner record", () => {
  const repo = track(gitRepo());
  const worktree = cut(repo, "run-bbbb2222");
  assert.equal(worktree.repo, repo);
  assert.equal(worktree.branch, "rg-schedule-runbbbb2222");
  assert.equal(worktree.base, git(repo, ["rev-parse", "HEAD"]), "base 是切的那一刻的 HEAD");
  assert.equal(existsSync(worktree.path), true);
  assert.equal(existsSync(join(worktree.path, "README.md")), true);
  assert.equal(git(worktree.path, ["rev-parse", "--abbrev-ref", "HEAD"]), worktree.branch);
  // THE OWNER RECORD IS WHAT MAKES CONTRACT ADOPTION POSSIBLE: a run's cwd is
  // this path, not the task's repo, and the adoption has to accept it.
  const owner = readScheduleWorktreeOwner(worktree.path);
  assert.deepEqual(owner, worktree);
  assert.equal(git(repo, ["worktree", "list"]).includes(worktree.path), true, "git 也认得它");
  assert.equal(
    readScheduleWorktreeOwner(join(repo, "nowhere")),
    undefined,
    "没有归属记录的目录不是我们的 checkout",
  );
});

test("the checkout starts from the committed HEAD, not from the user's uncommitted work", () => {
  const repo = track(gitRepo());
  writeFileSync(join(repo, "README.md"), "uncommitted in the main repo\n");
  writeFileSync(join(repo, "draft.txt"), "never committed\n");
  const worktree = cut(repo, "run-cccc3333");
  assert.equal(readFileSync(join(worktree.path, "README.md"), "utf8"), "hello\n", "未提交的改动不跟进来");
  assert.equal(existsSync(join(worktree.path, "draft.txt")), false);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "uncommitted in the main repo\n", "主 repo 一个字没动");
});

test("a checkout that cannot be cut says so instead of throwing — and says whether retrying can help", () => {
  const notARepo = track(mkdtempSync(join(tmpdir(), "rg-sched-wt-norepo-")));
  const result = createScheduleWorktree({ repo: notARepo, runId: "run-dddd4444" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.problem, /不是 git 仓库/);
    assert.equal(result.permanent, true, "永久障碍：调度器据此消费掉那一槽");
  }
  const gone = createScheduleWorktree({ repo: join(notARepo, "nowhere"), runId: "run-dddd5555" });
  assert.equal(gone.ok, false);
  if (!gone.ok) {
    assert.match(gone.problem, /不是存在的目录/);
    assert.equal(gone.permanent, true);
  }
});

// ---------------------------------------------------------------------------
// settling
// ---------------------------------------------------------------------------

test("a run that produced NOTHING is recycled whole — branch and checkout both", () => {
  const repo = track(gitRepo());
  const worktree = cut(repo, "run-aaaa0001");
  const settlement = settleScheduleWorktree({ worktree, outcome: "passed", station: "precommit" });
  assert.equal(settlement.action, "reclaimed");
  assert.equal(settlement.changes, false);
  assert.equal(existsSync(worktree.path), false);
  assert.equal(existsSync(scheduleOwnerRecordPath(worktree.path)), false);
  assert.equal(git(repo, ["branch", "--list", worktree.branch]), "", "空分支不留");
  assert.equal(git(repo, ["status", "--porcelain"]), "", "主 repo 逐字节不变");
});

test("READY output lands in the main repo STAGED and uncommitted", () => {
  const repo = track(gitRepo());
  const worktree = cut(repo, "run-aaaa0002");
  commitIn(worktree, { "feature.txt": "done\n" });
  const settlement = settleScheduleWorktree({ worktree, outcome: "passed", station: "precommit" });
  assert.equal(settlement.action, "merged");
  assert.equal(settlement.changes, true);
  assert.equal(existsSync(worktree.path), false, "目录用完即回收");
  // STAGED, NOT COMMITTED: at `precommit` the USER commits — that is what the
  // station means, and a run may not take that decision for them.
  assert.equal(git(repo, ["status", "--porcelain"]), "A  feature.txt");
  assert.equal(git(repo, ["log", "--oneline", "-1"]).includes("init"), true, "没有新 commit");
  assert.equal(readFileSync(join(repo, "feature.txt"), "utf8"), "done\n");
  assert.equal(git(repo, ["branch", "--list", worktree.branch]) !== "", true, "分支留着作为 merged 的锚点");
});

test("output that did NOT conclude READY stays on its branch, untouched", () => {
  const repo = track(gitRepo());
  const worktree = cut(repo, "run-aaaa0003");
  commitIn(worktree, { "half-done.txt": "wip\n" });
  const settlement = settleScheduleWorktree({ worktree, outcome: "failed", station: "precommit" });
  assert.equal(settlement.action, "branch-kept");
  assert.match(settlement.note, /failed/);
  assert.equal(settlement.branch, worktree.branch);
  assert.equal(existsSync(worktree.path), false);
  assert.equal(git(repo, ["status", "--porcelain"]), "", "主 repo 一动不动");
  assert.equal(git(repo, ["show", `${worktree.branch}:half-done.txt`]), "wip", "改动在分支上，没丢");
});

test("UNCOMMITTED work is committed onto the run's branch before the directory goes", () => {
  const repo = track(gitRepo());
  const worktree = cut(repo, "run-aaaa0004");
  writeFileSync(join(worktree.path, "loose.txt"), "not committed at all\n");
  const settlement = settleScheduleWorktree({ worktree, outcome: "passed", station: "commit" });
  // `commit` is still below `pr`, so a READY run lands — and the loose file had
  // to be put on the branch first or the cleanup would have eaten it.
  assert.equal(settlement.action, "merged");
  assert.equal(readFileSync(join(repo, "loose.txt"), "utf8"), "not committed at all\n");
  assert.equal(git(repo, ["status", "--porcelain"]), "A  loose.txt");
});

test("a `pr` run keeps its branch and is NEVER merged into the main repo", () => {
  const repo = track(gitRepo());
  const worktree = cut(repo, "run-aaaa0005");
  commitIn(worktree, { "shipped.txt": "pr\n" });
  const settlement = settleScheduleWorktree({ worktree, outcome: "passed", station: "pr" });
  assert.equal(settlement.action, "branch-kept");
  assert.match(settlement.note, /站点 pr/);
  assert.equal(git(repo, ["status", "--porcelain"]), "", "合并回主 repo 会让那个 PR 失去意义");
  assert.equal(git(repo, ["show", `${worktree.branch}:shipped.txt`]), "pr");
});

test("a DIRTY main repo is left alone — the branch is kept and named instead", () => {
  const repo = track(gitRepo());
  const worktree = cut(repo, "run-aaaa0006");
  commitIn(worktree, { "feature.txt": "done\n" });
  // The user is in the middle of their own work in the main repo.
  writeFileSync(join(repo, "README.md"), "user's own edit\n");
  const settlement = settleScheduleWorktree({ worktree, outcome: "passed", station: "precommit" });
  assert.equal(settlement.action, "branch-kept");
  assert.match(settlement.note, /未提交改动/);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "user's own edit\n", "用户的改动没被动过");
  assert.match(git(repo, ["status", "--porcelain"]), /^M README\.md$/m, "主 repo 只有用户自己那一处改动");
  assert.equal(git(repo, ["show", `${worktree.branch}:feature.txt`]), "done");
});

test("a merge that would COLLIDE aborts, leaves the repo as it was, and keeps the branch", () => {
  const repo = track(gitRepo());
  const worktree = cut(repo, "run-aaaa0007");
  commitIn(worktree, { "README.md": "the run's version\n" });
  // The main repo moved on to a different content for the same file: a staged
  // merge cannot land without a human's decision, and a run does not get to
  // make it.
  writeFileSync(join(repo, "README.md"), "main moved on\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "fix: main moved on"]);
  const before = git(repo, ["rev-parse", "HEAD"]);
  const settlement = settleScheduleWorktree({ worktree, outcome: "passed", station: "commit" });
  assert.equal(settlement.action, "branch-kept");
  assert.match(settlement.note, /合并回主 repo 失败/);
  assert.equal(git(repo, ["rev-parse", "HEAD"]), before, "主 repo 的 HEAD 一点没动");
  assert.equal(git(repo, ["status", "--porcelain"]), "", "冲突被 abort 掉了，没有半合并的残留");
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "main moved on\n");
  assert.equal(git(repo, ["show", `${worktree.branch}:README.md`]), "the run's version", "分支留着，人可以自己处理");
});

test("settling is a no-op when the checkout is already gone — a second settlement must not delete the branch", () => {
  const repo = track(gitRepo());
  const worktree = cut(repo, "run-aaaa0010");
  commitIn(worktree, { "kept.txt": "only copy\n" });
  // Settled once (its ledger write failed, so the tick will try again) — or a
  // user deleted the directory. Either way the second call knows nothing about
  // the contents, and the ONE thing it must not do is `branch -D`.
  rmSync(worktree.path, { recursive: true, force: true });
  const settlement = settleScheduleWorktree({ worktree, outcome: "passed", station: "precommit" });
  assert.equal(settlement.action, "branch-kept");
  assert.match(settlement.note, /已经不在了/);
  assert.equal(git(repo, ["show", `${worktree.branch}:kept.txt`]), "only copy", "分支与它的内容都还在");
  assert.equal(git(repo, ["status", "--porcelain"]), "");
});

test("the gate's own `.pi/` artifacts are not the run's output (quality round P2)", () => {
  const repo = track(gitRepo());
  // THE TARGET REPO HAS NO IGNORE RULES AT ALL (the fixture has no
  // `.gitignore`): whether `.pi/` shows up in `git status` is the OTHER repo's
  // business, and the settlement may not assume it away. What a run's session
  // writes there (`loop-goal.md`, sidecar state) is the gate's bookkeeping, not
  // output — counting it would keep a branch for every run and stage the gate's
  // files into the user's repository.
  const worktree = cut(repo, "run-aaaa0011");
  mkdirSync(join(worktree.path, ".pi"), { recursive: true });
  writeFileSync(join(worktree.path, ".pi", "loop-goal.md"), "# 契约\n");
  assert.match(git(worktree.path, ["status", "--porcelain"]), /\?\? \.pi\//, "它对 git 确实是可见的");
  const settlement = settleScheduleWorktree({ worktree, outcome: "passed", station: "precommit" });
  assert.equal(settlement.action, "reclaimed", "只有门禁产物 ⇒ 没有产出");
  assert.equal(git(repo, ["status", "--porcelain"]), "", "主 repo 里不会出现 .pi/loop-goal.md");
  assert.equal(git(repo, ["branch", "--list", worktree.branch]), "", "也不留分支");
});

test("a TRACKED `.pi/` file the run edited is the run's output (2026-10-03, reviewer P1)", () => {
  const repo = track(gitRepo());
  // THE TARGET REPO TRACKS ITS OWN `.pi/` FILES: excluding the directory
  // wholesale would read the run's edit as "nothing" and recycle it with the
  // checkout. The line is drawn per FILE (tracked vs. untracked), not per
  // directory.
  mkdirSync(join(repo, ".pi"), { recursive: true });
  writeFileSync(join(repo, ".pi", "settings.json"), "{}\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "chore: track a .pi file"]);
  const worktree = cut(repo, "run-aaaa0012");
  writeFileSync(join(worktree.path, ".pi", "settings.json"), "{\"edited\":true}\n");
  const settlement = settleScheduleWorktree({ worktree, outcome: "passed", station: "precommit" });
  assert.equal(settlement.action, "merged", settlement.note);
  assert.equal(readFileSync(join(repo, ".pi", "settings.json"), "utf8"), "{\"edited\":true}\n");
});

test("a hook that REFUSES the leftover commit keeps the checkout for a human (2026-10-03, reviewer P1)", () => {
  const repo = track(gitRepo());
  // A hook that says no — the shape the gate's own pre-commit hook has. The
  // settlement does NOT route around it (`git commit --no-verify` would): the
  // project's hooks are the judgement about whether this content may be
  // committed at all, and a refusal means a human looks.
  const hooks = mkdtempSync(join(tmpdir(), "rg-sched-wt-refuse-"));
  made.push(hooks);
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  git(repo, ["config", "core.hooksPath", hooks]);
  const worktree = cut(repo, "run-aaaa0013");
  writeFileSync(join(worktree.path, "unreviewed.txt"), "not reviewed\n");
  const settlement = settleScheduleWorktree({ worktree, outcome: "passed", station: "precommit" });
  assert.equal(settlement.action, "branch-kept");
  assert.match(settlement.note, /提交遗留改动失败/);
  assert.equal(existsSync(worktree.path), true, "目录留着 —— 工作区是唯一副本");
  assert.equal(git(repo, ["status", "--porcelain"]), "", "主 repo 一点没动");
});

test("a second run of the same id replaces a leftover checkout instead of failing", () => {
  const repo = track(gitRepo());
  const first = cut(repo, "run-aaaa0008");
  // The daemon died between cutting and launching: the next attempt at the SAME
  // run id meets its own leftovers, and must not be stopped by them.
  writeFileSync(join(first.path, "leftover.txt"), "from a dead attempt\n");
  const second = createScheduleWorktree({ repo, runId: "run-aaaa0008" });
  assert.equal(second.ok, true, second.ok ? "" : second.problem);
  if (second.ok) made.push(second.worktree.path, scheduleOwnerRecordPath(second.worktree.path));
  assert.equal(existsSync(join(first.path, "leftover.txt")), false, "上一次的残留不进入新的 checkout");
});
