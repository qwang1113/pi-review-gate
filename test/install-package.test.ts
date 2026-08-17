import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = join(ROOT, "scripts", "install-package.mjs");
const HOOK_INSTALLER = join(ROOT, "scripts", "install-git-hooks.sh");

// The pinned companion platform: every entry must also appear in
// COMPANION_PACKAGES in scripts/install-package.mjs (the manifest test
// cross-checks the two lists).
const COMPANION_EXPECTED = [
  "@narumitw/pi-lsp",
  "pi-anthropic-oauth",
  "pi-hashline-readmap",
  "pi-mcp-adapter",
  "pi-notify",
  "pi-opencode-bridge",
  "pi-subagents",
  "pi-vim",
  "pi-web-access",
];

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
  // Companion pi packages (the working platform): pinned as runtime deps so a
  // fresh `pi install pi-review-gate` resolves them and the postinstall
  // registers them via `pi install` — must match scripts/install-package.mjs
  // COMPANION_PACKAGES exactly, else a companion never gets registered.
  const installer = readFileSync(join(ROOT, "scripts", "install-package.mjs"), "utf8");
  const companions = [...installer.matchAll(/"npm:([^"]+)"/g)].map((m) => m[1]!.replace(/^@.*?\//, "")).sort();
  assert.ok(companions.length >= 8, `expected ≥8 companions, found ${companions.length}`);
  for (const dep of Object.keys(deps)) {
    if (dep.startsWith("@quintinshaw/") || dep.startsWith("@earendil-works/")) continue; // non-companion
    const bare = dep.replace(/^@.*?\//, "");
    if (companions.includes(bare)) continue;
    assert.fail(`companion ${dep} is a dependency but missing from COMPANION_PACKAGES`);
  }
  for (const spec of COMPANION_EXPECTED) {
    assert.ok(deps[spec], `${spec} must be pinned in dependencies`);
  }
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

// ---------------------------------------------------------------------------
// Companion package registration (pi-subagents / pi-opencode-bridge)
// ---------------------------------------------------------------------------

/**
 * Run the installer with a fake `pi` CLI on PATH that records every
 * `pi install <spec>` invocation instead of really installing. The fake
 * settings.json under HOME controls what the installer sees as registered.
 */
function runInstallerWithFakePi(home: string, pkgs: string[]): { status: number; stderr: string; installs: string[] } {
  const binDir = join(home, "fakebin");
  mkdirSync(binDir, { recursive: true });
  const logFile = join(home, "pi-installs.log");
  writeFileSync(join(binDir, "pi"), `#!/usr/bin/env bash\necho "$*" >> "${logFile}"\nexit 0\n`);
  // spawnSync("pi") needs an exec bit on the fake CLI.
  chmodSync(join(binDir, "pi"), 0o755);

  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: pkgs }, null, 2));

  const res = spawnSync("node", [INSTALLER], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
  });
  const installs = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean) : [];
  return { status: res.status ?? -1, stderr: res.stderr, installs };
}

test("postinstall registers missing companion packages via pi install", () => {
  const home = makeHome();
  // Fresh home with only opencode-bridge preinstalled: every other companion
  // must be registered, skipping the present one.
  const { status, stderr, installs } = runInstallerWithFakePi(home, ["npm:pi-opencode-bridge"]);
  assert.equal(status, 0, `installer failed: ${stderr}`);
  const expectedMissing = [
    "npm:pi-subagents",
    "npm:pi-anthropic-oauth",
    "npm:pi-mcp-adapter",
    "npm:pi-notify",
    "npm:pi-vim",
    "npm:pi-web-access",
    "npm:@narumitw/pi-lsp",
    "npm:pi-hashline-readmap",
  ];
  assert.deepEqual(installs, expectedMissing.map((s) => `install ${s}`));
});

