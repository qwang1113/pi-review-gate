/**
 * Where the orchestration layer meets the real machine.
 *
 * Everything the tools need that involves the OUTSIDE WORLD — running tmux,
 * reading and writing the plan file, adding and removing git worktrees,
 * taking attention events off the queue — is implemented once here, so the
 * extension only has to supply what genuinely belongs to it: the gate state,
 * the user dialog and the branch facts.
 *
 * That split is the whole point. `extensions/review-gate.ts` is already the
 * repository's worst architectural offender at 8659 lines, and this round
 * adds a rule against exactly that shape (task book §9). Putting the wiring
 * here keeps the extension's share of the orchestration layer down to a
 * registration call and a handful of accessors.
 *
 * SAFETY NOTE. `runTmux` spawns tmux WITHOUT a shell (execFileSync with an
 * argv array) and re-validates the argv through {@link assertSafeTmuxArgv}
 * first: the gate's own execution path is bound by the same forbidden list
 * the bash guard enforces against the agent, so "the gate is exempt from the
 * guard" can never mean "the gate may do the forbidden thing".
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFileAtomic } from "./atomic-write.ts";
import { consumeAttention, sideEffectsEnabled } from "./attention.ts";
import type { AttentionEvent } from "./attention.ts";
import { assertSafeTmuxArgv } from "./orchestrator-tmux.ts";
import { writeNotification } from "./orchestrator-notify.ts";
import { parsePlan, PLAN_RELPATH, type OrchestratorPlan } from "./orchestrator-plan.ts";
import { emptyRuntime, type OrchestratorRuntime } from "./orchestrator-registry.ts";
import type { BranchFacts, OrchestratorDeps, PlanRead, TmuxRunResult } from "./orchestrator-deps.ts";
import type { TaskMode } from "./task-mode.ts";

/** Run one tmux command with no shell in between. */
export function runTmux(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): TmuxRunResult {
  try {
    assertSafeTmuxArgv(argv);
  } catch (error) {
    return { ok: false, stdout: "", stderr: (error as Error).message };
  }
  try {
    const stdout = execFileSync("tmux", [...argv], {
      encoding: "utf8",
      env,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: String(stdout ?? ""), stderr: "" };
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    return { ok: false, stdout: "", stderr: String(err.stderr ?? err.message ?? "tmux failed") };
  }
}

/** Read + validate `.pi/orchestrator-plan.json`. Absent ⇒ no plan, no problems. */
export function readPlanFile(repoRoot: string): PlanRead {
  const path = join(repoRoot, PLAN_RELPATH);
  if (!existsSync(path)) return { problems: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { problems: [`plan 文件不是合法 JSON：${(error as Error).message}`] };
  }
  const parsed = parsePlan(raw);
  return { plan: parsed.plan, problems: parsed.problems };
}

/** Persist a plan atomically inside the gate-owned `.pi/` scope. */
export function writePlanFile(repoRoot: string, plan: OrchestratorPlan): void {
  const path = join(repoRoot, PLAN_RELPATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(plan, null, 2) + "\n");
}

/**
 * Worktrees for parallel children live OUTSIDE the repo, under the system
 * temp dir: a checkout inside the repo would show up in every status, every
 * fingerprint and every `git add -A` the gate performs.
 */
export function worktreeRootFor(repoRoot: string): string {
  const key = repoRoot.replace(/[^A-Za-z0-9]/g, "-").slice(-40);
  return join(tmpdir(), "rg-orchestration", key);
}

export function addWorktree(
  repoRoot: string,
  name: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
  const path = join(worktreeRootFor(repoRoot), `${safe}-${Date.now().toString(36)}`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", path], {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, path };
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    return { ok: false, error: String(err.stderr ?? err.message ?? "git worktree add failed") };
  }
}

/** Remove a worktree the gate created. Best-effort: never throws. */
export function removeWorktree(repoRoot: string, path: string): void {
  // Refuse to touch anything outside the directory we create them in: a
  // corrupted registry entry must not be able to point `git worktree remove`
  // (or the rm below) at the user's own checkout.
  const root = worktreeRootFor(repoRoot);
  const target = resolve(path);
  if (!target.startsWith(resolve(root) + "/")) return;
  try {
    execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", target], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    try { rmSync(target, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Emit the notification sequence, gated by the SAME side-effect check
 * lib/attention.ts uses (no TTY, CI, or a test runner ⇒ nothing happens).
 *
 * That gate is not tidiness: an escape sequence written from a test run lands
 * on a real terminal, which is exactly the leak the attention module had to
 * be fixed for. Returns whether anything actually went out, so the caller can
 * tell the agent the truth and skip recording a send that never happened.
 */
export function emitNotification(sequence: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!sideEffectsEnabled(env, process.stdout.isTTY)) return false;
  writeNotification(sequence);
  return true;
}

/** Character count of a repo-relative file; undefined when it is not there. */
export function fileCharsIn(repoRoot: string, relPath: string): number | undefined {
  try {
    const path = join(repoRoot, relPath);
    if (!existsSync(path) || !statSync(path).isFile()) return undefined;
    return readFileSync(path, "utf8").length;
  } catch {
    return undefined;
  }
}

/** What the EXTENSION still owns and must supply. */
export interface OrchestratorHostBindings {
  repoRoot: string;
  taskMode(): TaskMode | undefined;
  /** The persisted runtime, or undefined before the first orchestration call. */
  loadRuntime(): OrchestratorRuntime | undefined;
  /** Persist it into the gate sidecar. */
  storeRuntime(runtime: OrchestratorRuntime): void;
  /** The orchestration id this session holds (inherited or freshly minted). */
  orchestrationId(): string;
  confirm(title: string, message: string): Promise<boolean>;
  branchFacts(): BranchFacts;
  sessionTranscriptPath(): string | undefined;
  now?(): number;
  env?(): NodeJS.ProcessEnv;
}

/**
 * Assemble the dependency object the tools run against.
 *
 * `runtime()` self-heals: a session that has never orchestrated (or a
 * successor that inherited only an id) gets a fresh empty runtime bound to
 * the current orchestration id, rather than the tools having to handle
 * "undefined" everywhere.
 */
export function createOrchestratorDeps(host: OrchestratorHostBindings): OrchestratorDeps {
  const env = () => (host.env ? host.env() : process.env);
  return {
    repoRoot: host.repoRoot,
    now: host.now ?? (() => Date.now()),
    env,
    taskMode: host.taskMode,
    runtime(): OrchestratorRuntime {
      const stored = host.loadRuntime();
      const id = host.orchestrationId();
      if (!stored) return emptyRuntime(id);
      // A relay successor inherits the id from its environment; the stored
      // runtime may still carry the predecessor's. The environment wins.
      return stored.orchestrationId === id ? stored : { ...stored, orchestrationId: id };
    },
    saveRuntime: host.storeRuntime,
    readPlan: () => readPlanFile(host.repoRoot),
    savePlan: (plan) => writePlanFile(host.repoRoot, plan),
    tmux: (argv) => runTmux(argv, env()),
    ownPane: () => {
      const pane = env().TMUX_PANE?.trim();
      return pane && pane.length > 0 ? pane : undefined;
    },
    confirm: host.confirm,
    addWorktree: (name) => addWorktree(host.repoRoot, name),
    removeWorktree: (path) => removeWorktree(host.repoRoot, path),
    consumeAttention: (): AttentionEvent | undefined => consumeAttention(host.orchestrationId()),
    branchFacts: host.branchFacts,
    emitNotification: (sequence) => emitNotification(sequence, env()),
    fileChars: (relPath) => fileCharsIn(host.repoRoot, relPath),
    sessionTranscriptPath: host.sessionTranscriptPath,
  };
}
