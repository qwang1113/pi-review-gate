/**
 * The gate's two READ-ONLY diagnosis surfaces: the model-chain readout that
 * `/gate-status` embeds, and the `/gate-doctor` health check.
 *
 * They live here rather than in `extensions/review-gate.ts` for the reason
 * this repository has a rule about (AGENTS.md §"架构规范"): that file is
 * ~8000 lines, and it got there one "just add the body here" at a time. The
 * orchestration tools moved out first (lib/orchestrator-*-tools.ts), then the
 * judge tools (lib/judge-session-tools.ts), the prepare family
 * (lib/review-prepare-tools.ts, lib/advisory-prepare-tools.ts), the L7 Copilot
 * pair (lib/copilot-review-tools.ts) and the user-interaction family
 * (lib/user-interaction-tools.ts + lib/consent-request-tools.ts). Same shape
 * here, with every effect arriving through an injected `deps` object.
 *
 * THE BOUNDARY: this module owns what the two DIAGNOSES look at and how they
 * are rendered. Its sibling lib/gate-command-tools.ts owns the rest of the
 * command layer and is the family's single registration entry point — it
 * calls the function below, so the extension wires the whole family exactly
 * once (philosophy two: one thing, one entry). The rules are not this
 * module's either: the chain analysis is lib/model-diagnose.ts, the checks
 * are lib/gate-doctor.ts, the allowlist lib/model-allowlist.ts and the L5
 * language policy lib/lang-detect.ts. What is left here is the ENVIRONMENT
 * probing those pure functions need — the model registry, the two agent
 * layers, the git hooks dir, the `gh` binary — behind an injected seam.
 *
 * PURE DIAGNOSTICS: nothing in this file writes state, and nothing it returns
 * feeds a gate verdict. Every read is best-effort — an IO failure degrades to
 * fewer lines, never to a block. That is deliberate: a broken `~/.pi` must not
 * be able to stop a review.
 *
 * BEHAVIOR IS FROZEN: this module was moved verbatim out of the extension.
 * Command names, descriptions, readout text, notification levels and the
 * fallback branches are the ones already documented; changing any of them is
 * a separate, deliberate change.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { execFileSync } from "node:child_process";

import { diagnoseChain, formatModelDiagnosis, type RegistryFacts } from "./model-diagnose.ts";
import { factsFromRegistry, formatDoctorReport, runGateDoctor } from "./gate-doctor.ts";
import { isModelAllowed } from "./model-allowlist.ts";
import { KNOWN_AGENTS, projectAgentIdentity } from "./model-config.ts";
import { judgeEnglish } from "./lang-detect.ts";
import { globalConfigPath } from "./project-config.ts";
import { WORKFLOW_COMMANDS } from "./workflow-commands.ts";
// TYPE-ONLY, so the runtime dependency stays one-way (that module imports
// this one to register /gate-doctor; a type import is erased at compile time).
import type { CommandContext, CommandHost } from "./gate-command-tools.ts";

/**
 * Everything the two diagnoses need from the outside world.
 *
 * Deliberately narrow: the analysis itself is already pure lib/ code, so what
 * is injected is only what this module cannot know — where the session sits
 * and how a project-layer agent file is resolved.
 */
export interface GateDiagnosisDeps {
  /**
   * The session's primary repo root — a GETTER, because the extension
   * REBINDS it at session_start (a captured value would keep diagnosing the
   * directory the session was launched in after it moved).
   */
  primaryRepoRoot(): string;
  /** The session cwd — where the git hooks dir is probed from. */
  cwd: string;
  /**
   * This package's own root directory.
   *
   * INJECTED rather than derived from `import.meta.url`: the doctor reads the
   * assets this package ships, and a module that computes that path itself
   * silently changes meaning the moment it is moved between directories.
   */
  packageRoot: string;
  /**
   * Read the PROJECT-layer agent file that actually shadows `name` at runtime
   * (resolved by frontmatter identity, not basename). The extension owns this
   * resolution because its widget and its tools resolve the same way.
   */
  findProjectAgentText(projectAgentsDir: string, name: string): string | undefined;
}

