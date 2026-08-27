/**
 * sessionDirForCwd — must match pi's session-manager encoding byte for byte,
 * because the fresh-context review roles read the main session's transcript
 * from the encoded directory. Round-5 P1: pi resolves the cwd with
 * `path.resolve` (normalization, NOT symlink dereferencing), so a symlinked
 * launch path encodes to the LOGICAL path's directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sessionDirForCwd } from "../lib/session-dir.ts";

const HOME = join(tmpdir(), "rg-session-home-");
const tracks: string[] = [];
function track(p: string): string {
  tracks.push(p);
  return p;
}
test.after(() => {
  for (const p of tracks) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("POSIX path encodes like pi: --<path with / replaced by ->--", () => {
  const got = sessionDirForCwd("/Users/qwang/workspace/pi-review-gate", HOME);
  assert.equal(got, join(HOME, ".pi", "agent", "sessions", "--Users-qwang-workspace-pi-review-gate--"));
});

test("a RELATIVE input absolutizes against the process cwd, exactly like pi's resolvePath (round-7 P1)", () => {
  // pi calls resolvePath(cwd) unconditionally; a relative cwd must NOT be
  // encoded as-is (that would point the transcript at a nonexistent dir).
  const got = sessionDirForCwd("repo/sub", HOME);
  const expected = "--" + resolve("repo/sub").replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-") + "--";
  assert.equal(got, join(HOME, ".pi", "agent", "sessions", expected));
  assert.ok(!got.includes("--repo-sub--"), "relative input must be absolutized, not encoded raw");
});

test("a symlinked launch path encodes the LOGICAL path, like pi's path.resolve (round-5 P1)", () => {
  const root = track(mkdtempSync(join(tmpdir(), "rg-session-sym-")));
  const real = track(join(root, "real-dir"));
  const link = track(join(root, "link-dir"));
  mkdirSync(real);
  symlinkSync(real, link);
  const viaLink = sessionDirForCwd(link, HOME);
  const viaReal = sessionDirForCwd(real, HOME);
  assert.notEqual(viaLink, viaReal, "pi does NOT dereference symlinks — the encodings must differ");
  assert.ok(viaLink.includes("link-dir"), `the logical (symlink) name must be encoded: ${viaLink}`);
  assert.ok(!viaLink.includes("real-dir"), `the physical name must NOT leak into the encoding: ${viaLink}`);
});

test("path.resolve normalization: trailing slash and dot segments collapse (round-5 P1)", () => {
  const base = "/Users/qwang/workspace";
  const a = sessionDirForCwd(join(base, "pi-review-gate"), HOME);
  assert.equal(sessionDirForCwd(join(base, "pi-review-gate", "."), HOME), a);
  assert.equal(sessionDirForCwd(join(base, "pi-review-gate", "sub", ".."), HOME), a);
});

test("PI_CODING_AGENT_DIR moves the sessions dir with it, like pi's getAgentDir (round-8 P1)", () => {
  const prev = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "/custom/agent-dir";
    const got = sessionDirForCwd("/Users/qwang/workspace/pi-review-gate", HOME);
    assert.equal(got, join("/custom/agent-dir", "sessions", "--Users-qwang-workspace-pi-review-gate--"));
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test("PI_CODING_AGENT_SESSION_DIR is the FINAL session dir, used verbatim (round-9 P1)", () => {
  const prev = process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = "/custom/sessions";
    const got = sessionDirForCwd("/Users/qwang/workspace/pi-review-gate", HOME);
    assert.equal(got, "/custom/sessions", "the env value IS the session dir — no encoded subdir");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = prev;
  }
});

test("~ and ~/ expand to the home dir in overrides and env, like pi's normalizePath (round-10 P1)", () => {
  const got = sessionDirForCwd("/Users/qwang/workspace/pi-review-gate", HOME, "~/custom-sessions");
  assert.equal(got, join(HOME, "custom-sessions"));
  // With NO env override set, a ~ cwd expands into the default layout.
  const encRepo = "--" + join(HOME, "repo").replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
  assert.equal(sessionDirForCwd("~/repo", HOME), join(HOME, ".pi", "agent", "sessions", encRepo), "a ~ cwd expands too");
  const prev = process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = "~/.pi/custom";
    assert.equal(sessionDirForCwd("/x", HOME), join(HOME, ".pi", "custom"));
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = prev;
  }
});
