import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  CODE_EXTENSIONS,
  DOC_EXTENSIONS,
  isCodeFile,
  isDocFile,
  isSensitiveFile,
  coalesceToolPath,
  COMMIT_MSG_FORBIDDEN,
} from "../lib/constants.ts";
import { computeFingerprint, FINGERPRINT_VERSION, GIT_LOCATION_ENV, gitBaseEnv } from "../lib/fingerprint.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// PR #7 lesson 5 — structural consistency: exactly ONE code-extension list.
// No other source file may declare its own extension alternation. If a file
// needs to know "is this code?", it must import from lib/constants.ts.
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "test") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs)$/.test(entry)) out.push(p);
  }
  return out;
}

test("structural: no source file other than lib/constants.ts declares a code-extension list", () => {
  const files = walk(ROOT).filter((f) => !f.endsWith("lib/constants.ts"));
  // A "code-extension list" = a string/array literal containing >= 5 of our
  // known extensions in one expression. Heuristic mirrors 's
  // code-extension-consistency test: keying on any single token would miss
  // drift; a structural threshold catches any re-declared list.
  const needles = ["tsx", "jsx", "ipynb", "pyw", "kts", "hpp", "exs"]; // uncommon members
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const line of src.split("\n")) {
      const hits = needles.filter((n) => new RegExp(`[\"'\\|]${n}[\"'\\|]`).test(line)).length;
      assert.ok(
        hits < 3,
        `${file} appears to declare its own extension list (${hits} uncommon extension tokens on one line):\n${line.trim()}\n` +
          "Import CODE_EXTENSIONS from lib/constants.ts instead.",
      );
    }
  }
});

test("ipynb is a code extension (PR #7 NotebookEdit bypass regression)", () => {
  assert.ok(CODE_EXTENSIONS.includes("ipynb"));
  assert.ok(isCodeFile("/proj/analysis.ipynb"));
});

test("shell scripts are code (is .sh-primary; gate must engage)", () => {
  for (const f of ["hooks/x.sh", "a.bash", "b.zsh"]) assert.ok(isCodeFile(f), f);
});

test("docs classified separately from code", () => {
  assert.ok(isDocFile("README.md"));
  assert.ok(isDocFile("docs/a.mdx"));
  assert.ok(!isCodeFile("README.md"));
  assert.ok(!isDocFile("a.ts"));
});

test("no overlap between code and doc extension sets", () => {
  const overlap = CODE_EXTENSIONS.filter((e) => DOC_EXTENSIONS.includes(e));
  assert.deepEqual(overlap, []);
});

test("extensionless and dotfiles are neither code nor docs", () => {
  assert.ok(!isCodeFile("Makefile"));
  assert.ok(!isCodeFile(".gitignore"));
  assert.ok(!isDocFile("LICENSE"));
});

// ---------------------------------------------------------------------------
// PR #7 lesson 4 — path coalescing across parameter spellings
// ---------------------------------------------------------------------------

