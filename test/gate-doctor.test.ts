import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, accessSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  checkModelChains,
  checkGlobalConfig,
  checkPrecommitRunner,
  checkGitHooks,
  checkLangGate,
  checkCopilotGh,
  checkCommandRegistry,
  factsFromRegistry,
  runGateDoctor,
  formatDoctorReport,
  runnerCandidates,
  MIN_WORKFLOW_COMMANDS,
  type DoctorDeps,
  type DoctorCheck,
  goalAuditorCheck,
  installScriptPath,
  installScriptPathFrom,
} from "../lib/gate-doctor.ts";
import { diagnoseChain, type ModelChainEntry } from "../lib/model-diagnose.ts";
import { resolvePackageAgentsDir } from "../lib/model-config.ts";
import { judgeEnglish } from "../lib/lang-detect.ts";

/** The L5 decision as the doctor consumes it (a predicate over one text). */
const nonEnglish = (text: string) => judgeEnglish("commit-body", text) !== undefined;

function entry(role: string, model: string, fallbacks: string[], facts: Parameters<typeof diagnoseChain>[2]): ModelChainEntry {
  const frontmatter = `---\nmodel: "${model}"\nfallbackModels: [${fallbacks.map((f) => `"${f}"`).join(",")}]\n---\n`;
  return diagnoseChain(role, frontmatter, facts);
}

const PASS_FACTS = {
  models: [
    { provider: "anthropic", id: "claude-fable-5" },
    { provider: "opencode-go", id: "deepseek-v4-flash" },
  ],
  authedProviders: new Set(["anthropic", "opencode-go"]),
  allowed: () => true,
};

// (the pdw-engine check and its tests were deleted with the engine itself)

// ---------- model-chains ----------

test("checkModelChains: no entries warns, usable chains pass", () => {
  const empty = checkModelChains([], true);
  assert.equal(empty.status, "WARN");
  const pass = checkModelChains([entry("reviewer", "claude-fable-5", ["opencode-go/deepseek-v4-flash"], PASS_FACTS)], true);
  assert.equal(pass.status, "PASS");
  assert.ok(pass.evidence[0]?.includes("usable"));
});

test("checkModelChains: a blocked chain FAILs with facts, degrades to WARN without them", () => {
  const noAuthFacts = { ...PASS_FACTS, authedProviders: new Set<string>() };
  const blocked = entry("reviewer", "claude-fable-5", ["opencode-go/deepseek-v4-flash"], noAuthFacts);
  assert.equal(blocked.blocked, true, "chain without authed providers must be blocked");
  const fail = checkModelChains([blocked], true);
  assert.equal(fail.status, "FAIL");
  assert.ok(fail.evidence[0]?.includes("BLOCKED"));
  assert.ok(fail.advice?.[0]?.includes("~/.pi/agent/agents"));
  // Facts unavailable: an unprovable chain must never report a confident FAIL.
  const warn = checkModelChains([blocked], false);
  assert.equal(warn.status, "WARN");
});

// ---------- global-config ----------

test("checkGlobalConfig: absent file passes as legitimate, corrupt JSON fails", () => {
  const absent = checkGlobalConfig(undefined);
  assert.equal(absent.status, "PASS");
  assert.ok(absent.evidence[0]?.includes("legitimate"));
  const good = checkGlobalConfig(JSON.stringify({ maxRounds: 12, gitMemory: false }));
  assert.equal(good.status, "PASS");
  assert.ok(good.evidence[0]?.includes("2 top-level field(s)"));
  const corrupt = checkGlobalConfig("{broken");
  assert.equal(corrupt.status, "FAIL");
  assert.ok(corrupt.advice?.[0]?.includes("JSON"));
});

