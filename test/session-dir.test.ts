/**
 * sessionDirForCwd — must match pi's session-manager encoding byte for byte,
 * because the fresh-context review roles read the main session's transcript
 * from the encoded directory. Round-5 P1: pi resolves the cwd with
 * `path.resolve` (normalization, NOT symlink dereferencing), so a symlinked
 * launch path encodes to the LOGICAL path's directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findTranscriptPath, piSessionsRoot, sessionDirForCwd } from "../lib/session-dir.ts";

test("D06: the transcript is the `<timestamp>_<id>.jsonl` file that exists, or nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-transcripts-"));
  try {
    writeFileSync(join(dir, "2026-09-26T10-00-00-000Z_abc.jsonl"), "");
    writeFileSync(join(dir, "2026-09-27T10-00-00-000Z_abc.jsonl"), "");
    writeFileSync(join(dir, "2026-09-27T11-00-00-000Z_abc-h1.jsonl"), "");
    assert.equal(findTranscriptPath(dir, "abc"), join(dir, "2026-09-27T10-00-00-000Z_abc.jsonl"),
      "the newest file of THIS id — not its -h1 successor's");
    assert.equal(findTranscriptPath(dir, "abc-h1"), join(dir, "2026-09-27T11-00-00-000Z_abc-h1.jsonl"));
    assert.equal(findTranscriptPath(dir, "missing"), undefined, "no file ⇒ no pointer to a path that does not exist");
    assert.equal(findTranscriptPath(join(dir, "nope"), "abc"), undefined, "an unreadable dir is not a crash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("piSessionsRoot reads the SAME rule as sessionDirForCwd, override included (t9 quality round)", () => {
  // The reader starts from a session id and has no cwd to encode, so it needs
  // the root rather than one session's dir — and it must not disagree with the
  // writer: an override IS the root (pi lists the `.jsonl` files directly in
  // it), so returning `<home>/.pi/agent/sessions` under the override pointed
  // the daemon at a directory nothing writes to.
  assert.equal(piSessionsRoot(HOME, {}), join(HOME, ".pi", "agent", "sessions"), "no override ⇒ pi's default layout");
  assert.equal(
    piSessionsRoot(HOME, { PI_CODING_AGENT_DIR: "/custom/agent-dir" }),
    join("/custom/agent-dir", "sessions"),
    "the agent-dir override still moves it",
  );
  assert.equal(
    piSessionsRoot(HOME, { PI_CODING_AGENT_SESSION_DIR: "/custom/sessions" }),
    "/custom/sessions",
    "the session-dir override IS the root — no encoded subdir",
  );
  assert.equal(piSessionsRoot(HOME, { TAU_CODING_AGENT_SESSION_DIR: "~/tau-sessions" }), join(HOME, "tau-sessions"));
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