// ---------- the model-chain readout embedded in /gate-status ----------

/** Read-only model-chain diagnosis for /gate-status. Best-effort: any IO
 *  failure yields no lines (diagnostics never block, never gate).
 *
 *  PRIMARY facts source is the session's own model registry (the SAME
 *  facts the model registry exposes — it includes built-in catalogs
 *  like anthropic that never appear in models-store.json; reading only
 *  the store mis-reported every built-in judge chain as BLOCKED while
 *  the review was literally running on fable-5). File reads are a
 *  fallback when the registry exposes nothing. */
export function modelDiagnosisLines(deps: GateDiagnosisDeps, registry?: unknown): string[] {
  try {
    const home = homedir();
    const globalAgentsDir = pathJoin(home, ".pi", "agent", "agents");
    const projectAgentsDir = pathJoin(deps.primaryRepoRoot(), ".pi", "agents");
    // Effective chain = PROJECT layer file when present, else global
    // (project outranks global, exactly like the runtime load order).
    const readAgent = (name: string): string | undefined => {
      // Project layer wins by IDENTITY (frontmatter `name`), not basename:
      // pi-subagents registers any .md under the project dir under its
      // frontmatter name, so custom.md carrying `name: reviewer` really
      // shadows the global reviewer (round-11 P1/P2).
      const projText = deps.findProjectAgentText(projectAgentsDir, name);
      if (projText !== undefined) return projText;
      try {
        const p = pathJoin(globalAgentsDir, `${name}.md`);
        return existsSync(p) ? readFileSync(p, "utf8") : undefined;
      } catch { return undefined; }
    };
    const authedProviders = new Set<string>();
    const models: Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }> = [];
    const facts: RegistryFacts = { models, authedProviders, allowed: isModelAllowed };
    const reg = registry as { getAll?: () => unknown[]; hasConfiguredAuth?: (m: unknown) => boolean } | undefined;
    const all = reg?.getAll?.() ?? [];
    if (Array.isArray(all) && all.length > 0) {
      // Symmetric with gate-doctor's hasAuth guard: a registry without
      // hasConfiguredAuth skips the auth filter entirely (treating every
      // provider as authed would be wrong — the missing method is the
      // signal that auth is not part of this registry's contract).
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
      // Fallback: disk files (a host session without a usable registry).
      try {
        const store = JSON.parse(
          readFileSync(pathJoin(home, ".pi", "agent", "models-store.json"), "utf8"),
        ) as Record<string, { models?: Array<{ provider?: string; id?: string }> }>;
        for (const prov of Object.keys(store)) {
          for (const m of store[prov]?.models ?? []) {
            if (typeof m.provider === "string" && typeof m.id === "string") {
              models.push({ provider: m.provider, id: m.id });
            }
          }
        }
      } catch { /* no store — empty registry */ }
      try {
        const auth = JSON.parse(
          readFileSync(pathJoin(home, ".pi", "agent", "auth.json"), "utf8"),
        ) as Record<string, unknown>;
        for (const k of Object.keys(auth)) authedProviders.add(k);
      } catch { /* no auth — no provider looks usable */ }
    }
    // Diagnose KNOWN agents first, then any user-built/third-party agent
    // files found in either layer (project outranks global per readAgent).
    const fileNames = (dir: string): string[] => {
      try {
        return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
      } catch {
        return [];
      }
    };
    // The PROJECT layer is enumerated by frontmatter IDENTITY, not basename:
    // pi-subagents registers a project file under its `name`, so a
    // `custom.md` carrying `name: foo` is live as `foo`. Enumerating it as
    // "custom" made readAgent (which resolves by identity) find nothing, and
    // a project-ONLY agent whose basename differs from its name was invisible
    // here while gate-doctor's union enumeration did see it.
    const projectIdentityNames = (dir: string): string[] => {
      try {
        const out: string[] = [];
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".md")) continue;
          try {
            const id = projectAgentIdentity(readFileSync(pathJoin(dir, f), "utf8"));
            if (id !== undefined) out.push(id);
          } catch { /* unreadable file — not loadable either */ }
        }
        return out;
      } catch {
        return [];
      }
    };
    const allNames = [...new Set([...KNOWN_AGENTS, ...fileNames(globalAgentsDir), ...projectIdentityNames(projectAgentsDir)])];
    const entries = allNames
      .map((name) => {
        const text = readAgent(name);
        return text ? diagnoseChain(name, text, facts) : null;
      })
      .filter((e): e is NonNullable<typeof e> => e !== null && e.chain.length > 0);
    return entries.length === 0 ? [] : formatModelDiagnosis(entries).split("\n");
  } catch {
    return []; // diagnostics only — never block the status readout
  }
}

