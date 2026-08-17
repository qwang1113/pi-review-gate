/**
 * /gate-doctor — read-only health check for the optimizations this package
 * ships: the pdw engine (parallel review / wave daily), the agent model
 * chains, the opencode-go provider allowlist, the precommit runner, the git
 * hooks, the user-global config fallback, the L5 language gate, the Copilot
 * gh compatibility path, and the command registry.
 *
 * DIAGNOSTICS ONLY, by design: nothing here reads or writes gate state, no
 * check decides a verdict, nothing blocks a ship. Every check returns
 * PASS / FAIL / WARN with evidence and repair advice; a single IO failure
 * degrades that one check, never the whole report (best-effort, symmetric
 * with modelDiagnosisLines in the extension).
 *
 * All decision logic is PURE (facts injected, no I/O inside a check); the
 * only I/O lives in `runGateDoctor`'s deps, so the whole report is
 * unit-testable with fake filesystems and probes.
 */
import { join } from "node:path";
import { diagnoseChain, type ModelChainEntry, type RegistryFacts } from "./model-diagnose.ts";
import { isModelAllowed } from "./pdw-bridge.ts";

export type DoctorStatus = "PASS" | "FAIL" | "WARN";

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorStatus;
  /** One line of evidence per fact the check actually observed. */
  evidence: string[];
  /** Repair guidance shown when status !== PASS (never for PASS). */
  advice?: string[];
}

/** The git hooks this package installs (see scripts/install-git-hooks.sh). */
export const GATE_HOOK_NAMES = ["pre-commit", "commit-msg", "pre-push"] as const;

/** Minimum WORKFLOW_COMMANDS count before the registry check passes. */
export const MIN_WORKFLOW_COMMANDS = 10;

// ---------- pure checks ----------

export interface ProbeResult<T = string> {
  ok: boolean;
  value?: T;
  error?: string;
}

export function checkPdwEngine(result: ProbeResult): DoctorCheck {
  if (result.ok) {
    return {
      id: "pdw-engine",
      title: "pdw workflow engine loads",
      status: "PASS",
      evidence: [result.value ?? "@quintinshaw/pi-dynamic-workflows imports, runWorkflow exported"],
    };
  }
  return {
    id: "pdw-engine",
    title: "pdw workflow engine loads",
    status: "FAIL",
    evidence: [result.error ?? "engine unavailable"],
    advice: [
      "re-install the package so its node_modules land next to the extension code: `pi install` it, or run `scripts/install-package.mjs` / `npm install` in the package repo",
    ],
  };
}

export function checkModelChains(entries: ModelChainEntry[], factsAvailable: boolean): DoctorCheck {
  if (entries.length === 0) {
    return {
      id: "model-chains",
      title: "agent model chains resolve to a usable model",
      status: "WARN",
      evidence: ["no model chain found in any agents/*.md frontmatter (files missing or unpinned)"],
      advice: ["re-run the postinstall (scripts/install-package.mjs) to refresh ~/.pi/agent/agents/"],
    };
  }
  const blocked = entries.filter((e) => e.blocked);
  const evidence = entries.map((e) =>
    e.blocked ? `${e.role}: BLOCKED (${e.chain.join(" → ")})` : `${e.role}: usable ${e.usable}`,
  );
  if (blocked.length > 0 && !factsAvailable) {
    return {
      id: "model-chains",
      title: "agent model chains resolve to a usable model",
      status: "WARN",
      evidence: [
        ...evidence,
        "registry facts unavailable (no session registry, no models-store/auth.json) — cannot confirm the chains resolve",
      ],
    };
  }
  if (blocked.length > 0) {
    return {
      id: "model-chains",
      title: "agent model chains resolve to a usable model",
      status: "FAIL",
      evidence,
      advice: [
        "fix the BLOCKED chain(s) in ~/.pi/agent/agents/*.md — every fallback must resolve in the active model registry (a review on a blocked agent cannot start)",
      ],
    };
  }
  return { id: "model-chains", title: "agent model chains resolve to a usable model", status: "PASS", evidence };
}