test("postinstall registers several missing companions (partial home)", () => {
  const home = makeHome();
  // Only the two earliest companions preinstalled — the rest must be added in
  // COMPANION_PACKAGES order, skipping the present ones.
  const { status, stderr, installs } = runInstallerWithFakePi(home, ["npm:pi-subagents", "npm:pi-opencode-bridge"]);
  assert.equal(status, 0, `installer failed: ${stderr}`);
  const expectedMissing = [
    "npm:pi-anthropic-oauth",
    "npm:pi-mcp-adapter",
    "npm:pi-notify",
    "npm:pi-vim",
    "npm:pi-web-access",
    "npm:@narumitw/pi-lsp",
    "npm:pi-hashline-readmap",
  ];
  assert.deepEqual(installs, expectedMissing.map((s) => `install ${s}`));
});

test("postinstall skips companions already present in settings.json", () => {
  const home = makeHome();
  // ALL companions preinstalled: nothing may be re-registered.
  const all = [
    "npm:pi-subagents",
    "npm:pi-opencode-bridge",
    "npm:pi-anthropic-oauth",
    "npm:pi-mcp-adapter",
    "npm:pi-notify",
    "npm:pi-vim",
    "npm:pi-web-access",
    "npm:@narumitw/pi-lsp",
    "npm:pi-hashline-readmap",
  ];
  const { status, stderr, installs } = runInstallerWithFakePi(home, all);
  assert.equal(status, 0, `installer failed: ${stderr}`);
  assert.deepEqual(installs, [], "already-registered companions must not be reinstalled");
});

test("postinstall does not touch settings when there is no pi agent dir (no HOME .pi)", () => {
  const home = makeHome();
  // runInstaller (the shared helper) never created ~/.pi/agent/settings.json.
  const res = runInstaller(home);
  assert.equal(res.status, 0, `installer failed: ${res.stderr}`);
  assert.ok(!/companion already registered/.test(res.stdout), "unexpected companion log line");
});

test("postinstall registers ALL companions when settings.json has none", () => {
  const home = makeHome();
  const { status, stderr, installs } = runInstallerWithFakePi(home, []);
  assert.equal(status, 0, `installer failed: ${stderr}`);
  // Every npm: spec in COMPANION_PACKAGES must be registered, in order.
  const installerSrc = readFileSync(INSTALLER, "utf8");
  const specs = [...installerSrc.matchAll(/"npm:[^"]+"/g)].map((m) => m[0].slice(1, -1));
  assert.ok(specs.length >= 8, `expected ≥8 companions, got ${specs.length}`);
  assert.deepEqual(installs, specs.map((s) => `install ${s}`));
});

test("postinstall prunes the opencode-go models-store to deepseek-v4-flash only (USER REQUIREMENT)", () => {
  const home = makeHome();
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({
    "opencode-go": {
      models: [
        { id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" },
        { id: "qwen3.8-max" }, { id: "gpt-5.6-luna" },
      ],
    },
    "onekey": { models: [{ id: "gpt-5.6-sol" }] }, // other providers untouched
  }));
  const res = runInstaller(home);
  assert.equal(res.status, 0, `installer failed: ${res.stderr}`);
  assert.match(res.stdout, /pruned opencode-go models-store/);
  const store = JSON.parse(readFileSync(join(agentDir, "models-store.json"), "utf8")) as {
    "opencode-go": { models: Array<{ id: string }> };
    onekey: { models: Array<{ id: string }> };
  };
  assert.deepEqual(store["opencode-go"].models.map((m) => m.id), ["deepseek-v4-flash"]);
  assert.deepEqual(store.onekey.models.map((m) => m.id), ["gpt-5.6-sol"], "other providers must be untouched");
  // Backup exists and a second run is a no-op (idempotent).
  assert.ok(existsSync(join(agentDir, "models-store.json.bak")));
  const again = runInstaller(home);
  assert.equal(again.status, 0);
  assert.doesNotMatch(again.stdout, /pruned opencode-go models-store/, "already flash-only → no prune");
});

test("postinstall prune is fail-soft: corrupt models-store is left untouched", () => {
  const home = makeHome();
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models-store.json"), "{ not json");
  const res = runInstaller(home);
  assert.equal(res.status, 0, "a corrupt store must not fail the install");
  assert.match(res.stdout, /not valid JSON/);
  assert.equal(readFileSync(join(agentDir, "models-store.json"), "utf8"), "{ not json");
});
