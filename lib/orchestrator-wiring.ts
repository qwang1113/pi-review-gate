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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";

import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFileAtomic } from "./atomic-write.ts";
import { sideEffectsEnabled } from "./side-effects.ts";
import { nodeChannelIO } from "./orchestrator-channel.ts";
import type { SupervisionMemory } from "./orchestrator-supervisor.ts";

import { assertSafeTmuxArgv } from "./orchestrator-tmux.ts";
import { writeNotification } from "./orchestrator-notify.ts";
import { TASK_FILE_DIRNAME } from "./orchestrator-delivery.ts";
import { sidecarPath } from "./gate-state.ts";



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

/**
 * The branch name a gate-created worktree is checked out ON.
 *
 * R-2: the worktree used to be created with `--detach`, so the child landed
 * on a detached HEAD and its own `setup_workspace` refused ("当前是 detached
 * HEAD，无法确定基准分支"). Both children that hit this invented the same
 * `git checkout -b` workaround — which is precisely the "the gate provides
 * the tool, the session does not assemble it" rule being broken. The gate
 * creates the worktree, so the gate creates its branch.
 */
export function worktreeBranchName(taskId: string, now: number = Date.now()): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40).replace(/^[.-]+/, "");
  return `orch/${safe || "task"}-${Math.floor(now).toString(36)}`;
}

