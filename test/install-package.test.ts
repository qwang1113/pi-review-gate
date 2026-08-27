import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync, cpSync } from "node:fs";
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
  "pi-hashline-edit-pro",
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
  // pi ecosystem peers must not be bundled; the pdw engine is retired (step 2
  // of docs/handoff-remove-pdw.md) and must NOT be a dependency any more.
  const peers = (pkg.peerDependencies ?? {}) as Record<string, string>;
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"]) {
    assert.equal(peers[name], "*", `${name} must be a "*" peerDependency`);
  }
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  assert.equal(deps["@quintinshaw/pi-dynamic-workflows"], undefined, "the pdw engine was retired (docs/handoff-remove-pdw.md step 2)");
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
  for (const f of ["reviewer.md", "reviewer-readonly.md", "adviser.md", "arbiter.md", "fixer.md", "recon.md", "goal-auditor.md"]) {
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

test("postinstall removes retired agents left by older versions", () => {
  const home = makeHome();
  const agentsDir = join(home, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  // Files an older package version shipped and since retired — an upgrade
  // must delete them so pi-subagents stops loading the retired roles.
  for (const f of ["module-reviewer.md", "planner.md", "triage.md", "worker.md", "worker-readonly.md"]) {
    writeFileSync(join(agentsDir, f), "leftover from an older release");
  }
  writeFileSync(join(agentsDir, "custom-unmanaged.md"), "keep me"); // not ours — untouched

  const res = runInstaller(home);
  assert.equal(res.status, 0, `installer failed: ${res.stderr}`);
  for (const f of ["module-reviewer.md", "planner.md", "triage.md", "worker.md", "worker-readonly.md"]) {
    assert.ok(!existsSync(join(agentsDir, f)), `${f} must be removed (retired agent)`);
  }
  assert.equal(readFileSync(join(agentsDir, "custom-unmanaged.md"), "utf8"), "keep me",
    "unmanaged agent files must be left alone");
});

test("postinstall global-layer model renderer exists and never touches the project layer", () => {
  // Exit criterion 2 is two halves: the installer renders the GLOBAL layer,
  // and (its cwd being untrustworthy) it never renders any PROJECT layer.
  const installerSrc = readFileSync(join(ROOT, "scripts", "install-package.mjs"), "utf8");
  assert.match(installerSrc, /function applyGlobalModelConfig\(/, "global model render must exist");
  const fn = installerSrc.slice(installerSrc.indexOf("function applyGlobalModelConfig("), installerSrc.indexOf("function applyGlobalModelConfig(") + 2200);
  assert.match(fn, /join\(homedir\(\), "\.pi", "review-gate\.json"\)/);
  assert.match(fn, /targetDir: AGENTS_DST/);
  assert.match(fn, /effectiveAgentsConfig\(agents, undefined\)/);
  assert.doesNotMatch(fn, /projectConfigPath|\.pi["'], ["']agents|PROJECT_AGENTS/i);
});

test("postinstall BEHAVIOR: renders the global agents chains into the installed agent files", () => {
  // Round-5 P2: the renderer was only source-text-tested — delete the
  // invocation and the suite stayed green. Drive it for real: home config
  // carries an `agents.reviewer` chain, the installer must render it.
  const home = makeHome();
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  // A miniature registry so slot validation sees the pinned models.
  writeFileSync(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({
      providers: {
        onekey: { models: [{ id: "gpt-5.6-sol", thinkingLevelMap: { high: "high", max: "max" } }] },
        anthropic: { models: [{ id: "claude-fable-5", thinkingLevelMap: { max: "max" } }] },
      },
    }),
  );
  writeFileSync(
    join(home, ".pi", "review-gate.json"),
    JSON.stringify({
      agents: { reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high", "claude-fable-5:max"] } },
    }),
  );
  const cwd = mkdtempSync(join(tmpdir(), "rg-pkg-cwd-"));
  tempDirs.push(cwd);
  const res = runInstaller(home, cwd);
  assert.equal(res.status, 0, `installer failed: ${res.stderr}`);
  const installed = readFileSync(join(home, ".pi", "agent", "agents", "reviewer.md"), "utf8");
  assert.match(installed, /model: onekey\/gpt-5\.6-sol:high/, "global chain main model must be rendered");
  assert.match(installed, /fallbackModels: claude-fable-5:max/, "global chain fallback must be rendered");
  assert.match(installed, /# @generated by pi-review-gate/, "the render product must be marked generated");
  // The install cwd is a throwaway non-repo dir — the project layer must
  // NEVER appear there (postinstall must not touch ANY project layer).
  assert.equal(existsSync(join(cwd, ".pi", "agents")), false, "install must never render a project layer");
});

test("postinstall BEHAVIOR: corrupt global config keeps the last rendered chains", () => {
  // Round-2 P1: a corrupt ~/.pi/review-gate.json used to be treated as "no
  // agents section" and swept generated files back to the upstream default,
  // clobbering the last valid render. Corrupt ≠ absent for the renderer.
  const home = makeHome();
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({
      providers: {
        onekey: { models: [{ id: "gpt-5.6-sol", thinkingLevelMap: { high: "high", max: "max" } }] },
        anthropic: { models: [{ id: "claude-fable-5", thinkingLevelMap: { max: "max" } }] },
      },
    }),
  );
  writeFileSync(
    join(home, ".pi", "review-gate.json"),
    JSON.stringify({ agents: { reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } } }),
  );
  const cwd = mkdtempSync(join(tmpdir(), "rg-pkg-cwd-"));
  tempDirs.push(cwd);
  const first = runInstaller(home, cwd);
  assert.equal(first.status, 0, `installer failed: ${first.stderr}`);
  const rendered = readFileSync(join(home, ".pi", "agent", "agents", "reviewer.md"), "utf8");
  assert.match(rendered, /model: onekey\/gpt-5\.6-sol:high/);
  // Now corrupt the config and reinstall: the rendered chain must survive.
  writeFileSync(join(home, ".pi", "review-gate.json"), "{ broken json");
  const second = runInstaller(home, cwd);
  assert.equal(second.status, 0, `installer failed: ${second.stderr}`);
  assert.match(
    readFileSync(join(home, ".pi", "agent", "agents", "reviewer.md"), "utf8"),
    /model: onekey\/gpt-5\.6-sol:high/,
    "corrupt config must keep the last rendered chain (fail-safe)",
  );
});

test("postinstall BEHAVIOR: a foreign marker line is overwritten (prefix parity with the renderer)", () => {
  // Round-3 P1: the installer used includes(marker), so a file carrying
  // "# @generated by pi-review-gate models-other" was SKIPPED by the copy
  // yet never managed by the renderer (exact-prefix rule) — frozen forever.
  // The copy must treat it like any non-generated file: overwrite.
  const home = makeHome();
  mkdirSync(join(home, ".pi", "agent", "agents"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "agents", "recon.md"),
    "---\n# @generated by pi-review-gate models-other\nname: recon\nmodel: stale/x\n---\nbody\n",
  );
  const cwd = mkdtempSync(join(tmpdir(), "rg-pkg-cwd-"));
  tempDirs.push(cwd);
  const res = runInstaller(home, cwd);
  assert.equal(res.status, 0, `installer failed: ${res.stderr}`);
  assert.equal(
    readFileSync(join(home, ".pi", "agent", "agents", "recon.md"), "utf8"),
    readFileSync(join(ROOT, "agents", "recon.md"), "utf8"),
    "a foreign marker is not a generated product — the upstream copy wins",
  );
});

test("postinstall BEHAVIOR: an ARRAY config file is corrupt too — chains survive", () => {
  // Round-6 P1: `[]` is valid JSON and typeof "object", so the guard let it
  // through as "no agents section" and the sweep restored defaults.
  const home = makeHome();
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({
      providers: {
        onekey: { models: [{ id: "gpt-5.6-sol", thinkingLevelMap: { high: "high", max: "max" } }] },
        anthropic: { models: [{ id: "claude-fable-5", thinkingLevelMap: { max: "max" } }] },
      },
    }),
  );
  writeFileSync(
    join(home, ".pi", "review-gate.json"),
    JSON.stringify({ agents: { reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } } }),
  );
  const cwd = mkdtempSync(join(tmpdir(), "rg-pkg-cwd-"));
  tempDirs.push(cwd);
  const first = runInstaller(home, cwd);
  assert.equal(first.status, 0, `installer failed: ${first.stderr}`);
  assert.match(readFileSync(join(home, ".pi", "agent", "agents", "reviewer.md"), "utf8"), /model: onekey\/gpt-5\.6-sol:high/);
  // Replace with a top-level ARRAY and reinstall: the render must survive.
  writeFileSync(join(home, ".pi", "review-gate.json"), "[]");
  const second = runInstaller(home, cwd);
  assert.equal(second.status, 0, `installer failed: ${second.stderr}`);
  assert.match(
    readFileSync(join(home, ".pi", "agent", "agents", "reviewer.md"), "utf8"),
    /model: onekey\/gpt-5\.6-sol:high/,
    "an array top-level is corrupt — the last rendered chain stays (fail-safe)",
  );
});

test("postinstall BEHAVIOR: a non-object AGENTS section is corrupt too — chains survive", () => {
  // Round-11 P1: `{"agents":[]}` parses as valid JSON at the top level, so
  // the old guard passed it through as "no agents section" and the sweep
  // restored defaults — clobbering the last valid render. Same fail-safe
  // as a corrupt top level must apply to a malformed agents section.
  const home = makeHome();
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({
      providers: {
        onekey: { models: [{ id: "gpt-5.6-sol", thinkingLevelMap: { high: "high", max: "max" } }] },
        anthropic: { models: [{ id: "claude-fable-5", thinkingLevelMap: { max: "max" } }] },
      },
    }),
  );
  writeFileSync(
    join(home, ".pi", "review-gate.json"),
    JSON.stringify({ agents: { reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } } }),
  );
  const cwd = mkdtempSync(join(tmpdir(), "rg-pkg-cwd-"));
  tempDirs.push(cwd);
  const first = runInstaller(home, cwd);
  assert.equal(first.status, 0, `installer failed: ${first.stderr}`);
  assert.match(readFileSync(join(home, ".pi", "agent", "agents", "reviewer.md"), "utf8"), /model: onekey\/gpt-5\.6-sol:high/);
  // Replace with a valid-JSON config whose agents section is an ARRAY, then
  // reinstall: the render must survive.
  writeFileSync(join(home, ".pi", "review-gate.json"), JSON.stringify({ agents: [] }));
  const second = runInstaller(home, cwd);
  assert.equal(second.status, 0, `installer failed: ${second.stderr}`);
  assert.match(
    readFileSync(join(home, ".pi", "agent", "agents", "reviewer.md"), "utf8"),
    /model: onekey\/gpt-5\.6-sol:high/,
    "a non-object agents section is corrupt — the last rendered chain stays (fail-safe)",
  );
});

test("postinstall BEHAVIOR: a PUBLISHED install (under node_modules) still renders the global layer", () => {
  // Round-12 P2: the code comment claimed a published install cannot render
  // from the postinstall (Node refuses to type-strip under node_modules) and
  // that only the extension covers it. That is refuted by the implementation:
  // applyGlobalModelConfig reads lib/model-config.ts as SOURCE and imports it
  // through a stripped data URL, which node_modules does not restrict. Pin the
  // REAL behavior so the comment and the code cannot drift apart again.
  const home = makeHome();
  const pkgRoot = join(home, "node_modules", "pi-review-gate");
  mkdirSync(pkgRoot, { recursive: true });
  for (const dir of ["scripts", "lib", "agents", "hooks"]) {
    cpSync(join(ROOT, dir), join(pkgRoot, dir), { recursive: true });
  }
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({
      providers: {
        onekey: { models: [{ id: "gpt-5.6-sol", thinkingLevelMap: { high: "high", max: "max" } }] },
      },
    }),
  );
  writeFileSync(
    join(home, ".pi", "review-gate.json"),
    JSON.stringify({ agents: { reviewer: { auto: false, slots: ["onekey/gpt-5.6-sol:high"] } } }),
  );
  // cwd deliberately OUTSIDE the package (a real npm postinstall cwd).
  const cwd = mkdtempSync(join(tmpdir(), "rg-pkg-published-cwd-"));
  tempDirs.push(cwd);
  const res = spawnSync("node", [join(pkgRoot, "scripts", "install-package.mjs")], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, HOME: home },
  });
  assert.equal(res.status, 0, `published installer failed: ${res.stderr}`);
  assert.match(
    readFileSync(join(home, ".pi", "agent", "agents", "reviewer.md"), "utf8"),
    /model: onekey\/gpt-5\.6-sol:high/,
    "a published install must render the user's global chain too",
  );
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