test("checkGlobalConfig: valid JSON that is not a config object FAILs with accurate evidence", () => {
  // `null` / an array parse fine but are not a config; the evidence must not
  // claim "not valid JSON" (it is), and Object.keys(null) must never throw.
  for (const raw of ["null", "[1,2]", '"text"', "42"]) {
    const check = checkGlobalConfig(raw);
    assert.equal(check.status, "FAIL", raw);
    assert.ok(check.evidence[0]?.includes("not a config object"), `${raw}: ${check.evidence[0]}`);
  }
});

// ---------- precommit-runner ----------

test("checkPrecommitRunner: found candidate passes with path, none fails", () => {
  const pass = checkPrecommitRunner(["/a/runner.mjs", "/b/runner.mjs"], (p) => p === "/b/runner.mjs");
  assert.equal(pass.status, "PASS");
  assert.equal(pass.evidence[0], "/b/runner.mjs");
  const fail = checkPrecommitRunner(["/a", "/b"], () => false);
  assert.equal(fail.status, "FAIL");
  assert.ok(fail.advice?.[0]?.includes("re-install"));
});

test("runnerCandidates covers the three known install layouts", () => {
  const candidates = runnerCandidates("/pkg");
  assert.ok(candidates.includes(join("/pkg", "scripts", "precommit-runner.mjs")));
  assert.ok(candidates.includes(join("/pkg", "..", "scripts", "precommit-runner.mjs")));
  assert.ok(candidates.includes(join("/pkg", "..", "..", "scripts", "pi-review-gate-precommit.mjs")));
});

// ---------- git-hooks ----------

test("checkGitHooks: all installed with marker passes", () => {
  const check = checkGitHooks(() => ({ exists: true, marker: true }), ["pre-commit", "commit-msg", "pre-push"]);
  assert.equal(check.status, "PASS");
});

test("checkGitHooks: missing hook FAILs, marker-less WARNs, unverifiable WARNs", () => {
  const missing = checkGitHooks((n) => (n === "pre-commit" ? { exists: false, marker: false } : { exists: true, marker: true }), ["pre-commit", "commit-msg"]);
  assert.equal(missing.status, "FAIL");
  assert.ok(missing.advice?.[0]?.includes("install-git-hooks.sh"));
  const noMarker = checkGitHooks(() => ({ exists: true, marker: false }), ["pre-commit"]);
  assert.equal(noMarker.status, "WARN");
  const unverifiable = checkGitHooks(() => undefined, ["pre-commit"]);
  assert.equal(unverifiable.status, "WARN");
});

// ---------- l5-language ----------

test("checkLangGate: working gate passes, broken gate fails", () => {
  const pass = checkLangGate(nonEnglish);
  assert.equal(pass.status, "PASS");
  const fail = checkLangGate(() => false);
  assert.equal(fail.status, "FAIL");
  const throws = checkLangGate(() => {
    throw new Error("boom");
  });
  assert.equal(throws.status, "FAIL");
  assert.ok(throws.evidence[0]?.includes("boom"));
});

// ---------- copilot-gh ----------

test("checkCopilotGh: gh present passes with compat note, absent warns", () => {
  const pass = checkCopilotGh({ ok: true, value: "gh version 2.40.0" });
  assert.equal(pass.status, "PASS");
  assert.ok(pass.evidence.some((e) => e.includes("modern + legacy")));
  const warn = checkCopilotGh({ ok: false, error: "gh not installed" });
  assert.equal(warn.status, "WARN");
  assert.ok(warn.advice?.[0]?.includes("gh auth login"));
});

// ---------- commands ----------

test("checkCommandRegistry: populated registry passes, truncated fails", () => {
  assert.equal(checkCommandRegistry(MIN_WORKFLOW_COMMANDS).status, "PASS");
  const fail = checkCommandRegistry(2);
  assert.equal(fail.status, "FAIL");
  assert.ok(fail.evidence[0]?.includes("only 2"));
});

// ---------- factsFromRegistry ----------

