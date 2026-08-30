/**
 * /gate-doctor — read-only health check for the optimizations this package
 * ships: the agent model chains, the
 * precommit runner, the git hooks, the user-global config fallback, the L5
 * language gate, the Copilot gh compatibility path, and the command registry.
 * (The pdw engine check was deleted with the engine itself.)
 */
import { dirname, join } from "node:path";
import { diagnoseChain, type ModelChainEntry, type RegistryFacts } from "./model-diagnose.ts";
import { projectAgentIdentity, frontmatterBlock, resolvePackageAgentsDir } from "./model-config.ts";

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

/** Self-test the L5 gate function: English text passes, non-Latin text fails. */
export function checkLangGate(nonEnglish: (text: string) => boolean): DoctorCheck {
  try {
    const latin = !nonEnglish("This commit message is fine.");
    const nonLatin = nonEnglish("这是一条中文提交信息");
    if (latin && nonLatin) {
      return {
        id: "l5-language",
        title: "L5 commit/PR English gate functional",
        status: "PASS",
        evidence: ["self-test: English text passes, text with non-Latin letters fails"],
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
      evidence: [`${count} workflow commands registered (/review, …)`],
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
  /** Project-layer agent overrides (<repo>/.pi/agents) — when set, a file
   *  present there outranks the global copy for chain diagnosis, mirroring
   *  pi-subagents' load order (round-2 P2: doctor used to report the GLOBAL
   *  chain while the PROJECT override was what actually spawned). */
  projectAgentsDir?: string;
  modelsStorePath: string;
  globalConfigPath: string;
  /** Model registry facts (session registry + disk fallback); undefined when
   *  neither exists — chain checks then degrade to WARN, never fake PASS. */
  registryFacts?: RegistryFacts;
  hooksDir?: string;
  workflowCommandCount: number;
  /** The L5 decision (lib/lang-detect.ts judgeEnglish), injected for the self-test. */
  nonEnglish: (text: string) => boolean;
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
 * Absolute path of the postinstall script, for copy that tells a user how to
 * restore a missing agent role by hand.
 */
export function installScriptPath(packageRoot: string): string {
  return installScriptPathFrom(resolvePackageAgentsDir(), packageRoot);
}

/**
 * Pure half of {@link installScriptPath}, with the probe result injected.
 *
 * The remediation command is the MANUAL escape hatch out of a bootstrap
 * deadlock, so a path that does not exist turns the only exit into a
 * `Cannot find module`. It prefers the PROBED package dir (any copy pointing
 * at the install script embeds the helper-resolved path) and falls back to the
 * doctor's own packageRoot — `scripts/` is a sibling of `agents/`, one level
 * under the package root, never two. Split out so BOTH branches (probe found /
 * probe failed) are reachable from a test.
 */
export function installScriptPathFrom(agentsDir: string | null, packageRoot: string): string {
  const root = agentsDir ? dirname(agentsDir) : packageRoot;
  return join(root, "scripts", "install-package.mjs");
}

/**
 * Is the `goal-auditor` role dispatchable?
 *
 * This one has teeth the other agent files do not: `propose_loop_goal` refuses
 * to show the approval dialog without a recorded audit from it, so a missing
 * file means no goal can be approved — and in loop mode an unapproved goal
 * blocks edits too. The extension self-heals the file at session start; this
 * check is the observability for the case where the heal could not find the
 * package's own agents dir (or the user removed the file mid-session).
 *
 * BOTH layers are resolved by frontmatter IDENTITY, because that is what
 * pi-subagents actually dispatches on: a file called custom.md declaring
 * `name: goal-auditor` IS the role, while a `goal-auditor.md` whose
 * frontmatter lacks name+description (or names another role) is skipped at
 * load time. Judging by filename would therefore cut both ways — a false
 * PASS on a broken file and a false MISSING on a renamed one — in the one
 * check whose entire job is to catch an undispatchable gate role.
 */
export function goalAuditorCheck(deps: DoctorDeps): DoctorCheck {
  /**
   * File in `dir` whose frontmatter declares `name: goal-auditor`. LAST match
   * wins, exactly like pi-subagents' own `projectMap.set(name, agent)` — with
   * two files claiming the role, this must name the one the runtime deploys.
   */
  const identityFileIn = (dir: string): string | undefined => {
    let found: string | undefined;
    for (const f of deps.readdir(dir) ?? []) {
      if (!f.endsWith(".md")) continue;
      const text = deps.readFile(join(dir, f));
      if (text && projectAgentIdentity(text) === "goal-auditor") found = join(dir, f);
    }
    return found;
  };
  const globalFile = identityFileIn(deps.agentsDir);
  const inGlobal = globalFile !== undefined;
  const projectIdentityFile = deps.projectAgentsDir ? identityFileIn(deps.projectAgentsDir) : undefined;
  // IDENTITY ONLY — no filename fallback in either layer: pi-subagents skips a
  // file whose frontmatter lacks name+description (or declares another role),
  // so `goal-auditor.md` alone is NOT evidence of dispatchability, and passing
  // on it would be a false PASS for the one check meant to catch an
  // undispatchable gate role.
  const inProject = projectIdentityFile !== undefined;
  const evidence = [
    inGlobal
      ? `found (declares name: goal-auditor): ${globalFile}`
      : `MISSING: no agent in ${deps.agentsDir} declares name: goal-auditor`,
    ...(projectIdentityFile ? [`found (by frontmatter name): ${projectIdentityFile}`] : []),
    ...(deps.projectAgentsDir && !projectIdentityFile
      ? [`no project agent declares name: goal-auditor in ${deps.projectAgentsDir}`]
      : []),
  ];
  if (inGlobal || inProject) {
    return { id: "goal-auditor", title: "goal-auditor role is dispatchable (gates goal approval)", status: "PASS", evidence };
  }
  return {
    id: "goal-auditor",
    title: "goal-auditor role is dispatchable (gates goal approval)",
    status: "FAIL",
    evidence,
    advice: [
      "start a new session: the extension self-heals missing agent files from the package's agents/ dir",
      `if it stays missing the package agents dir could not be located (包内 agents 目录无法定位) — re-run the postinstall: node ${installScriptPath(deps.packageRoot)}`,
      "without it propose_loop_goal cannot be satisfied, and loop mode blocks edits on an unapproved goal",
    ],
  };
}

/**
 * Build RegistryFacts from the session model registry, falling back to disk
 * files (~/.pi/agent/models-store.json + auth.json) when the registry is
 * empty. Same contract as the extension's modelDiagnosisLines facts.
 */
export function factsFromRegistry(registry: unknown, homeDir: string, readFile: (p: string) => string | undefined): RegistryFacts {
  const authedProviders = new Set<string>();
  const models: Array<{
    provider: string;
    id: string;
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
  }> = [];
  const reg = registry as { getAll?: () => unknown[]; hasConfiguredAuth?: (m: unknown) => boolean } | undefined;
  const all = reg?.getAll?.() ?? [];
  if (Array.isArray(all) && all.length > 0) {
    const authCheckable = typeof reg?.hasConfiguredAuth === "function";
    for (const m of all) {
      const obj = m as { provider?: unknown; id?: unknown; reasoning?: unknown; thinkingLevelMap?: unknown };
      if (typeof obj.provider !== "string" || typeof obj.id !== "string") continue;
      const tlm = obj.thinkingLevelMap;
      const thinkingLevelMap =
        typeof tlm === "object" && tlm !== null && !Array.isArray(tlm)
          ? Object.fromEntries(Object.entries(tlm).filter(([, mapped]) => mapped === null || typeof mapped === "string")) as Record<string, string | null>
          : undefined;
      models.push({
        provider: obj.provider,
        id: obj.id,
        ...(typeof obj.reasoning === "boolean" ? { reasoning: obj.reasoning } : {}),
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      });
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
  return { models, authedProviders };
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
  // Project-layer-only files are diagnosed too (round-5 P2): pi-subagents
  // loads anything under <repo>/.pi/agents, so a file that exists ONLY in
  // the project layer (no global copy) is still a live chain the doctor
  // must see — enumerate the UNION, project-first per file below.
  //
  // KNOWN LIMITATION (deliberate): this enumeration is FLAT, while
  // pi-subagents' loadAgentsFromDir walks `listFilesRecursive`
  // (node_modules/pi-subagents/src/agents/agents.ts:1516). An agent file in a
  // SUBDIRECTORY of <repo>/.pi/agents is therefore loaded at runtime but not
  // diagnosed here. Widening this would mean a recursive contract for the
  // injected `readdir` dep (it returns plain names and cannot report file
  // types), so it is left flat: the renderer only ever writes FLAT files into
  // that directory, and a hand-nested file is out of the layer's own scope.
  let projectFiles: string[] = [];
  if (deps.projectAgentsDir) {
    const listed = deps.readdir(deps.projectAgentsDir);
    if (listed === undefined && deps.exists(deps.projectAgentsDir)) {
      // The dir EXISTS but is not readable: treating it as "no project
      // layer" would silently drop every project-override chain and can
      // fake a PASS on a dead global chain (round-11 P1). Fail like the
      // unreadable global dir above instead.
      return {
        id: "model-chains",
        title: "agent model chains resolve to a usable model",
        status: "FAIL",
        evidence: [`project agents dir not readable: ${deps.projectAgentsDir}`],
        advice: ["check permissions on <repo>/.pi/agents — project-layer chains are diagnosed too"],
      };
    }
    projectFiles = listed ?? [];
  }
  const factsAvailable = (deps.registryFacts?.models.length ?? 0) > 0;
  const entries: ModelChainEntry[] = [];
  // pi-subagents registers agents under their frontmatter `name` and lets a
  // project agent override a global one OF THE SAME NAME (basename is
  // irrelevant). Build identity → project-text first (round-11 P1: a
  // custom.md carrying `name: reviewer` really shadows the global reviewer).
  const projectByIdentity = new Map<string, string>();
  if (deps.projectAgentsDir) {
    for (const pf of projectFiles) {
      if (!pf.endsWith(".md")) continue;
      const ptext = deps.readFile(join(deps.projectAgentsDir, pf));
      if (ptext === undefined) continue;
      const identity = projectAgentIdentity(ptext);
      if (identity !== undefined) projectByIdentity.set(identity, ptext);
    }
  }
  const diagnose = (role: string, text: string): void => {
    // Same delimiter authority as projectAgentIdentity above: a stricter local
    // regex here made an overriding project file shadow the global entry (the
    // `continue` below) AND then be skipped, so the role vanished from the
    // diagnosis and a DEAD live chain reported PASS.
    if (frontmatterBlock(text) === undefined) return;
    const diagnosed = diagnoseChain(role, text, deps.registryFacts ?? { models: [], authedProviders: new Set() });
    if (diagnosed.chain.length > 0) entries.push(diagnosed);
  };
  // Global files, with any same-identity project override winning.
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const role = f.slice(0, -3);
    const projText = projectByIdentity.get(role);
    if (projText !== undefined) {
      diagnose(role, projText);
      continue;
    }
    const text = deps.readFile(join(deps.agentsDir, f));
    if (text === undefined) continue;
    diagnose(role, text);
  }
  // Project-only agents (no global file of the same identity).
  // Only .md files are agent files (upstream filters the same way), so a stray
  // extensionless entry must not occupy a project agent's identity here.
  const globalRoles = new Set(files.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)));
  for (const [identity, text] of projectByIdentity) {
    if (globalRoles.has(identity)) continue;
    diagnose(identity, text);
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
  const gh = await deps.probeGh();
  return [
    modelChainCheck(deps),
    goalAuditorCheck(deps),
    checkGlobalConfig(deps.readFile(deps.globalConfigPath)),
    checkPrecommitRunner(runnerCandidates(deps.packageRoot), deps.exists),
    checkGitHooks(hookProbeFor(deps), GATE_HOOK_NAMES),
    checkLangGate(deps.nonEnglish),
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
