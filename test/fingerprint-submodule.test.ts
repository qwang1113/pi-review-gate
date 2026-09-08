// Submodule fingerprint regressions + root/subdirectory parity. Split out of
// test/fingerprint.test.ts (2026-09-08) because these suites build real
// submodule graphs (parent + submodule + nested) and dominated that file's
// wall time; they now run as their own file under node --test. The shared
// repo fixture (makeRepo) comes from test/helpers/fingerprint-race.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { neutraliseHostGitConfig } from "./helpers/git.ts";
import { makeRepo, cleanupRaceDirs } from "./helpers/fingerprint-race.ts";

neutraliseHostGitConfig();

const {
  computeFingerprint,
} = await import(
  join(resolve(import.meta.dirname ?? "."), "..", "lib", "fingerprint.ts")
);

after(cleanupRaceDirs);

// SUBMODULES (found by independent review): a parent tree stores only each
// submodule's committed gitlink, so edits INSIDE a checked-out submodule leave
// the parent tree bit-identical. The pre-change diff/status fingerprint DID
// catch this, so relying on the tree hash alone was a regression.
test("an edit inside a checked-out submodule changes the fingerprint", (t) => {
  const parent = makeRepo();
  const sub = makeRepo();
  writeFileSync(join(sub, "s.ts"), "// sub v1\n");
  execFileSync("git", ["add", "s.ts"], { cwd: sub, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "sub"], {
    cwd: sub, stdio: "ignore",
  });
  try {
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", sub, "sm"], {
      cwd: parent, stdio: "ignore",
    });
  } catch {
    // Some git builds/policies forbid local-path submodules outright.
    t.skip("submodule add unsupported in this environment");
    return;
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add sm"], {
    cwd: parent, stdio: "ignore",
  });

  const before = computeFingerprint(parent);
  writeFileSync(join(parent, "sm", "s.ts"), "// sub v2 CHANGED\n");
  const after = computeFingerprint(parent);
  assert.notEqual(
    after.digest,
    before.digest,
    "an edit inside a submodule must invalidate the parent's READY binding",
  );

  // ...and the submodule probe must not break staging-invariance.
  const dirty = computeFingerprint(parent);
  execFileSync("git", ["add", "-A"], { cwd: parent, stdio: "ignore" });
  assert.equal(
    computeFingerprint(parent).digest,
    dirty.digest,
    "staging in the parent repo must not change the digest",
  );

  // ROUND-2 FINDING: hashing `git status` TEXT bound only the state, not the
  // content. A SECOND edit to an already-dirty file leaves the status line
  // ("M s.ts") byte-identical, so the digest did not move and the unreviewed
  // second version could still be committed inside the submodule.
  const dirtyA = computeFingerprint(parent);
  writeFileSync(join(parent, "sm", "s.ts"), "// DIRTY version B, entirely different\n");
  assert.notEqual(
    computeFingerprint(parent).digest,
    dirtyA.digest,
    "a second edit to an already-dirty submodule file must still change the digest " +
      "(the probe must bind CONTENT, not `git status` text)",
  );
});

// ROUND-2 FINDING: submodule detection read `git config --file .gitmodules`,
// which returns the same empty result for "no submodules" and "this file is
// corrupt" — so a malformed .gitmodules silently disabled submodule coverage
// entirely. Detection now reads gitlinks from the index, which is
// authoritative and survives a broken .gitmodules.
test("a malformed .gitmodules does not silently disable submodule coverage", (t) => {
  const parent = makeRepo();
  const sub = makeRepo();
  writeFileSync(join(sub, "s.ts"), "// sub v1\n");
  execFileSync("git", ["add", "s.ts"], { cwd: sub, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "sub"], {
    cwd: sub, stdio: "ignore",
  });
  try {
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", sub, "sm"], {
      cwd: parent, stdio: "ignore",
    });
  } catch {
    t.skip("submodule add unsupported in this environment");
    return;
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add sm"], {
    cwd: parent, stdio: "ignore",
  });
  // Corrupt .gitmodules while the gitlink stays valid.
  writeFileSync(join(parent, ".gitmodules"), '[submodule "sm"\n  broken = \n');
  execFileSync("git", ["add", ".gitmodules"], { cwd: parent, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "break"], {
    cwd: parent, stdio: "ignore",
  });

  const before = computeFingerprint(parent);
  writeFileSync(join(parent, "sm", "s.ts"), "// changed despite malformed .gitmodules\n");
  assert.notEqual(
    computeFingerprint(parent).digest,
    before.digest,
    "submodule edits must still be detected when .gitmodules is unparseable",
  );
});

