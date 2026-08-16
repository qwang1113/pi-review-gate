import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = join(ROOT, "scripts", "install-package.mjs");
const HOOK_INSTALLER = join(ROOT, "scripts", "install-git-hooks.sh");

const tempDirs: string[] = [];
function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-pkg-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function runInstaller(home: string, cwd = ROOT) {
  return spawnSync("node", [INSTALLER], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, HOME: home },
  });
}

// ---------------------------------------------------------------------------
// Pi package manifest — the repo must stay a valid, publishable pi package.
// ---------------------------------------------------------------------------

test("package.json is a publishable pi package (manifest, peers, postinstall)", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
  // pi-package keyword for gallery discoverability.
  assert.ok((pkg.keywords as string[]).includes("pi-package"), "missing pi-package keyword");
  // pi manifest: extensions + skills as DIRECTORY globs that exist.
  const pi = pkg.pi as { extensions?: string[]; skills?: string[] };
  assert.ok(pi, "missing pi manifest");
  for (const dir of [...(pi.extensions ?? []), ...(pi.skills ?? [])]) {
    assert.ok(existsSync(join(ROOT, dir)), `pi manifest path missing: ${dir}`);
  }
  // pi ecosystem peers must not be bundled; pdw stays a runtime dependency.
  const peers = (pkg.peerDependencies ?? {}) as Record<string, string>;
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"]) {
    assert.equal(peers[name], "*", `${name} must be a "*" peerDependency`);
  }
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  assert.ok(deps["@quintinshaw/pi-dynamic-workflows"], "pdw must stay a runtime dependency");
  // postinstall drives the agents+hooks installer on `pi install` / `npm install`.
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  assert.match(scripts.postinstall ?? "", /install-package\.mjs/, "postinstall must run the package installer");
  assert.ok(existsSync(join(ROOT, "scripts", "install-package.mjs")), "install-package.mjs missing");
});

// ---------------------------------------------------------------------------
// postinstall installer behavior
// ---------------------------------------------------------------------------

// The postinstall installer is what `pi install` / `npm install` runs. It must
// copy the shipped sub-agents into ~/.pi/agent/agents/ (pi-subagents loads
// them from there — the pi package spec has no agents resource type).
test("postinstall copies agents/*.md into ~/.pi/agent/agents/", () => {
  const home = makeHome();
  const res = runInstaller(home);
  assert.equal(res.status, 0, `installer failed: ${res.stderr}`);

  const agentsDir = join(home, ".pi", "agent", "agents");
  for (const f of ["reviewer.md", "adviser.md", "recon.md", "triage.md"]) {
    assert.ok(existsSync(join(agentsDir, f)), `${f} missing from installed agents dir`);
  }
  // The installed copy must be the SHIPPED version (repo is the source of truth).
  const shipped = readFileSync(join(ROOT, "agents", "reviewer.md"), "utf8");
  const installed = readFileSync(join(agentsDir, "reviewer.md"), "utf8");
  assert.equal(installed, shipped, "installed reviewer.md differs from the shipped one");
});

test("postinstall overwrites stale agent copies (repo is the single source of truth)", () => {
  const home = makeHome();
  const agentsDir = join(home, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "reviewer.md"), "stale garbage");
  writeFileSync(join(agentsDir, "custom-unmanaged.md"), "keep me"); // not ours — untouched

  const res = runInstaller(home);
  assert.equal(res.status, 0, `installer failed: ${res.stderr}`);
  assert.equal(readFileSync(join(agentsDir, "reviewer.md"), "utf8"),
    readFileSync(join(ROOT, "agents", "reviewer.md"), "utf8"),
    "stale reviewer.md must be overwritten with the shipped version");
  assert.equal(readFileSync(join(agentsDir, "custom-unmanaged.md"), "utf8"), "keep me",
    "unmanaged agent files must be left alone");
});