test("factsFromRegistry: session registry wins, disk store is the fallback", () => {
  const reg = {
    getAll: () => [{ provider: "anthropic", id: "claude-fable-5" }],
    hasConfiguredAuth: (m: { provider: string }) => m.provider === "anthropic",
  };
  const facts = factsFromRegistry(reg, "/nonexistent-home", () => undefined);
  assert.equal(facts.models.length, 1);
  assert.ok(facts.authedProviders.has("anthropic"));
});

test("factsFromRegistry carries registry model metadata forward", () => {
  const reg = {
    getAll: () => [
      { provider: "anthropic", id: "claude-fable-5", thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } },
      { provider: "onekey", id: "plain", reasoning: false },
    ],
    hasConfiguredAuth: () => true,
  };
  const facts = factsFromRegistry(reg, "/nonexistent-home", () => undefined);
  const fable = facts.models.find((m) => m.id === "claude-fable-5");
  assert.deepEqual(fable?.thinkingLevelMap, { off: null, xhigh: "xhigh", max: "max" });
  const plain = facts.models.find((m) => m.id === "plain");
  assert.equal(plain?.reasoning, false);
});

test("factsFromRegistry drops malformed thinking map values", () => {
  const reg = {
    getAll: () => [{ provider: "p", id: "m", thinkingLevelMap: { high: 123, max: "max" } }],
    hasConfiguredAuth: () => true,
  };
  const facts = factsFromRegistry(reg, "/nonexistent-home", () => undefined);
  assert.deepEqual(facts.models[0]?.thinkingLevelMap, { max: "max" });
});

test("factsFromRegistry drops malformed thinkingLevelMap values (null / array) (round-7 Nit)", () => {
  const reg = {
    getAll: () => [
      { provider: "onekey", id: "gpt-5.6-sol", thinkingLevelMap: null },
      { provider: "xai", id: "grok-4.6", thinkingLevelMap: ["max"] },
      { provider: "anthropic", id: "claude-fable-5" },
    ],
    hasConfiguredAuth: () => true,
  };
  const facts = factsFromRegistry(reg, "/nonexistent-home", () => undefined);
  for (const m of facts.models) {
    assert.ok(!("thinkingLevelMap" in m), `malformed metadata must not be carried (${m.id})`);
  }
});

test("factsFromRegistry: empty registry falls back to models-store.json + auth.json", () => {
  const home = mkdtempSync(join(tmpdir(), "gate-doctor-facts-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "models-store.json"),
    JSON.stringify({ "opencode-go": { models: [{ provider: "opencode-go", id: "deepseek-v4-flash" }] } }),
  );
  writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ "opencode-go": {} }));
  const facts = factsFromRegistry({ getAll: () => [] }, home, (p) => {
    try { return readFileSync(p, "utf8"); } catch { return undefined; }
  });
  assert.equal(facts.models.length, 1);
  assert.ok(facts.authedProviders.has("opencode-go"));
});

// ---------- runGateDoctor orchestration ----------

function baseDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const home = mkdtempSync(join(tmpdir(), "gate-doctor-deps-"));
  const agentsDir = join(home, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "reviewer.md"),
    '---\nmodel: "claude-fable-5"\nfallbackModels: ["opencode-go/deepseek-v4-flash"]\n---\n',
  );
  // goal-auditor gates every goal approval, so a healthy environment has it —
  // with a LOADABLE frontmatter (name + description), because that is what
  // pi-subagents requires before it will dispatch the role at all.
  writeFileSync(
    join(agentsDir, "goal-auditor.md"),
    '---\nname: goal-auditor\ndescription: audits draft loop goals\nmodel: "claude-fable-5"\nfallbackModels: ["opencode-go/deepseek-v4-flash"]\n---\n',
  );
  const hooksDir = join(home, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  for (const h of ["pre-commit", "commit-msg", "pre-push"]) {
    writeFileSync(join(hooksDir, h), "#!/usr/bin/env bash\n# pi-review-gate:installed\nexec true\n");
  }
  mkdirSync(join(home, "scripts"), { recursive: true });
  writeFileSync(join(home, "scripts", "precommit-runner.mjs"), "// fake runner\n");
  return {
    homeDir: home,
    packageRoot: home,
    agentsDir,
    modelsStorePath: join(home, ".pi", "agent", "models-store.json"),
    globalConfigPath: join(home, ".pi", "review-gate.json"),
    registryFacts: PASS_FACTS,
    hooksDir,
    workflowCommandCount: 15,
    nonEnglish,
    probeGh: async () => ({ ok: true, value: "gh version 2.40.0" }),
    readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
    exists: (p) => { try { accessSync(p); return true; } catch { return false; } },
    readdir: (p) => { try { return readdirSync(p); } catch { return undefined; } },
    ...overrides,
  };
}