// ---------------------------------------------------------------------------
// Fleet keybindings — pi-subagents global subagent config smart-merge
// ---------------------------------------------------------------------------

function fleetConfigPath(home: string): string {
  return join(home, ".pi", "agent", "extensions", "subagent", "config.json");
}

function assertDefaultFleetBindings(cfg: Record<string, unknown>): void {
  const fb = cfg.fleetKeybindings as Record<string, string[]>;
  assert.deepEqual(fb, { pageUp: ["ctrl+b"], pageDown: ["ctrl+f", "ctrl+d"] });
  // pi-subagents validateFleetKeybindingsConfig structure: actions must be
  // supported Fleet actions and values non-empty string arrays.
  for (const [action, bindings] of Object.entries(fb)) {
    assert.ok(["pageUp", "pageDown"].includes(action), `unsupported action: ${action}`);
    assert.ok(Array.isArray(bindings) && bindings.length > 0 && bindings.every((b) => typeof b === "string" && b.trim() !== ""),
      `bad bindings for ${action}`);
    // isValidKeyId mirror: base ∈ a-z/0-9/Key values, modifiers ⊆ ctrl/shift/alt/super.
    for (const binding of bindings) {
      const parts = binding.toLowerCase().split("+");
      const base = parts.pop() ?? "";
      assert.match(base, /^[a-z0-9]$/, `invalid key base: ${base}`);
      assert.ok(parts.every((m) => ["ctrl", "shift", "alt", "super"].includes(m)), `invalid modifier in: ${binding}`);
    }
  }
}