export function addWorktree(
  repoRoot: string,
  name: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
  const path = join(worktreeRootFor(repoRoot), `${safe}-${Date.now().toString(36)}`);
  const branch = worktreeBranchName(name);
  try {
    mkdirSync(dirname(path), { recursive: true });
    // `-b <branch>`, never `--detach` (R-2): a child must arrive on a branch
    // it can commit to. The branch starts at the current HEAD, which is the
    // baseline the orchestration is working from.
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", branch, path], {
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

/**
 * Write a task document OUTSIDE the repository (F7).
 *
 * Same root as the orchestration worktrees, for the same reason: anything the
 * gate creates inside the worktree ends up in the first child's `git add -A`
 * checkpoint. The name is sanitized to a single path segment, so a caller (or
 * a corrupted registry) can never write outside this directory.
 */
export function writeScratchFile(
  repoRoot: string,
  name: string,
  content: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 120);
  if (!safe) return { ok: false, error: "文件名非法" };
  try {
    const dir = join(worktreeRootFor(repoRoot), TASK_FILE_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, safe);
    writeFileAtomic(path, content);
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Read a CHILD's own gate sidecar (F3 channel 2 / F10).
 *
 * Deliberately raw: this returns the parsed JSON, not a `GateState`, because
 * the orchestrator only ever displays a handful of fields and validating a
 * foreign session's file against the full schema would throw away a
 * half-written one that is still perfectly readable for that purpose.
 */
export function readChildGateState(
  childCwd: string,
  variant?: string,
): Record<string, unknown> | undefined {
  try {
    const path = sidecarPath(childCwd, ".pi", variant);
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}


/**
 * Is a JUDGE process in flight inside `childCwd`?
 *
 * The structured answer to the trap R-23 documents: a child blocked in
 * `judge_wait` for 550s has a frozen screen and a frozen token counter, and
 * calling that "idle" would interrupt a healthy review round. A judge run
 * writes `runs/<stamp>/exit-code` when it finishes, so a run directory
 * WITHOUT one — and recent enough to be believable — means a judge is still
 * working.
 *
 * Best-effort by construction: any IO failure answers `false`, because the
 * fallback (screen signals) is still there and a wrong `true` would make a
 * genuinely stopped child look busy forever.
 */
export const JUDGE_RUN_FRESH_MS = 60 * 60_000;

export function childJudgeRunning(
  childCwd: string,
  now: number = Date.now(),
  freshMs: number = JUDGE_RUN_FRESH_MS,
): boolean {
  try {
    const root = join(childCwd, ".pi", "judge-sessions");
    if (!existsSync(root)) return false;
    for (const session of readdirSync(root, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const runs = join(root, session.name, "runs");
      if (!existsSync(runs)) continue;
      for (const run of readdirSync(runs, { withFileTypes: true })) {
        if (!run.isDirectory()) continue;
        const dir = join(runs, run.name);
        if (existsSync(join(dir, "exit-code"))) continue;
        // No exit code: either in flight, or a crashed run from last week.
        const startedAt = statSync(dir).mtimeMs;
        if (now - startedAt <= freshMs) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// R-28 — the shared `.git/hooks` directory
// ---------------------------------------------------------------------------

/** The hooks the gate installs, and therefore the ones it may repair. */
const GATE_HOOKS: readonly string[] = Object.freeze(["pre-commit", "pre-push", "commit-msg"]);

/** Where THIS repository's hooks live (shared by every linked worktree). */
export function hooksDirFor(repoRoot: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const commonDir = String(out ?? "").trim();
    return commonDir ? join(commonDir, "hooks") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which installed hooks currently EXEC something inside `path`.
 *
 * This is the check that turns R-28 from an incident into a refusal: every
 * child that ran `install-git-hooks.sh` from inside its own orchestration
 * worktree left the repository's shared hooks pointing at a temp directory,
 * and deleting that directory broke committing for every session in the repo.
 */
export function gitHooksReferencing(repoRoot: string, path: string): string[] {
  const dir = hooksDirFor(repoRoot);
  if (!dir || !path) return [];
  const needle = resolve(path);
  const hits: string[] = [];
  for (const hook of GATE_HOOKS) {
    try {
      const file = join(dir, hook);
      if (!existsSync(file)) continue;
      const body = readFileSync(file, "utf8");
      if (body.includes(needle)) hits.push(hook);
    } catch { /* an unreadable hook is not evidence of a reference */ }
  }
  return hits;
}

/**
 * Re-point the repository's hooks at the MAIN worktree's copy.
 *
 * Runs the package's own installer from `repoRoot`, which is the main
 * checkout: `scripts/install-git-hooks.sh` resolves the hook sources relative
 * to itself, so the hooks end up pointing at a stable path rather than at
 * whatever worktree happened to install them last.
 */
export function repairGitHooks(repoRoot: string): { ok: true } | { ok: false; error: string } {
  const script = join(repoRoot, "scripts", "install-git-hooks.sh");
  if (!existsSync(script)) {
    return { ok: false, error: `找不到钩子安装脚本：${script}` };
  }
  try {
    execFileSync("bash", [script], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    return { ok: false, error: String(err.stderr ?? err.message ?? "install-git-hooks.sh failed") };
  }
}


/**
 * The branch a checkout is standing on; undefined when detached or unreadable.
 *
 * Used at spawn time to tell a child where its work has to LAND (R3-6): the
 * supervisor's own branch is the orchestration's base, and a child in a
 * gate-created worktree cannot derive that from anything it can see.
 */
export function currentBranchOf(repoRoot: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out && out !== "HEAD" ? out : undefined;
  } catch {
    return undefined;
  }
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
  confirm(title: string, message: string, pointer?: string): Promise<boolean>;
  /** Print text into the user's transcript (the plan's full text, O-1). */
  showToUser(title: string, text: string): void;
  branchFacts(): BranchFacts;
  sessionTranscriptPath(): string | undefined;
  /** This orchestrator's OWN context usage, as a percentage (receipt block 4). */
  contextPercent?(): number | undefined;
  /** Override the channel root. Tests point it at a scratch dir. */
  channelHome?(): string | undefined;

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
  // ONE channel IO and ONE supervision memory per orchestration. The memory
  // is what the event rules compare against, and it has to OUTLIVE a single
  // `orchestrator_wait`: rebuilt per call it would see every state as freshly
  // changed and would re-ring the same unanswered question on every poll.
  const io = nodeChannelIO();
  let memory: SupervisionMemory = {};

  const deps: OrchestratorDeps = {
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
    showToUser: host.showToUser,
    writeScratchFile: (name, content) => writeScratchFile(host.repoRoot, name, content),
    childGateState: (childCwd, variant) => readChildGateState(childCwd, variant),
    sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),

    addWorktree: (name) => addWorktree(host.repoRoot, name),
    removeWorktree: (path) => removeWorktree(host.repoRoot, path),
    childJudgeRunning: (childCwd) => childJudgeRunning(childCwd, host.now ? host.now() : Date.now()),
    gitHooksReferencing: (path) => gitHooksReferencing(host.repoRoot, path),
    currentBranch: () => currentBranchOf(host.repoRoot),
    repairGitHooks: () => repairGitHooks(host.repoRoot),
    channelIO: () => io,
    channelHome: () => host.channelHome?.(),
    supervisionMemory: () => memory,
    saveSupervisionMemory: (next) => { memory = next; },
    contextPercent: () => host.contextPercent?.(),

    branchFacts: host.branchFacts,
    emitNotification: (sequence) => emitNotification(sequence, env()),
    fileChars: (relPath) => fileCharsIn(host.repoRoot, relPath),
    sessionTranscriptPath: host.sessionTranscriptPath,
  };
  return deps;
}

