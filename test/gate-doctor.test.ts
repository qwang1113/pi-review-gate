import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, accessSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPdwEngine,
  checkModelChains,
  checkOpencodeGoStore,
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
} from "../lib/gate-doctor.ts";
import { diagnoseChain, type ModelChainEntry } from "../lib/model-diagnose.ts";
import { isNonEnglishText } from "../lib/lang-detect.ts";

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

// ---------- pdw-engine ----------

test("checkPdwEngine: loadable engine passes, failure fails with reinstall advice", () => {
  const pass = checkPdwEngine({ ok: true, value: "runWorkflow exported" });
  assert.equal(pass.status, "PASS");
  assert.ok(pass.evidence.some((e) => e.includes("runWorkflow")));
  const fail = checkPdwEngine({ ok: false, error: "module not found" });
  assert.equal(fail.status, "FAIL");
  assert.equal(fail.evidence[0], "module not found");
  assert.ok(fail.advice?.[0]?.includes("re-install"));
  // The engine's SCOPE shrank: review runs on plain subagents now, so a missing
  // engine no longer blocks reviewing. The advice must say which paths need it,
  // or a user reads FAIL as "the gate is broken".
  assert.ok(
    fail.advice?.some((a) => /wave/i.test(a) && /decompose/i.test(a)),
    "the advice must scope the dependency to wave + decompose",
  );
  assert.ok(
    fail.advice?.some((a) => /review runs on plain subagents/i.test(a)),
    "the advice must say review is unaffected",
  );
  assert.ok(
    pass.evidence.some((e) => /wave|decompose/i.test(e)),
    "the PASS evidence must name what the engine is still for",
  );
});

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

// ---------- opencode-go ----------

test("checkOpencodeGoStore: absent store passes (allowlist still guards)", () => {
  const check = checkOpencodeGoStore(undefined, false);
  assert.equal(check.status, "PASS");
});

test("checkOpencodeGoStore: flash-only store passes, backup noted", () => {
  const store = JSON.stringify({ "opencode-go": { models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-flash" }] } });
  const check = checkOpencodeGoStore(store, true);
  assert.equal(check.status, "PASS");
  assert.ok(check.evidence.some((e) => e.includes("2 model(s)")));
  assert.ok(check.evidence.some((e) => e.includes(".bak")));
});

test("checkOpencodeGoStore: stray models FAIL with the offending ids", () => {
  const store = JSON.stringify({ "opencode-go": { models: [{ id: "deepseek-v4-flash" }, { id: "opencode-go/expensive-1" }] } });
  const check = checkOpencodeGoStore(store, false);
  assert.equal(check.status, "FAIL");
  assert.ok(check.evidence[0]?.includes("opencode-go/expensive-1"));
  assert.ok(check.advice?.[0]?.includes("prune"));
});

test("checkOpencodeGoStore: corrupt JSON warns, never fails", () => {
  const check = checkOpencodeGoStore("{not json", false);
  assert.equal(check.status, "WARN");
});

test("checkOpencodeGoStore: provider entry missing entirely passes", () => {
  const check = checkOpencodeGoStore(JSON.stringify({ anthropic: { models: [] } }), false);
  assert.equal(check.status, "PASS");
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
  const pass = checkLangGate(isNonEnglishText);
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
  assert.ok(!facts.allowed({ provider: "opencode-go", id: "expensive" }), "allowlist applies in facts too");
  assert.ok(facts.allowed({ provider: "opencode-go", id: "deepseek-v4-flash" }));
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
    isNonEnglishText,
    probePdw: async () => ({ ok: true }),
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
    "pdw-engine", "model-chains", "opencode-go", "global-config",
    "precommit-runner", "git-hooks", "l5-language", "copilot-gh", "commands",
  ]);
  for (const c of checks) {
    assert.equal(c.status, "PASS", `${c.id} should PASS in a healthy env: ${JSON.stringify(c)}`);
  }
});

test("runGateDoctor: broken environment surfaces FAILs, one IO failure never throws", async () => {
  const deps = baseDeps({
    probePdw: async () => ({ ok: false, error: "PdwUnavailableError: engine missing" }),
    probeGh: async () => ({ ok: false, error: "ENOENT" }),
    modelsStorePath: join(tmpdir(), "does-not-exist.json"),
    workflowCommandCount: 1,
    readdir: () => undefined, // agents dir unreadable
  });
  const checks = await runGateDoctor(deps);
  const byId = new Map(checks.map((c) => [c.id, c]));
  assert.equal(byId.get("pdw-engine")?.status, "FAIL");
  assert.equal(byId.get("model-chains")?.status, "FAIL");
  assert.equal(byId.get("commands")?.status, "FAIL");
  assert.equal(byId.get("copilot-gh")?.status, "WARN");
  assert.equal(checks.length, 9, "one broken check must not suppress the rest");
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
    { id: "pdw-engine", title: "pdw workflow engine loads", status: "PASS", evidence: ["ok"] },
    { id: "git-hooks", title: "L3 git hooks installed", status: "FAIL", evidence: ["pre-commit: missing"], advice: ["run the installer"] },
  ];
  const report = formatDoctorReport(checks, "gate-doctor", new Date("2026-08-17T00:00:00.000Z"));
  assert.ok(report.startsWith("gate-doctor — pi-review-gate health report (2026-08-17T00:00:00.000Z)"));
  assert.ok(report.includes("✓ [PASS] pdw-engine"));
  assert.ok(report.includes("    · ok"));
  assert.ok(report.includes("✗ [FAIL] git-hooks"));
  assert.ok(report.includes("    → run the installer"));
  assert.ok(report.includes("summary: 1 PASS · 1 FAIL · 0 WARN — 1 item(s) need attention"));
});