// An uninitialized / deinit'd submodule is a legitimate, common state (CI,
// shallow checkouts). It has no working content to review, and the parent's
// gitlink already pins it, so it must NOT make the fingerprint unavailable —
// that would brick every commit (the B2 lesson: a new sub-gate must never make
// legitimate work impossible).
test("a deinit'd submodule does not brick the fingerprint", (t) => {
  const parent = makeRepo();
  const sub = makeRepo();
  writeFileSync(join(sub, "s.ts"), "// sub\n");
  execFileSync("git", ["add", "s.ts"], { cwd: sub, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "sub"], {
    cwd: sub, stdio: "ignore",
  });
  try {
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", sub, "sm"], {
      cwd: parent, stdio: "ignore",
    });
  } catch {
    t.skip("submodule add unsupported in this environment");
    return;
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add sm"], {
    cwd: parent, stdio: "ignore",
  });
  execFileSync("git", ["submodule", "deinit", "-f", "sm"], { cwd: parent, stdio: "ignore" });

  const fp = computeFingerprint(parent);
  assert.equal(fp.unavailable, false, "a deinit'd submodule must not make the fingerprint unavailable");
  assert.match(fp.digest, /^[0-9a-f]{40,64}$/);
  // Still stable across repeated calls (bindable).
  assert.equal(computeFingerprint(parent).digest, fp.digest);
});

// ---------------------------------------------------------------------------
// CWD PARITY (found by independent review). The extension computes the
// fingerprint from the SESSION cwd, which may be a subdirectory; the git hooks
// always run at the repo toplevel. If the two disagree, the hook rejects a
// binding the extension just made — "code was modified after the last READY
// review" with no way to satisfy it. `git ls-files` reports cwd-relative paths
// by default ("../../sm"), and submoduleDigest() mixes the path text into the
// digest, so this was reproducible: fp(root) != fp(deep/work).
// ---------------------------------------------------------------------------

test("fingerprint is identical from the repo root and from a subdirectory", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, "deep", "work"), { recursive: true });
  writeFileSync(join(dir, "deep", "work", "a.ts"), "// a");
  writeFileSync(join(dir, "top.ts"), "// top");
  assert.equal(
    computeFingerprint(join(dir, "deep", "work")).digest,
    computeFingerprint(dir).digest,
    "a plain repo must hash identically from any directory inside it",
  );
});

test("fingerprint with a SUBMODULE is identical from the root and a subdirectory", (t) => {
  const parent = makeRepo();
  const sub = makeRepo();
  writeFileSync(join(sub, "s.ts"), "// sub v1\n");
  execFileSync("git", ["add", "s.ts"], { cwd: sub, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "sub"], {
    cwd: sub, stdio: "ignore",
  });
  try {
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", sub, "sm"], {
      cwd: parent, stdio: "ignore",
    });
  } catch {
    t.skip("submodule add unsupported in this environment");
    return;
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add sm"], {
    cwd: parent, stdio: "ignore",
  });
  mkdirSync(join(parent, "deep", "work"), { recursive: true });

  const fromRoot = computeFingerprint(parent);
  const fromSubdir = computeFingerprint(join(parent, "deep", "work"));
  assert.equal(fromSubdir.digest, fromRoot.digest,
    "the submodule path must enter the digest repo-root-relative, not cwd-relative");

  // Parity must survive an actual submodule edit, not just the clean state.
  writeFileSync(join(parent, "sm", "s.ts"), "// sub v2 CHANGED\n");
  const dirtyRoot = computeFingerprint(parent);
  const dirtySubdir = computeFingerprint(join(parent, "deep", "work"));
  assert.notEqual(dirtyRoot.digest, fromRoot.digest, "the edit must still be seen");
  assert.equal(dirtySubdir.digest, dirtyRoot.digest, "and both cwds must still agree");
});

test("fingerprint with a NESTED submodule is identical from the root and a subdirectory", (t) => {
  const inner = makeRepo();
  writeFileSync(join(inner, "i.ts"), "// inner v1\n");
  execFileSync("git", ["add", "i.ts"], { cwd: inner, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "inner"], {
    cwd: inner, stdio: "ignore",
  });
  const outer = makeRepo();
  const parent = makeRepo();
  try {
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", inner, "nested"], {
      cwd: outer, stdio: "ignore",
    });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "nest"], {
      cwd: outer, stdio: "ignore",
    });
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", outer, "sm"], {
      cwd: parent, stdio: "ignore",
    });
  } catch {
    t.skip("submodule add unsupported in this environment");
    return;
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add sm"], {
    cwd: parent, stdio: "ignore",
  });
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"], {
    cwd: parent, stdio: "ignore",
  });
  mkdirSync(join(parent, "deep", "work"), { recursive: true });

  assert.equal(
    computeFingerprint(join(parent, "deep", "work")).digest,
    computeFingerprint(parent).digest,
    "nested submodule recursion must also be cwd-independent",
  );
});