// ---------- /gate-doctor ----------

/** The handler body of /gate-doctor, split out so a test can reach it. */
export async function runGateDoctorCommand(deps: GateDiagnosisDeps, ctx: CommandContext): Promise<void> {
  const home = homedir();
  const cwd = deps.cwd;
  const packageRoot = deps.packageRoot;
  const readFileSafe = (p: string): string | undefined => {
    try { return readFileSync(p, "utf8"); } catch { return undefined; }
  };
  // git rev-parse --git-path hooks resolves the real hooks dir (worktrees,
  // core.hooksPath); unavailable → the hooks check degrades to WARN.
  let hooksDir: string | undefined;
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out.length > 0) hooksDir = pathResolve(cwd, out);
  } catch { /* git unavailable — hooks unverifiable */ }
  const checks = await runGateDoctor({
    homeDir: home,
    packageRoot,
    agentsDir: pathJoin(home, ".pi", "agent", "agents"),
    // Project-layer overrides outrank the global copies for diagnosis
    // (round-2 P2) — same per-file precedence pi-subagents loads with.
    projectAgentsDir: pathJoin(deps.primaryRepoRoot(), ".pi", "agents"),
    modelsStorePath: pathJoin(home, ".pi", "agent", "models-store.json"),
    globalConfigPath: globalConfigPath(home),
    registryFacts: factsFromRegistry(ctx.modelRegistry, home, readFileSafe),
    hooksDir,
    workflowCommandCount: Object.keys(WORKFLOW_COMMANDS).length,
    nonEnglish: (text) => judgeEnglish("commit-body", text) !== undefined,
    probeGh: async () => {
      try {
        const out = execFileSync("gh", ["--version"], {
          encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
        });
        return { ok: true, value: out.split(/\r?\n/)[0] ?? "" };
      } catch (e) {
        const err = e as { code?: unknown; message?: unknown };
        return { ok: false, error: err.code === "ENOENT" ? "gh not installed" : String(err.message ?? err.code ?? e) };
      }
    },
    readFile: readFileSafe,
    exists: existsSync,
    readdir: (p) => { try { return readdirSync(p); } catch { return undefined; } },
  });
  const attention = checks.filter((c) => c.status !== "PASS").length;
  ctx.ui.notify(formatDoctorReport(checks), attention ? "warning" : "info");
}

/**
 * Register /gate-doctor.
 *
 * Called by lib/gate-command-tools.ts, never by the extension: the command
 * layer has ONE registration entry on purpose (a layer an extension could
 * wire half of is a layer it eventually does).
 */
export function registerGateDiagnosisCommands(host: CommandHost, deps: GateDiagnosisDeps): void {
  // /gate-doctor — read-only health check: verifies every optimization this
  // package ships actually works in the CURRENT environment (model
  // chains, opencode-go prune, precommit runner, git hooks, global config
  // fallback, L5 gate, Copilot gh, command registry). Pure diagnostics: it
  // reads files and probes executables, writes NOTHING, and never feeds a
  // gate verdict.
  host.registerCommand("gate-doctor", {
    description: "Diagnose whether all optimizations are live (read-only health check)",
    handler: async (_args, ctx) => { await runGateDoctorCommand(deps, ctx); },
  });
}