/**
 * USER REQUIREMENT — the opencode-go provider bills per model and only
 * deepseek-v4-flash is approved; the postinstall prunes the models-store
 * cache to flash alone (scripts/install-package.mjs pruneOpenCodeGoModels).
 * The code-level allowlist is the real backstop — this check only verifies
 * the cache is not offering the expensive ids.
 */
export function checkOpencodeGoStore(storeRaw: string | undefined, backupExists: boolean): DoctorCheck {
  const base: DoctorCheck = {
    id: "opencode-go",
    title: "opencode-go models-store is pruned to deepseek-v4-flash only",
    status: "PASS",
    evidence: [],
  };
  if (storeRaw === undefined) {
    return {
      ...base,
      status: "PASS",
      evidence: ["no models-store.json — nothing to prune (the code-level allowlist still guards)"],
    };
  }
  let store: unknown;
  try {
    store = JSON.parse(storeRaw);
  } catch {
    return {
      ...base,
      status: "WARN",
      evidence: ["models-store.json is not valid JSON — cannot verify the prune"],
    };
  }
  if (typeof store !== "object" || store === null || Array.isArray(store)) {
    return { ...base, status: "WARN", evidence: ["models-store.json has an unexpected shape"] };
  }
  const og = (store as Record<string, unknown>)["opencode-go"];
  if (typeof og !== "object" || og === null || !Array.isArray((og as { models?: unknown }).models)) {
    return { ...base, evidence: ["opencode-go has no models-store entry — nothing to prune"] };
  }
  const models = (og as { models: Array<{ id?: unknown }> }).models;
  const stray = models.filter((m) => !(m && typeof m === "object" && m.id === "deepseek-v4-flash"));
  if (stray.length > 0) {
    return {
      ...base,
      status: "FAIL",
      evidence: [
        `opencode-go lists ${stray.length} model(s) besides deepseek-v4-flash: ${stray
          .map((m) => String((m as { id?: unknown })?.id ?? "?"))
          .join(", ")}`,
      ],
      advice: [
        "re-run the postinstall prune (scripts/install-package.mjs, idempotent; a .bak backup is kept) or edit models-store.json by hand — the code-level allowlist still blocks these at runtime",
      ],
    };
  }
  return {
    ...base,
    evidence: [
      `opencode-go lists ${models.length} model(s), all deepseek-v4-flash`,
      ...(backupExists ? ["prune backup present at models-store.json.bak"] : []),
    ],
  };
}

export function checkGlobalConfig(raw: string | undefined): DoctorCheck {
  if (raw === undefined) {
    return {
      id: "global-config",
      title: "user-global config fallback (~/.pi/review-gate.json) readable",
      status: "PASS",
      evidence: ["no global config file — legitimate (defaults + project .pi/review-gate.json still apply)"],
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        id: "global-config",
        title: "user-global config fallback (~/.pi/review-gate.json) readable",
        status: "FAIL",
        evidence: ["~/.pi/review-gate.json parses but is not a config object — loadProjectConfig silently ignores it"],
        advice: ["fix the JSON by hand; project config and defaults keep working in the meantime (fail-safe)"],
      };
    }
    const fields = Object.keys(parsed as Record<string, unknown>);
    return {
      id: "global-config",
      title: "user-global config fallback (~/.pi/review-gate.json) readable",
      status: "PASS",
      evidence: [
        `parsed OK — ${fields.length} top-level field(s): ${fields.slice(0, 8).join(", ")}${fields.length > 8 ? ", …" : ""}`,
      ],
    };
  } catch {
    return {
      id: "global-config",
      title: "user-global config fallback (~/.pi/review-gate.json) readable",
      status: "FAIL",
      evidence: ["~/.pi/review-gate.json exists but is not valid JSON — loadProjectConfig silently ignores it"],
      advice: ["fix the JSON by hand; project config and defaults keep working in the meantime (fail-safe)"],
    };
  }
}