test("coalesceToolPath reads every known path parameter spelling", () => {
  assert.equal(coalesceToolPath({ path: "/a.ts" }), "/a.ts");
  assert.equal(coalesceToolPath({ file_path: "/b.ts" }), "/b.ts");
  assert.equal(coalesceToolPath({ filePath: "/c.ts" }), "/c.ts");
  assert.equal(coalesceToolPath({ notebook_path: "/d.ipynb" }), "/d.ipynb");
  assert.equal(coalesceToolPath({ notebookPath: "/e.ipynb" }), "/e.ipynb");
  assert.equal(coalesceToolPath({}), undefined);
  assert.equal(coalesceToolPath(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Sensitive files
// ---------------------------------------------------------------------------

test("sensitive file patterns", () => {
  for (const f of [
    ".env",
    "/proj/.env",
    "certs/server.pem",
    "id_rsa",
    "/home/u/.ssh/id_ed25519",
    "secrets.yaml",
    "credentials",
    ".npmrc",
    "auth.json",
  ]) {
    assert.ok(isSensitiveFile(f), `should be sensitive: ${f}`);
  }
  // .env variants (template/local/production) are not secrets — only `.env` itself is blocked.
  for (const f of ["src/env.ts", "environment.md", "src/auth.service.ts", "key-utils.ts", "envelope.ts", ".env.template", "/proj/.env.local", "config/.env.production"]) {
    assert.ok(!isSensitiveFile(f), `should NOT be sensitive: ${f}`);
  }
});

// sd0x-dev-flow pre-edit-guard port: .git internals are never editable — the
// model could otherwise rewrite .git/hooks/pre-commit and disarm the L3 layer.
test(".git internals are sensitive (pre-edit-guard port)", () => {
  for (const f of [".git/config", ".git/hooks/pre-commit", "/repo/.git/HEAD", "sub/.git"]) {
    assert.ok(isSensitiveFile(f), `should be sensitive: ${f}`);
  }
  // .gitignore / .github and lookalike names must NOT be blocked.
  for (const f of [".gitignore", ".github/workflows/ci.yml", "src/.gitkeep", "digit.ts", "legit/file.ts"]) {
    assert.ok(!isSensitiveFile(f), `should NOT be sensitive: ${f}`);
  }
});

// ---------------------------------------------------------------------------
// PR #7 lesson 8 — commit message word boundaries
// ---------------------------------------------------------------------------

function anyMatch(msg: string): boolean {
  return COMMIT_MSG_FORBIDDEN.some((re) => re.test(msg));
}

test("FP regression: 'Generated by the maintainer' passes (ai inside maintainer)", () => {
  assert.ok(!anyMatch("docs: update runbook\n\nGenerated by the maintainer script."));
});

test("FP regression: 'Generated by domain tooling' passes", () => {
  assert.ok(!anyMatch("chore: regen\n\nGenerated by domain tooling."));
});

test("blocks 'Generated by AI assistant' (bounded AI)", () => {
  assert.ok(anyMatch("feat: x\n\nGenerated by AI assistant"));
});

test("blocks 'Generated with ChatGPT' (unbounded GPT)", () => {
  assert.ok(anyMatch("feat: x\n\nGenerated with ChatGPT"));
});

test("blocks 'Generated by OpenAI Codex' (explicit OpenAI)", () => {
  assert.ok(anyMatch("feat: x\n\nGenerated by OpenAI Codex"));
});

test("blocks Co-Authored-By Claude trailer", () => {
  assert.ok(anyMatch("fix: y\n\nCo-Authored-By: Claude <noreply@anthropic.com>"));
});

test("blocks robot-emoji attribution", () => {
  assert.ok(anyMatch("feat: z\n\n🤖 Generated with Claude Code"));
});

test("normal conventional commit passes", () => {
  assert.ok(!anyMatch("feat: add session reset logic\n\nDetails here."));
});

// ---------------------------------------------------------------------------
// CJS fingerprint script drift guard
// ---------------------------------------------------------------------------
// The former "CODE_DOC_EXT matches constants.ts" test was REMOVED, not
// weakened: compute-fingerprint.cjs no longer classifies files by extension
// at all. It now hashes a real git tree, and git hashes every file regardless
// of extension, so there is no extension list left to drift. Keeping the test
// would have meant re-introducing a dead constant purely to be asserted on.
//
// TS↔CJS drift is still covered, and more strongly, by
// test/fingerprint.test.ts "parity: compute-fingerprint.cjs emits the same
// digest as lib/fingerprint.ts", which compares actual digests over a
// staged + unstaged + untracked + gate-owned-path mix rather than a literal.

// Rather than grep for another test's TITLE (which would still pass if that
// test's body were emptied), assert the drift guard BEHAVIOURALLY here: run
// both implementations over a non-trivial worktree and require identical
// digests. This is a real check, not a check that a check exists.
test("TS and CJS fingerprint implementations agree (drift guard)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-drift-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init");
    git("config", "core.excludesFile", "/dev/null");
    // Mixed shape: committed + staged + unstaged + untracked + gate-owned.
    writeFileSync(join(dir, "code.ts"), "// v1\n");
    git("add", "code.ts");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init");
    writeFileSync(join(dir, "code.ts"), "// v2\n");
    git("add", "code.ts");
    writeFileSync(join(dir, "code.ts"), "// v3 unstaged\n");
    writeFileSync(join(dir, "notes.md"), "docs\n");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "review-gate-state.json"), "{}");

    const tsFp = computeFingerprint(dir);
    const cjsFp = JSON.parse(
      execFileSync("node", [join(ROOT, "scripts", "compute-fingerprint.cjs"), dir], { encoding: "utf8" }),
    );
    assert.equal(tsFp.unavailable, false);
    assert.equal(cjsFp.unavailable, false);
    assert.equal(
      cjsFp.digest,
      tsFp.digest,
      "lib/fingerprint.ts and scripts/compute-fingerprint.cjs drifted — the git hooks " +
        "use the CJS copy, so any divergence makes every hook fail closed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The parity check above contains no submodule, so both implementations could
// omit submodule coverage identically and still agree. Exercise that path
// explicitly: assert parity AND that both actually detect submodule content.
test("TS and CJS agree on a repo WITH a dirty submodule (parity covers submodules)", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "rg-drift-par-"));
  const sub = mkdtempSync(join(tmpdir(), "rg-drift-sub-"));
  const commit = (cwd: string, msg: string) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", msg], { cwd, stdio: "ignore" });
  try {
    for (const d of [parent, sub]) {
      execFileSync("git", ["init"], { cwd: d, stdio: "ignore" });
      execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: d, stdio: "ignore" });
    }
    writeFileSync(join(sub, "s.ts"), "// sub v1\n");
    execFileSync("git", ["add", "s.ts"], { cwd: sub, stdio: "ignore" });
    commit(sub, "sub init");

    writeFileSync(join(parent, "app.ts"), "// base\n");
    execFileSync("git", ["add", "app.ts"], { cwd: parent, stdio: "ignore" });
    commit(parent, "init");
    try {
      execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", sub, "sm"], {
        cwd: parent, stdio: "ignore",
      });
    } catch {
      t.skip("submodule add unsupported in this environment");
      return;
    }
    commit(parent, "add sm");

    const cjs = (d: string) =>
      JSON.parse(execFileSync("node", [join(ROOT, "scripts", "compute-fingerprint.cjs"), d], { encoding: "utf8" }));

    const tsClean = computeFingerprint(parent);
    const cjsClean = cjs(parent);
    assert.equal(cjsClean.digest, tsClean.digest, "TS/CJS drift with a clean submodule");

    // Dirty the submodule; BOTH implementations must move, and agree.
    writeFileSync(join(parent, "sm", "s.ts"), "// sub v2 CHANGED\n");
    const tsDirty = computeFingerprint(parent);
    const cjsDirty = cjs(parent);
    assert.notEqual(tsDirty.digest, tsClean.digest, "TS impl missed a submodule edit");
    assert.notEqual(cjsDirty.digest, cjsClean.digest, "CJS impl missed a submodule edit");
    assert.equal(cjsDirty.digest, tsDirty.digest, "TS/CJS drift with a dirty submodule");
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(sub, { recursive: true, force: true });
  }
});