test("postinstall writes default fleet keybindings when subagent config is missing", () => {
  const home = makeHome();
  const res = runInstaller(home);
  assert.equal(res.status, 0, `installer failed: ${res.stderr}`);

  const cfg = JSON.parse(readFileSync(fleetConfigPath(home), "utf8"));
  assertDefaultFleetBindings(cfg);
  // saveConfig parity: tab indentation + trailing newline.
  const raw = readFileSync(fleetConfigPath(home), "utf8");
  assert.ok(raw.startsWith("{\n\t"), "config must use tab indentation");
  assert.ok(raw.endsWith("\n"), "config must end with a newline");
  assert.match(res.stdout, /fleet keybindings written/, "installer must log the write");
});

test("postinstall merges fleetKeybindings into an existing config, preserving other fields", () => {
  const home = makeHome();
  const cfgPath = fleetConfigPath(home);
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ mode: "pruned", forkContext: { mode: "full" } }, null, 2));

  const res = runInstaller(home);
  assert.equal(res.status, 0, `installer failed: ${res.stderr}`);

  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  assertDefaultFleetBindings(cfg);
  assert.deepEqual(cfg.mode, "pruned", "existing top-level fields must be preserved");
  assert.deepEqual(cfg.forkContext, { mode: "full" }, "existing nested fields must be preserved");
  assert.match(res.stdout, /fleet keybindings merged/, "installer must log the merge");
});