export function checkPrecommitRunner(candidates: string[], exists: (p: string) => boolean): DoctorCheck {
  const found = candidates.find(exists);
  if (found) {
    return {
      id: "precommit-runner",
      title: "trusted precommit runner resolvable",
      status: "PASS",
      evidence: [found],
    };
  }
  return {
    id: "precommit-runner",
    title: "trusted precommit runner resolvable",
    status: "FAIL",
    evidence: ["none of the known install layouts contain precommit-runner.mjs"],
    advice: ["re-install the package (scripts/precommit-runner.mjs must sit next to the extension code)"],
  };
}

export type HookProbe = (name: string) => { exists: boolean; marker: boolean } | undefined;

export function checkGitHooks(probe: HookProbe, names: readonly string[]): DoctorCheck {
  const results = names.map((name) => ({ name, probe: probe(name) }));
  if (results.every((r) => r.probe === undefined)) {
    return {
      id: "git-hooks",
      title: "L3 git hooks installed in this repo",
      status: "WARN",
      evidence: ["git hooks dir not resolvable (git unavailable or not a repo) — cannot verify"],
    };
  }
  const missing = results.filter((r) => r.probe && !r.probe.exists);
  const noMarker = results.filter((r) => r.probe && r.probe.exists && !r.probe.marker);
  const evidence = results.map((r) =>
    r.probe === undefined
      ? `${r.name}: unverifiable`
      : r.probe.exists
        ? `${r.name}: installed${r.probe.marker ? " (gate marker)" : " (no marker)"}`
        : `${r.name}: missing`,
  );
  if (missing.length > 0) {
    return {
      id: "git-hooks",
      title: "L3 git hooks installed in this repo",
      status: "FAIL",
      evidence,
      advice: [
        `run 'bash scripts/install-git-hooks.sh' in this repo (installs ${names.join(", ")}, chaining any existing hooks)`,
      ],
    };
  }
  if (noMarker.length > 0) {
    return {
      id: "git-hooks",
      title: "L3 git hooks installed in this repo",
      status: "WARN",
      evidence,
      advice: [
        "hooks exist but lack the gate marker — they may be an external or older install; re-run scripts/install-git-hooks.sh to (re)chain",
      ],
    };
  }
  return { id: "git-hooks", title: "L3 git hooks installed in this repo", status: "PASS", evidence };
}

/** Self-test the L5 gate function: a Latin body must pass, a non-Latin body must fail. */
export function checkLangGate(isNonEnglishText: (text: string) => boolean): DoctorCheck {
  try {
    const latin = !isNonEnglishText("This commit message is fine.");
    const nonLatin = isNonEnglishText("这是一条中文提交信息");
    if (latin && nonLatin) {
      return {
        id: "l5-language",
        title: "L5 commit/PR English gate functional",
        status: "PASS",
        evidence: ["self-test: Latin body passes, non-Latin-majority body fails"],
      };
    }
    return {
      id: "l5-language",
      title: "L5 commit/PR English gate functional",
      status: "FAIL",
      evidence: [
        `self-test mismatch: Latin body → ${latin ? "pass" : "FAIL"}, non-Latin body → ${nonLatin ? "fail" : "PASS"}`,
      ],
    };
  } catch (e) {
    return {
      id: "l5-language",
      title: "L5 commit/PR English gate functional",
      status: "FAIL",
      evidence: [`self-test threw: ${(e as Error).message}`],
    };
  }
}

export function checkCopilotGh(result: ProbeResult): DoctorCheck {
  if (result.ok) {
    return {
      id: "copilot-gh",
      title: "Copilot review gh integration available",
      status: "PASS",
      evidence: [
        `gh resolves (${result.value ?? "version unknown"})`,
        "pr view compat: modern + legacy --json field lists both wired (headRefOid → timestamp fallback)",
      ],
    };
  }
  return {
    id: "copilot-gh",
    title: "Copilot review gh integration available",
    status: "WARN",
    evidence: [
      `gh not usable: ${result.error ?? "unknown error"}`,
      "the Copilot cycle needs gh; the core review gate does not depend on it",
    ],
    advice: ["install gh and authenticate (gh auth login) to enable Copilot review cycles"],
  };
}