test("runGateDoctor: healthy environment reports every check, all PASS", async () => {
  const checks = await runGateDoctor(baseDeps());
  const ids = checks.map((c) => c.id);
  assert.deepEqual(ids, [
    "model-chains", "goal-auditor", "global-config",
    "precommit-runner", "git-hooks", "l5-language", "copilot-gh", "commands",
  ]);
  for (const c of checks) {
    assert.equal(c.status, "PASS", `${c.id} should PASS in a healthy env: ${JSON.stringify(c)}`);
  }
});

test("runGateDoctor: a project-layer agent override outranks the global copy", async () => {
  // Round-2 P2: doctor only read ~/.pi/agent/agents, so a project-layer
  // render (which pi-subagents actually loads first) was invisible — a dead
  // global chain hid a live project override and vice versa.
  const deps = baseDeps();
  // Kill the GLOBAL reviewer chain (unauthenticated provider)…
  writeFileSync(
    join(deps.agentsDir, "reviewer.md"),
    '---\nmodel: "dead/x"\n---\n',
  );
  // …and revive it in the project layer with a usable chain. The SAME deps
  // instance carries the dead global copy: a fresh baseDeps() would ship a
  // healthy global chain and the PASS would prove nothing (round-11 P1).
  const projAgents = join(deps.homeDir, "proj-agents");
  mkdirSync(projAgents, { recursive: true });
  writeFileSync(
    join(projAgents, "reviewer.md"),
    '---\nname: reviewer\ndescription: project reviewer\nmodel: "claude-fable-5"\nfallbackModels: ["opencode-go/deepseek-v4-flash"]\n---\n',
  );
  const checks = await runGateDoctor({ ...deps, projectAgentsDir: projAgents });
  const chains = checks.find((c) => c.id === "model-chains")!;
  assert.equal(chains.status, "PASS", `project chain must be diagnosed, not the dead global one: ${JSON.stringify(chains)}`);
  // And the reverse: with NO project layer the dead global chain must FAIL.
  const noProj = await runGateDoctor(deps);
  assert.equal(noProj.find((c) => c.id === "model-chains")!.status, "FAIL", "without a project override the dead global chain fails");
});

test("runGateDoctor: a project-layer-ONLY agent file is diagnosed (project layer is live)", async () => {
  // Round-5 P2: the union enumeration — a file with NO global copy still
  // spawns under pi-subagents' project layer, so a dead chain there must
  // surface instead of hiding outside the doctor's file list.
  const projAgents = join(baseDeps().homeDir, "proj-only");
  mkdirSync(projAgents, { recursive: true });
  writeFileSync(
    join(projAgents, "worker.md"),
    '---\nname: worker\ndescription: test worker\nmodel: "dead/x"\n---\n',
  );
  const checks = await runGateDoctor(baseDeps({ projectAgentsDir: projAgents }));
  const chains = checks.find((c) => c.id === "model-chains")!;
  assert.equal(chains.status, "FAIL", `the project-only dead chain must be diagnosed: ${JSON.stringify(chains)}`);
  assert.ok(chains.evidence.some((e) => e.includes("worker")), "evidence names the project-only agent");
});

