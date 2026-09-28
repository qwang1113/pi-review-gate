#!/usr/bin/env node
/**
 * PRE-PUSH RELEASE FOR VERIFIED BRANCHES (2026-09-28).
 *
 * A second session that worked in its own /tmp worktree leaves its branch in
 * the MAIN repository together with a record of the tree the gate reviewed and
 * accepted (`.pi/verified-branches.json`, written by lib/session-worktree-host.ts,
 * edit-protected by lib/sensitive-grant.ts). Pushing that branch from the main
 * checkout must not be judged by the main checkout's OWN gate state — that is
 * another session's verdict about another tree.
 *
 * Reads git's pre-push stdin (`<local ref> <local sha> <remote ref> <remote sha>`
 * per line). Exits 0 only when every non-delete ref's tip tree is recorded;
 * anything else — no refs, a missing or corrupt record file, one unrecorded
 * tree — exits 1, and hooks/pre-push falls back to the ordinary check.
 *
 * CommonJS with no dependencies: hooks run where the TS extension never loads.
 * The record shape mirrors `parseVerifiedBranches` in lib/session-worktree.ts.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { dirname, isAbsolute, join, resolve } = require("node:path");

const ZERO = /^0+$/;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** The main repo's root, also when the push runs from one of its worktrees. */
function mainRoot(cwd) {
  const common = git(cwd, ["rev-parse", "--git-common-dir"]);
  return dirname(isAbsolute(common) ? common : resolve(cwd, common));
}

function recordedTrees(root) {
  const raw = readFileSync(join(root, ".pi", "verified-branches.json"), "utf8");
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) return new Set();
  return new Set(list
    .filter((r) => r && r.review === "READY" && typeof r.tree === "string" && typeof r.commit === "string")
    .map((r) => r.tree));
}

function allVerified(stdin, cwd) {
  const refs = stdin.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 4);
  const pushed = refs.filter((p) => !ZERO.test(p[1]));
  if (pushed.length === 0) return false;
  const trees = recordedTrees(mainRoot(cwd));
  return pushed.every((p) => trees.has(git(cwd, ["rev-parse", `${p[1]}^{tree}`])));
}

module.exports = { allVerified };

if (require.main === module) {
  let ok = false;
  try { ok = allVerified(readFileSync(0, "utf8"), process.cwd()); } catch { ok = false; }
  process.exit(ok ? 0 : 1);
}