export function checkCommandRegistry(count: number): DoctorCheck {
  if (count >= MIN_WORKFLOW_COMMANDS) {
    return {
      id: "commands",
      title: "workflow command registry populated",
      status: "PASS",
      evidence: [`${count} workflow commands registered (/review, /plan-next, …)`],
    };
  }
  return {
    id: "commands",
    title: "workflow command registry populated",
    status: "FAIL",
    evidence: [`only ${count} workflow command(s) registered (expected >= ${MIN_WORKFLOW_COMMANDS})`],
    advice: ["re-install the extension — WORKFLOW_COMMANDS looks truncated"],
  };
}

// ---------- orchestration ----------

export interface DoctorDeps {
  homeDir: string;
  /** Package root (extension repo layout): scripts/, agents/, hooks/ live here. */
  packageRoot: string;
  /** Where agents/*.md are expected: ~/.pi/agent/agents (postinstall target). */
  agentsDir: string;
  modelsStorePath: string;
  globalConfigPath: string;
  /** Model registry facts (session registry + disk fallback); undefined when
   *  neither exists — chain checks then degrade to WARN, never fake PASS. */
  registryFacts?: RegistryFacts;
  hooksDir?: string;
  workflowCommandCount: number;
  isNonEnglishText: (text: string) => boolean;
  probePdw: () => Promise<ProbeResult>;
  probeGh: () => Promise<ProbeResult>;
  readFile: (path: string) => string | undefined;
  exists: (path: string) => boolean;
  readdir: (path: string) => string[] | undefined;
}

/** Candidate runner paths across the known install layouts (mirrors
 *  resolveTrustedRunner in the extension). */
export function runnerCandidates(packageRoot: string): string[] {
  return [
    join(packageRoot, "scripts", "precommit-runner.mjs"), // repo layout
    join(packageRoot, "..", "scripts", "precommit-runner.mjs"), // extensions/ sibling
    join(packageRoot, "..", "..", "scripts", "pi-review-gate-precommit.mjs"), // global install
  ];
}

/**
 * Build RegistryFacts from the session model registry, falling back to disk
 * files (~/.pi/agent/models-store.json + auth.json) when the registry is
 * empty. Same contract as the extension's modelDiagnosisLines facts.
 */
export function factsFromRegistry(registry: unknown, homeDir: string, readFile: (p: string) => string | undefined): RegistryFacts {
  const authedProviders = new Set<string>();
  const models: Array<{ provider: string; id: string }> = [];
  const reg = registry as { getAll?: () => unknown[]; hasConfiguredAuth?: (m: unknown) => boolean } | undefined;
  const all = reg?.getAll?.() ?? [];
  if (Array.isArray(all) && all.length > 0) {
    const authCheckable = typeof reg?.hasConfiguredAuth === "function";
    for (const m of all) {
      const obj = m as { provider?: unknown; id?: unknown };
      if (typeof obj.provider !== "string" || typeof obj.id !== "string") continue;
      models.push({ provider: obj.provider, id: obj.id });
      if (!authCheckable || reg!.hasConfiguredAuth!(obj)) authedProviders.add(obj.provider);
    }
  }
  if (models.length === 0) {
    const storeRaw = readFile(join(homeDir, ".pi", "agent", "models-store.json"));
    try {
      const store = storeRaw ? (JSON.parse(storeRaw) as Record<string, { models?: Array<{ provider?: string; id?: string }> }>) : null;
      if (store && typeof store === "object") {
        for (const prov of Object.keys(store)) {
          for (const m of store[prov]?.models ?? []) {
            if (typeof m.provider === "string" && typeof m.id === "string") {
              models.push({ provider: m.provider, id: m.id });
            }
          }
        }
      }
    } catch { /* corrupt store — empty registry */ }
    const authRaw = readFile(join(homeDir, ".pi", "agent", "auth.json"));
    try {
      if (authRaw) {
        const auth = JSON.parse(authRaw) as Record<string, unknown>;
        for (const k of Object.keys(auth)) authedProviders.add(k);
      }
    } catch { /* no auth — no provider looks usable */ }
  }
  return { models, authedProviders, allowed: isModelAllowed };
}