// The cwd-parity bug was mirrored in BOTH implementations, and it is exactly
// the extension-vs-hook split that makes it dangerous: the extension binds a
// verdict from the session cwd (possibly a subdirectory) while the hook always
// runs at the toplevel. Assert the cross-implementation, cross-cwd square.
test("TS (subdirectory) and CJS (repo root) agree on a repo with a submodule", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "rg-cwd-par-"));
  const sub = mkdtempSync(join(tmpdir(), "rg-cwd-sub-"));
  const commit = (cwd: string, msg: string) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", msg], { cwd, stdio: "ignore" });
  try {
    for (const d of [parent, sub]) {
      execFileSync("git", ["init"], { cwd: d, stdio: "ignore" });
      execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: d, stdio: "ignore" });
    }
    writeFileSync(join(sub, "s.ts"), "// sub v1\n");
    execFileSync("git", ["add", "s.ts"], { cwd: sub, stdio: "ignore" });
    commit(sub, "sub init");

    writeFileSync(join(parent, "app.ts"), "// base\n");
    execFileSync("git", ["add", "app.ts"], { cwd: parent, stdio: "ignore" });
    commit(parent, "init");
    try {
      execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", sub, "sm"], {
        cwd: parent, stdio: "ignore",
      });
    } catch {
      t.skip("submodule add unsupported in this environment");
      return;
    }
    commit(parent, "add sm");
    mkdirSync(join(parent, "deep", "work"), { recursive: true });

    const cjs = (d: string) =>
      JSON.parse(execFileSync("node", [join(ROOT, "scripts", "compute-fingerprint.cjs"), d], { encoding: "utf8" }));

    // extension-from-subdirectory vs hook-at-toplevel: the real pairing.
    assert.equal(
      computeFingerprint(join(parent, "deep", "work")).digest,
      cjs(parent).digest,
      "an extension session in a subdirectory would bind a verdict the root-run hook rejects",
    );
    // ...and the CJS mirror must itself be cwd-independent.
    assert.equal(cjs(join(parent, "deep", "work")).digest, cjs(parent).digest,
      "compute-fingerprint.cjs is not cwd-independent");
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(sub, { recursive: true, force: true });
  }
});