test("runGateDoctor: a non-.md global entry never suppresses a project-only agent", async () => {
  // Round-3 Nit / round-4: globalRoles used to keep every readdir entry
  // verbatim, so an extensionless file (or a directory) named exactly like a
  // project agent's identity looked like "there is already a global `worker`"
  // and the project-ONLY chain was dropped from the diagnosis. Round 4 found
  // the .filter had no test — removing it left the suite green.
  const deps = baseDeps();
  // A stray non-.md entry colliding with the project agent's identity.
  writeFileSync(join(deps.agentsDir, "worker"), "not an agent file\n");
  const projAgents = join(deps.homeDir, "proj-only-collide");
  mkdirSync(projAgents, { recursive: true });
  writeFileSync(
    join(projAgents, "worker.md"),
    '---\nname: worker\ndescription: test worker\nmodel: "dead/x"\n---\n',
  );
  const checks = await runGateDoctor({ ...deps, projectAgentsDir: projAgents });
  const chains = checks.find((c) => c.id === "model-chains")!;
  assert.equal(chains.status, "FAIL", `the project-only dead chain must still be diagnosed: ${JSON.stringify(chains)}`);
  assert.ok(
    chains.evidence.some((e) => e.includes("worker")),
    `a stray non-.md entry must not hide the project agent: ${JSON.stringify(chains.evidence)}`,
  );
});
test("runGateDoctor: a project override with a nonstandard delimiter is DIAGNOSED, not silently dropped", async () => {
  // Round-12 R3 P2: the identity lookup used the lenient runtime-parity parser
  // while `diagnose` pre-checked with a strict `^---\r?\n` regex. A project
  // file opening with `--- ` (which pi-subagents DOES load) therefore shadowed
  // the global entry AND was then skipped — the role vanished from the report
  // and a DEAD live chain came back PASS.
  const deps = baseDeps();
  // Global reviewer is healthy; the project layer overrides it with a dead one.
  const projAgents = join(deps.homeDir, "proj-nonstandard");
  mkdirSync(projAgents, { recursive: true });
  writeFileSync(
    join(projAgents, "reviewer.md"),
    '--- \nname: reviewer\ndescription: project reviewer\nmodel: "dead/x"\n---\n',
  );
  const checks = await runGateDoctor({ ...deps, projectAgentsDir: projAgents });
  const chains = checks.find((c) => c.id === "model-chains")!;
  assert.equal(
    chains.status,
    "FAIL",
    `the overriding project chain is dead and must be reported: ${JSON.stringify(chains)}`,
  );
  assert.ok(
    chains.evidence.some((e) => e.includes("reviewer")),
    `the role must not vanish from the diagnosis: ${JSON.stringify(chains.evidence)}`,
  );
});
test("runGateDoctor: a project file the runtime would skip does not shadow the global chain (round-11)", async () => {
  // Round-11 P2: pi-subagents requires BOTH `name` and `description` in a
  // frontmatter or it skips the file (agents.ts loadable check) — a
  // malformed project copy must not hide a healthy global chain.
  const deps = baseDeps();
  const projAgents = join(deps.homeDir, "proj-skip");
  mkdirSync(projAgents, { recursive: true });
  // Global reviewer is healthy (baseDeps default); the project copy is
  // missing name/description → pi-subagents ignores it.
  writeFileSync(join(projAgents, "reviewer.md"), '---\nmodel: "dead/x"\n---\n');
  const checks = await runGateDoctor({ ...deps, projectAgentsDir: projAgents });
  const chains = checks.find((c) => c.id === "model-chains")!;
  assert.equal(chains.status, "PASS", `the unloadable project file must not shadow the global chain: ${JSON.stringify(chains)}`);
});