function modelChainCheck(deps: DoctorDeps): DoctorCheck {
  const files = deps.readdir(deps.agentsDir);
  if (files === undefined) {
    return {
      id: "model-chains",
      title: "agent model chains resolve to a usable model",
      status: "FAIL",
      evidence: [`agents dir not readable: ${deps.agentsDir}`],
      advice: ["re-run the postinstall (scripts/install-package.mjs) — it copies agents/*.md to ~/.pi/agent/agents/"],
    };
  }
  const agentFiles = files.filter((f) => f.endsWith(".md"));
  const factsAvailable = (deps.registryFacts?.models.length ?? 0) > 0;
  const entries: ModelChainEntry[] = [];
  for (const f of agentFiles) {
    const text = deps.readFile(join(deps.agentsDir, f));
    if (text === undefined) continue; // best-effort: one unreadable agent degrades nothing
    const role = f.slice(0, -3);
    // Only agents with a YAML frontmatter can pin a model chain; diagnoseChain
    // parses the frontmatter itself and yields an empty chain otherwise.
    if (!/^---\n[\s\S]*?\n---/.test(text)) continue;
    const diagnosed = diagnoseChain(role, text, deps.registryFacts ?? { models: [], authedProviders: new Set(), allowed: () => true });
    if (diagnosed.chain.length === 0) continue; // frontmatter without a model pin is not a chain
    entries.push(diagnosed);
  }
  return checkModelChains(entries, factsAvailable);
}

/** Probe one git hook file for existence + the install marker. */
function hookProbeFor(deps: DoctorDeps): HookProbe {
  return (name) => {
    if (deps.hooksDir === undefined) return undefined;
    const p = join(deps.hooksDir, name);
    if (!deps.exists(p)) return { exists: false, marker: false };
    const raw = deps.readFile(p);
    return { exists: true, marker: raw !== undefined && raw.includes("# pi-review-gate:installed") };
  };
}

export async function runGateDoctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const pdw = await deps.probePdw();
  const gh = await deps.probeGh();
  return [
    checkPdwEngine(pdw),
    modelChainCheck(deps),
    checkOpencodeGoStore(deps.readFile(deps.modelsStorePath), deps.exists(`${deps.modelsStorePath}.bak`)),
    checkGlobalConfig(deps.readFile(deps.globalConfigPath)),
    checkPrecommitRunner(runnerCandidates(deps.packageRoot), deps.exists),
    checkGitHooks(hookProbeFor(deps), GATE_HOOK_NAMES),
    checkLangGate(deps.isNonEnglishText),
    checkCopilotGh(gh),
    checkCommandRegistry(deps.workflowCommandCount),
  ];
}

// ---------- report ----------

const STATUS_ICON: Record<DoctorStatus, string> = { PASS: "✓", FAIL: "✗", WARN: "!" };

export function formatDoctorReport(checks: DoctorCheck[], label = "gate-doctor", now = new Date()): string {
  const lines = checks.map((c) => {
    const head = `${STATUS_ICON[c.status]} [${c.status}] ${c.id} — ${c.title}`;
    const evidence = c.evidence.map((e) => `    · ${e}`);
    const advice = (c.advice ?? []).map((a) => `    → ${a}`);
    return [head, ...evidence, ...advice].join("\n");
  });
  const counts = { PASS: 0, FAIL: 0, WARN: 0 };
  for (const c of checks) counts[c.status] += 1;
  const attention = counts.FAIL + counts.WARN;
  return [
    `${label} — pi-review-gate health report (${now.toISOString()})`,
    ...lines,
    "",
    `summary: ${counts.PASS} PASS · ${counts.FAIL} FAIL · ${counts.WARN} WARN — ${attention} item(s) need attention`,
  ].join("\n");
}