test("postinstall is idempotent (re-run succeeds and is stable)", () => {
  const home = makeHome();
  const first = runInstaller(home);
  const second = runInstaller(home);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0, `second run failed: ${second.stderr}`);
  assert.equal(
    readFileSync(join(home, ".pi", "agent", "agents", "recon.md"), "utf8"),
    readFileSync(join(ROOT, "agents", "recon.md"), "utf8"),
  );
});

test("postinstall installs git hooks when cwd is a git repo, skips otherwise", () => {
  const home = makeHome();
  // Non-git cwd: no hooks, still exit 0.
  const plain = mkdtempSync(join(tmpdir(), "rg-pkg-plain-"));
  tempDirs.push(plain);
  const noGit = runInstaller(home, plain);
  assert.equal(noGit.status, 0, "non-git cwd must not fail");
  assert.ok(!existsSync(join(plain, ".git", "hooks", "pre-commit")), "hooks must not be installed outside a git repo");

  // Git repo cwd: hooks land in .git/hooks with the pi-review-gate marker.
  const repo = mkdtempSync(join(tmpdir(), "rg-pkg-repo-"));
  tempDirs.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  const res = runInstaller(home, repo);
  assert.equal(res.status, 0, `installer in git repo failed: ${res.stderr}`);
  const hook = join(repo, ".git", "hooks", "pre-commit");
  assert.ok(existsSync(hook), "pre-commit hook missing after install in a git repo");
  assert.match(readFileSync(hook, "utf8"), /pi-review-gate:installed/, "hook must carry the pi-review-gate marker");
});

// The installed hook is a wrapper that `exec`s the original hook file in the
// PACKAGE (hooks/ dir), which resolves its scripts as ../scripts/… inside the
// package — so the package layout (hooks/ + scripts/ siblings) must satisfy
// the fingerprint-script lookup. Regression for the old global-install copy.
test("installed pre-commit wrapper resolves the package's fingerprint script", () => {
  const home = makeHome();
  const repo = mkdtempSync(join(tmpdir(), "rg-pkg-repo2-"));
  tempDirs.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], { cwd: repo, stdio: "ignore" });
  mkdirSync(join(repo, ".pi"), { recursive: true });
  writeFileSync(join(repo, ".pi", "review-gate-state.json"), JSON.stringify({
    schema: 1,
    sessionId: "test-session",
    hasCodeChange: false,
    hasDocChange: false,
    review: { verdict: "PENDING", fingerprint: null, at: null },
    precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
    rounds: [],
    maxRounds: 10,
    bypass: { active: false, reason: null, at: null },
    updatedAt: "t",
  }));

  const res = runInstaller(home, repo);
  assert.equal(res.status, 0, `installer failed: ${res.stderr}`);
  const hook = spawnSync("bash", [join(repo, ".git", "hooks", "pre-commit")], { cwd: repo, encoding: "utf8" });
  assert.equal(hook.status, 0, `installed hook failed: ${hook.stderr}`);
  assert.ok(
    !/cannot compute worktree fingerprint/.test(hook.stderr),
    `hook could not find fingerprint script: ${hook.stderr}`,
  );
});

// npm/npx exposes the hook installer as a node_modules/.bin symlink; the
// installer must resolve it to the real file so ../hooks resolves to the
// package's hooks/ dir, not node_modules/.
test("install-git-hooks resolves its own symlink (npm .bin entrypoint works)", () => {
  const home = makeHome();
  const repo = mkdtempSync(join(tmpdir(), "rg-pkg-repo3-"));
  tempDirs.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });

  const binDir = join(home, "fake_node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  symlinkSync(HOOK_INSTALLER, join(binDir, "pi-review-gate-install-hooks"));

  const res = spawnSync("bash", [join(binDir, "pi-review-gate-install-hooks")], {
    encoding: "utf8",
    cwd: repo,
    env: { ...process.env, HOME: home },
  });
  assert.equal(res.status, 0, `hook installer via symlink failed: ${res.stderr}`);
  assert.ok(existsSync(join(repo, ".git", "hooks", "pre-commit")), "hooks not installed via symlinked entrypoint");
  assert.ok(!/No such file or directory/.test(res.stderr), `symlink resolution broken: ${res.stderr}`);
});