test("runGateDoctor: empty-string name/description also counts as unloadable (round-11)", async () => {
  // Round-11 P2: pi-subagents checks TRUTHINESS after quote parsing, so
  // `name: ""` / `description: ""` are skipped too — the doctor must not
  // let such a file shadow the global chain.
  const deps = baseDeps();
  const projAgents = join(deps.homeDir, "proj-empty");
  mkdirSync(projAgents, { recursive: true });
  writeFileSync(join(projAgents, "reviewer.md"), '---\nname: ""\ndescription: ""\nmodel: "dead/x"\n---\n');
  const checks = await runGateDoctor({ ...deps, projectAgentsDir: projAgents });
  const chains = checks.find((c) => c.id === "model-chains")!;
  assert.equal(chains.status, "PASS", `empty-string required fields must not shadow the global chain: ${JSON.stringify(chains)}`);
});

test("runGateDoctor: an unreadable PROJECT agents dir FAILs instead of silently dropping the layer", async () => {
  // round-11 P1: treating an unreadable project dir as "no project layer"
  // drops every project-override chain and can fake a PASS on a dead global
  // chain. Round-12 P2: that branch had NO test — disabling it left the whole
  // gate-doctor suite green.
  const deps = baseDeps();
  const projAgents = mkdtempSync(join(tmpdir(), "gate-doctor-proj-unreadable-"));
  const passthrough = deps.readdir;
  const checks = await runGateDoctor({
    ...deps,
    projectAgentsDir: projAgents,
    // The dir EXISTS (default `exists`) but cannot be listed.
    readdir: (p) => (p === projAgents ? undefined : passthrough(p)),
  });
  const chains = checks.find((c) => c.id === "model-chains")!;
  assert.equal(chains.status, "FAIL", `an unreadable project agents dir must FAIL: ${JSON.stringify(chains)}`);
  assert.ok(
    chains.evidence.some((e) => e.includes("project agents dir not readable")),
    `the evidence must name the unreadable project dir: ${JSON.stringify(chains.evidence)}`,
  );
});
test("runGateDoctor: broken environment surfaces FAILs, one IO failure never throws", async () => {
  const deps = baseDeps({
    probeGh: async () => ({ ok: false, error: "ENOENT" }),
    modelsStorePath: join(tmpdir(), "does-not-exist.json"),
    workflowCommandCount: 1,
    readdir: () => undefined, // agents dir unreadable
  });
  const checks = await runGateDoctor(deps);
  const byId = new Map(checks.map((c) => [c.id, c]));
  assert.equal(byId.get("model-chains")?.status, "FAIL");
  assert.equal(byId.get("commands")?.status, "FAIL");
  assert.equal(byId.get("copilot-gh")?.status, "WARN");
  assert.equal(checks.length, 8, "one broken check must not suppress the rest");
});

test("goalAuditorCheck: a missing goal-auditor is a FAIL with an actionable repair", async () => {
  // This role is load-bearing: propose_loop_goal cannot be satisfied without
  // an audit from it, and in loop mode an unapproved goal also blocks edits.
  // A silent absence would therefore look like "the gate is broken".
  const deps = baseDeps();
  rmSync(join(deps.agentsDir, "goal-auditor.md"), { force: true });
  const missing = goalAuditorCheck(deps);
  assert.equal(missing.status, "FAIL");
  assert.match(missing.evidence.join("\n"), /MISSING/);
  assert.match((missing.advice ?? []).join("\n"), /self-heals/, "the repair must name the automatic path first");
  assert.match((missing.advice ?? []).join("\n"), /install-package\.mjs/, "and the manual fallback");
  // The remediation command is the MANUAL escape hatch out of a bootstrap
  // deadlock, so the path must actually EXIST — a wrong directory level (the
  // earlier `packageRoot/../scripts/…`) turns the only exit into
  // "Cannot find module", and matching the basename alone cannot catch that.
  const advised = (missing.advice ?? []).join("\n").match(/node (\S*install-package\.mjs)/);
  assert.ok(advised, "the advice must carry a concrete path to run");
  assert.equal(isAbsolute(advised![1]), true, "an absolute path, never a bare relative one");
  assert.equal(existsSync(advised![1]), true, `the advised installer path must exist: ${advised![1]}`);
});