test("postinstall leaves an existing fleetKeybindings completely alone", () => {
  const home = makeHome();
  const cfgPath = fleetConfigPath(home);
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ fleetKeybindings: { close: ["ctrl+q"] }, other: 1 }));

  const res = runInstaller(home);
  assert.equal(res.status, 0, `installer failed: ${res.stderr}`);

  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.deepEqual(cfg.fleetKeybindings, { close: ["ctrl+q"] }, "user's bindings must win");
  assert.equal(cfg.other, 1);
  assert.match(res.stdout, /already configured/, "installer must say bindings are kept");
});

test("postinstall skips a corrupt or non-object subagent config with a warning (never clobbers)", () => {
  for (const bad of ["{not json", "[1,2,3]", '"just a string"']) {
    const home = makeHome();
    const cfgPath = fleetConfigPath(home);
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, bad);

    const res = runInstaller(home);
    assert.equal(res.status, 0, `installer failed: ${res.stderr}`);
    assert.equal(readFileSync(cfgPath, "utf8"), bad, "corrupt config must be left byte-for-byte untouched");
    assert.match(res.stdout, /leaving it untouched/, "installer must warn about the corrupt config");
  }
});

test("fleet keybindings install is idempotent (re-run is stable)", () => {
  const home = makeHome();
  const first = runInstaller(home);
  assert.equal(first.status, 0, `first run failed: ${first.stderr}`);
  // Snapshot BEFORE the second run: comparing two post-run reads would pass
  // even if the re-run rewrote the file.
  const afterFirst = readFileSync(fleetConfigPath(home), "utf8");

  const second = runInstaller(home);
  assert.equal(second.status, 0, `second run failed: ${second.stderr}`);
  assert.equal(
    readFileSync(fleetConfigPath(home), "utf8"),
    afterFirst,
    "re-run must not change the config",
  );
  assert.match(first.stdout, /fleet keybindings written/, "first run creates");
  assert.match(second.stdout, /already configured/, "second run skips");
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

test("postinstall refuses to install hooks from inside a review snapshot (both layouts)", () => {
  const home = makeHome();
  // repo-local layout: <repo>/.pi/review-snapshots/rg-review-snap-<id>/…
  const repo = mkdtempSync(join(tmpdir(), "rg-pkg-snap-"));
  tempDirs.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  const snapLayout = join(repo, ".pi", "review-snapshots", "rg-review-snap-abc", "shard-1");
  mkdirSync(snapLayout, { recursive: true });
  const resSnap = runInstaller(home, snapLayout);
  assert.equal(resSnap.status, 0, "snapshot refusal must still exit 0 (postinstall cannot fail the package install)");
  assert.match(resSnap.stdout + resSnap.stderr, /refusing to install git hooks/,
    "the refusal must name the snapshot reason");
  assert.ok(!existsSync(join(repo, ".git", "hooks", "pre-commit")),
    "hooks must NOT be installed from inside a snapshot (shared .git)");

  // tmpdir fallback layout: <tmp>/rg-review-snap-<id>/… (a git repo there so
  // the snapshot refusal branch is the one exercised, not the non-repo skip).
  // Unique parent via mkdtemp: a FIXED path here would make concurrent suite
  // runs delete each other's working dirs (round P1).
  const tmpBase = mkdtempSync(join(tmpdir(), "rg-pkg-snaptmp-"));
  tempDirs.push(tmpBase);
  const tmpLayout = join(tmpBase, "rg-review-snap-xyz", "shard-1");
  mkdirSync(tmpLayout, { recursive: true });
  try {
    execFileSync("git", ["init", "-q"], { cwd: tmpLayout, stdio: "ignore" });
    const resTmp = runInstaller(home, tmpLayout);
    assert.equal(resTmp.status, 0);
    assert.match(resTmp.stdout + resTmp.stderr, /refusing to install git hooks/,
      "the tmpdir fallback layout must be refused too");
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
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

test("install-git-hooks.sh itself refuses BOTH snapshot layouts (shell-level guard)", () => {
  // The mjs postinstall path is covered above; this pins the SHELL installer's
  // own guard, including the tmpdir fallback layout (round P2: the guard was
  // widened from */.pi/review-snapshots/* to any rg-review-snap- segment, and
  // the old pattern still passed every test).
  const home = makeHome();
  // repo-local layout — as a REAL linked worktree (a plain subdir does not
  // make git report the snapshot path as toplevel; a snapshot IS a worktree)
  const repo = mkdtempSync(join(tmpdir(), "rg-pkg-shellsnap-"));
  tempDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], { cwd: repo, stdio: "ignore" });
  const snapLayout = join(repo, ".pi", "review-snapshots", "rg-review-snap-abc", "shard-1");
  mkdirSync(dirname(snapLayout), { recursive: true });
  execFileSync("git", ["worktree", "add", "-q", "--detach", snapLayout, "main"], { cwd: repo, stdio: "ignore" });
  const resSnap = spawnSync("bash", [HOOK_INSTALLER], { cwd: snapLayout, encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(resSnap.status, 1, "shell installer must refuse the repo-local snapshot layout");
  assert.match(resSnap.stderr, /refusing to install hooks from a review snapshot/);
  assert.ok(!existsSync(join(repo, ".git", "hooks", "pre-commit")), "hooks must not land in the shared .git");
  execFileSync("git", ["worktree", "remove", "--force", snapLayout], { cwd: repo, stdio: "ignore" });

  // tmpdir fallback layout (unique parent — never a fixed path)
  const tmpBase = mkdtempSync(join(tmpdir(), "rg-pkg-shellsnaptmp-"));
  tempDirs.push(tmpBase);
  const tmpLayout = join(tmpBase, "rg-review-snap-xyz", "shard-1");
  mkdirSync(tmpLayout, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: tmpLayout, stdio: "ignore" });
  const resTmp = spawnSync("bash", [HOOK_INSTALLER], { cwd: tmpLayout, encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(resTmp.status, 1, "shell installer must refuse the tmpdir fallback layout too");
  assert.match(resTmp.stderr, /refusing to install hooks from a review snapshot/);
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
    "npm:pi-hashline-edit-pro",
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
    "npm:pi-hashline-edit-pro",
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
    "npm:pi-hashline-edit-pro",
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