// TS/CJS parity for the sanitized environment: if one implementation strips a
// relocating variable and the other does not, the extension and the git hooks
// can be pointed at different repositories — the same fail-open that motivated
// stripping them at all.
test("TS and CJS strip the SAME git location variables", () => {
  const cjsSource = readFileSync(join(ROOT, "scripts", "compute-fingerprint.cjs"), "utf8");
  const divSource = readFileSync(join(ROOT, "scripts", "check-staged-divergence.cjs"), "utf8");
  for (const source of [cjsSource, divSource]) {
    const block = /GIT_LOCATION_ENV\s*=\s*\[([^\]]*)\]/.exec(source);
    assert.ok(block, "each script must declare GIT_LOCATION_ENV");
    const names = [...block![1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(names, [...GIT_LOCATION_ENV].sort(),
      "lib/fingerprint.ts and the CJS mirrors drifted on which variables are stripped");
    // The config-injection family is matched by PREFIX (the numbered
    // GIT_CONFIG_KEY_<n>/VALUE_<n> forms are unbounded), so assert the pattern
    // itself is mirrored rather than a list.
    assert.match(source, /GIT_CONFIG_ENV_PREFIX\s*=\s*\/\^GIT_CONFIG\(_\|\$\)\//,
      "each script must strip the GIT_CONFIG_* injection family by prefix");
  }
});

test("the sanitized env actually removes every listed variable", () => {
  const saved: Record<string, string | undefined> = {};
  try {
    const injected = [
      ...GIT_LOCATION_ENV,
      // The config-injection family, including numbered forms far past _0.
      "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
      "GIT_CONFIG_KEY_17", "GIT_CONFIG_VALUE_17",
    ];
    for (const key of injected) { saved[key] = process.env[key]; process.env[key] = "/poison"; }
    const env = gitBaseEnv();
    for (const key of injected) {
      assert.equal(env[key], undefined, `${key} must not survive into the git environment`);
    }
    assert.equal(env.PATH, process.env.PATH, "unrelated variables must be preserved");
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]!;
    }
  }
});

// A fingerprint binding is only meaningful under the algorithm that produced
// it, and the hook decides "migration vs code change" by comparing the
// sidecar's version against the version the CJS mirror reports. If the two
// implementations disagree about their own version, every commit would be
// reported as an endless migration (or, worse, a real algorithm change would
// go unnoticed and be reported as a code modification).
test("TS and CJS agree on FINGERPRINT_VERSION", () => {
  const cjs = readFileSync(join(ROOT, "scripts", "compute-fingerprint.cjs"), "utf8");
  const declared = /const FINGERPRINT_VERSION = (\d+);/.exec(cjs);
  assert.ok(declared, "the CJS mirror must declare FINGERPRINT_VERSION");
  assert.equal(Number(declared![1]), FINGERPRINT_VERSION,
    "lib/fingerprint.ts and scripts/compute-fingerprint.cjs drifted on the algorithm version");
});

test("the CJS mirror emits its version in every result, including UNAVAILABLE", () => {
  const cjs = readFileSync(join(ROOT, "scripts", "compute-fingerprint.cjs"), "utf8");
  assert.match(cjs, /UNAVAILABLE = \{[^}]*version: FINGERPRINT_VERSION/s,
    "a fail-closed result must still carry the version the hook compares against");
  assert.match(cjs, /return \{ digest, head, unavailable: false, version: FINGERPRINT_VERSION \}/,
    "the success path must report the version too");
});

test("the TS implementation exposes the SAME sharing API as the CJS mirror", () => {
  // The two are asserted to be mirrors, and a divergence in the sharing API is
  // invisible in the digest — it only shows up as a silently reintroduced
  // double materialization. Check the shape textually (the TS function is not
  // exported) plus the CJS behaviour above.
  const ts = readFileSync(join(resolve(import.meta.dirname ?? "."), "..", "lib", "fingerprint.ts"), "utf8");
  assert.match(ts, /treeOidForCwd\?: \(cwd: string\) => string/,
    "TS must offer the per-cwd resolver, not a single tree OID");
  assert.match(ts, /submoduleDigest\(cwd: string, depth: number, opts\?: WorktreeDigestOptions\)/,
    "TS submodule recursion must accept the resolver");
  assert.match(ts, /worktreeDigest\(subCwd, depth \+ 1, opts\)/,
    "TS submodule recursion must FORWARD the resolver (the CJS mirror shipped this bug)");
  assert.ok(!/opts\?: \{ treeOid\?: string \}/.test(ts),
    "the single-OID API must be gone, so it cannot be reintroduced by copy-paste");

  const cjs = readFileSync(
    join(resolve(import.meta.dirname ?? "."), "..", "scripts", "compute-fingerprint.cjs"), "utf8");
  assert.match(cjs, /treeOidForCwd/, "CJS must use the same option name");
  assert.ok(!/opts\.treeOid\b(?!ForCwd)/.test(cjs),
    "no stale references to the replaced single-OID option");
});