test("installScriptPath resolves one level under the package root (never two)", () => {
  // scripts/ is a sibling of agents/, so the probed package dir decides the
  // level; a hand-built `..` was pointing outside the package entirely.
  const viaRoot = installScriptPath("/nowhere/pkg");
  assert.match(viaRoot, /install-package\.mjs$/);
  assert.equal(existsSync(viaRoot), true, "the probe must win over the (bogus) fallback root when it resolves");
  // Pin the LEVEL, not the absence of ".." (path.join normalizes those away,
  // so the old assertion could never fail): the script must sit directly under
  // the same package root that ships agents/.
  const agentsDir = resolvePackageAgentsDir();
  assert.ok(agentsDir, "the repo layout must resolve for this assertion to mean anything");
  assert.equal(viaRoot, join(dirname(agentsDir!), "scripts", "install-package.mjs"));
  // FALLBACK branch: with no resolvable probe the caller's packageRoot is used
  // verbatim — still one level, never two.
  assert.equal(
    installScriptPathFrom(null, "/nowhere/pkg"),
    join("/nowhere/pkg", "scripts", "install-package.mjs"),
  );
});

test("goalAuditorCheck resolves the GLOBAL layer by identity too (no filename shortcuts)", () => {
  // Same rule on both layers, because pi-subagents dispatches on the declared
  // `name`: judging the global copy by filename would cut both ways — a false
  // PASS on a hand-broken file and a false MISSING on a renamed one.
  const deps = baseDeps();
  const loadable = "---\nname: goal-auditor\ndescription: audits draft loop goals\nmodel: claude-fable-5\n---\n";
  assert.equal(goalAuditorCheck(deps).status, "PASS", "the healthy fixture declares the role");

  // Right filename, frontmatter pi-subagents would SKIP ⇒ not dispatchable.
  writeFileSync(join(deps.agentsDir, "goal-auditor.md"), "---\nmodel: claude-fable-5\n---\n");
  const broken = goalAuditorCheck(deps);
  assert.equal(broken.status, "FAIL", "an unloadable global file must not pass");
  assert.match(broken.evidence.join("\n"), /declares name: goal-auditor/);

  // Right filename, WRONG declared role ⇒ not dispatchable either.
  writeFileSync(join(deps.agentsDir, "goal-auditor.md"), "---\nname: reviewer\ndescription: x\n---\n");
  assert.equal(goalAuditorCheck(deps).status, "FAIL", "the filename must never outrank the declared name");

  // RENAMED but dispatchable ⇒ must pass (the false-MISSING direction).
  rmSync(join(deps.agentsDir, "goal-auditor.md"), { force: true });
  writeFileSync(join(deps.agentsDir, "my-auditor.md"), loadable);
  const renamed = goalAuditorCheck(deps);
  assert.equal(renamed.status, "PASS", "a renamed global file that declares the role is dispatchable");
  assert.match(renamed.evidence.join("\n"), /my-auditor\.md/, "the evidence must name the file that provides it");
});

test("goalAuditorCheck: a PROJECT-layer copy is enough — resolved by frontmatter name, never by filename", () => {
  const deps = baseDeps();
  rmSync(join(deps.agentsDir, "goal-auditor.md"), { force: true });
  const projectAgentsDir = join(mkdtempSync(join(tmpdir(), "gate-doctor-proj-")), ".pi", "agents");
  mkdirSync(projectAgentsDir, { recursive: true });
  // A LOADABLE file: pi-subagents skips a frontmatter without name+description,
  // so the fixture must carry both for the premise to be true.
  const loadable = "---\nname: goal-auditor\ndescription: project override\nmodel: claude-fable-5\n---\n";
  writeFileSync(join(projectAgentsDir, "goal-auditor.md"), loadable);
  assert.equal(goalAuditorCheck({ ...deps, projectAgentsDir }).status, "PASS");

  // IDENTITY, not filename: pi-subagents keys project agents by the declared
  // `name`, so a renamed file is dispatchable and must not read as MISSING
  // (this is the resolution the goal refusal uses — the two must agree).
  rmSync(join(projectAgentsDir, "goal-auditor.md"), { force: true });
  writeFileSync(join(projectAgentsDir, "custom.md"), loadable);
  const byIdentity = goalAuditorCheck({ ...deps, projectAgentsDir });
  assert.equal(byIdentity.status, "PASS");
  assert.match(byIdentity.evidence.join("\n"), /by frontmatter name/, "the evidence must show HOW it was found");

  // A project file that declares a DIFFERENT role does not count.
  rmSync(join(projectAgentsDir, "custom.md"), { force: true });
  writeFileSync(join(projectAgentsDir, "custom.md"), "---\nname: reviewer\ndescription: x\n---\n");
  assert.equal(goalAuditorCheck({ ...deps, projectAgentsDir }).status, "FAIL");

  // NO filename fallback: a file literally named goal-auditor.md that
  // pi-subagents would NOT load (frontmatter lacking name/description, or
  // declaring another role) must not buy a PASS — that is precisely the
  // undispatchable state this check exists to catch.
  rmSync(join(projectAgentsDir, "custom.md"), { force: true });
  writeFileSync(join(projectAgentsDir, "goal-auditor.md"), "---\nmodel: claude-fable-5\n---\n");
  const unloadable = goalAuditorCheck({ ...deps, projectAgentsDir });
  assert.equal(unloadable.status, "FAIL", "a file the runtime would skip is not dispatchability");
  assert.match(unloadable.evidence.join("\n"), /no project agent declares name: goal-auditor/);
  writeFileSync(join(projectAgentsDir, "goal-auditor.md"), "---\nname: reviewer\ndescription: x\n---\n");
  assert.equal(goalAuditorCheck({ ...deps, projectAgentsDir }).status, "FAIL", "the filename must never outrank the declared name");
});

test("runGateDoctor: an agent whose frontmatter pins no model is not counted as a chain", async () => {
  // A frontmatter without `model:` yields an empty chain; counting it would
  // print a bogus "role: usable null" evidence line.
  const deps = baseDeps();
  writeFileSync(join(deps.agentsDir, "note.md"), "---\nname: note\n---\nno model pinned\n");
  const checks = await runGateDoctor(deps);
  const chains = checks.find((c) => c.id === "model-chains")!;
  assert.equal(chains.status, "PASS");
  assert.ok(!chains.evidence.some((e) => e.includes("note")), "unpinned agent must not appear");
  assert.ok(!chains.evidence.some((e) => e.includes("usable null")));
});
test("runGateDoctor: model-chain check degrades to WARN when registry facts are absent", async () => {
  const deps = baseDeps({ registryFacts: undefined, modelsStorePath: join(tmpdir(), "none.json") });
  const checks = await runGateDoctor(deps);
  const chains = checks.find((c) => c.id === "model-chains")!;
  assert.equal(chains.status, "WARN");
});

// ---------- report ----------

test("formatDoctorReport: header, per-check lines and summary", () => {
  const checks: DoctorCheck[] = [
    { id: "model-chains", title: "agent model chains resolve to a usable model", status: "PASS", evidence: ["ok"] },
    { id: "git-hooks", title: "L3 git hooks installed", status: "FAIL", evidence: ["pre-commit: missing"], advice: ["run the installer"] },
  ];
  const report = formatDoctorReport(checks, "gate-doctor", new Date("2026-08-17T00:00:00.000Z"));
  assert.ok(report.startsWith("gate-doctor — pi-review-gate health report (2026-08-17T00:00:00.000Z)"));
  assert.ok(report.includes("✓ [PASS] model-chains"));
  assert.ok(report.includes("    · ok"));
  assert.ok(report.includes("✗ [FAIL] git-hooks"));
  assert.ok(report.includes("    → run the installer"));
  assert.ok(report.includes("summary: 1 PASS · 1 FAIL · 0 WARN — 1 item(s) need attention"));
});
