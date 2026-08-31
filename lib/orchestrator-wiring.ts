/**
 * Where the orchestration layer meets the real machine.
 *
 * Everything the tools need that involves the OUTSIDE WORLD — running tmux,
 * reading and writing the plan file, writing task documents into `.pi/tasks/`,
 * taking attention events off the queue — is implemented once here, so the
 * extension only has to supply what genuinely belongs to it: the gate state,
 * the user dialog and the repo facts.
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
import { writeFileAtomic } from "./atomic-write.ts";
import { sideEffectsEnabled } from "./side-effects.ts";
import { nodeChannelIO } from "./orchestrator-channel.ts";
import type { SupervisionMemory } from "./orchestrator-supervisor.ts";
import { gitRootOfDir } from "./repo-resolve.ts";
import { assertSafeTmuxArgv } from "./orchestrator-tmux.ts";
import { writeNotification } from "./orchestrator-notify.ts";
import { TASK_FILE_DIRNAME } from "./orchestrator-delivery.ts";
import { sidecarPath } from "./gate-state.ts";



import { parsePlan, PLAN_RELPATH, type OrchestratorPlan } from "./orchestrator-plan.ts";
import { emptyRuntime, type OrchestratorRuntime } from "./orchestrator-registry.ts";
import type { OrchestratorDeps, PlanRead, TmuxRunResult } from "./orchestrator-deps.ts";
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
 * Write a task document INSIDE the repo's gate-owned `.pi/` scope (F7).
 *
 * The file lives at `<repo>/.pi/tasks/<name>`, covered by `.gitignore`'s
 * `.pi/` rule and the fingerprint's `:/.pi` exclusion — so a child's
 * `git add -A` checkpoint can never sweep it into history, and the child
 * receives it as the REPO-RELATIVE `@.pi/tasks/<name>` reference instead of
 * an absolute `/var/folders/...` path leaking into its first prompt.
 * The name is sanitized to a single path segment, so a caller (or a
 * corrupted registry) can never write outside this directory.
 */
export function writeTaskFile(
  repoRoot: string,
  name: string,
  content: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 120);
  if (!safe) return { ok: false, error: "文件名非法" };
  try {
    const dir = join(repoRoot, ".pi", TASK_FILE_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, safe);
    writeFileAtomic(path, content);
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
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
  /** A multi-option dialog in the orchestrator's own pane (grant door 3). */
  select?(title: string, options: readonly string[]): Promise<string | undefined>;
  /** Print text into the user's transcript (the plan's full text, O-1). */
  showToUser(title: string, text: string): void;
  sessionTranscriptPath(): string | undefined;
  /** This orchestrator's OWN context usage, as a percentage (receipt block 4). */
  contextPercent?(): number | undefined;
  /** Run + record the plan pre-audit (the extension owns the judge process). */
  auditPlan?(plan: OrchestratorPlan, onUpdate?: { step?: (t: string) => void; done?: (t: string) => void }): Promise<{ ok: true } | { ok: false; text: string }>;

  /** Override the channel root. Tests point it at a scratch dir. */
  channelHome?(): string | undefined;

  now?(): number;
  env?(): NodeJS.ProcessEnv;


  /**
   * Resolve a task's declared `repo` to the repo root the child's pane
   * starts in (2026-09-15). Absent ⇒ the wiring resolves it with git's
   * own `--show-toplevel`, so the child's cwd is the REAL repo root even
   * when the plan names a subdirectory or a symlinked path.
   */
  resolveTaskRepo?(repo: string): { ok: true; root: string } | { ok: false; reason: string };

  /** Every repo this session is accountable for, primary first. */
  knownRepoRoots(): string[];
  knownRepoRoots(): string[];
  /**
   * Fired on every orchestration-tool execution (2026-08-30, symmetric
   * re-arm). The extension re-arms `loopArmed` here.
   */
  onToolCall?(name: string): void;
  /** Fired when THIS session handed its orchestration to a successor. */
  onHandoff?(): void;
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
  // Same ownership rule as the supervision memory: one per orchestration, so
  // the border-repaint throttle cannot leak between orchestrations (or, in a
  // test process, between worlds).
  const paneDecor = new Map<string, { title: string; at: number }>();


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
    select: host.select ?? (() => Promise.resolve(undefined)),
    showToUser: host.showToUser,
    writeTaskFile: (name, content, repoRoot) => writeTaskFile(repoRoot ?? host.repoRoot, name, content),
    childGateState: (childCwd, variant) => readChildGateState(childCwd, variant),
    sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),

    // A task's declared repo may be ANY git checkout — not only one this
    // session has already edited — so the child's cwd is resolved from the
    // path itself (git's --show-toplevel), never from knownRepoRoots
    // membership. A path that is not a repo root is a fail-closed refusal.
    resolveTaskRepo: (repo) => {
      if (host.resolveTaskRepo) return host.resolveTaskRepo(repo);
      const root = gitRootOfDir(repo);
      return root
        ? { ok: true, root }
        : {
            ok: false,
            reason: `声明的 repo "${repo}" 不是 git 仓库根（或目录不存在）—— 无法确定子会话的工作目录`
          };
    },
    knownRepoRoots: host.knownRepoRoots,
    childJudgeRunning: (childCwd) => childJudgeRunning(childCwd, host.now ? host.now() : Date.now()),
    channelIO: () => io,
    channelHome: () => host.channelHome?.(),
    supervisionMemory: () => memory,
    saveSupervisionMemory: (next) => { memory = next; },
    paneDecorMemory: () => paneDecor,

    contextPercent: () => host.contextPercent?.(),
    auditPlan: (plan, onUpdate) =>
      host.auditPlan
        ? host.auditPlan(plan, onUpdate)
        : Promise.resolve({
            ok: false as const,
            text:
              "review-gate: 门禁没有接上 plan 审计通道（宿主未提供 auditPlan）——" +
              "在审计能跑起来之前，plan 不会被送到用户面前。这是门禁自身的缺陷，请报告。",
          }),


    onToolCall: host.onToolCall,
    onHandoff: host.onHandoff,
    emitNotification: (sequence) => emitNotification(sequence, env()),
    fileChars: (relPath) => fileCharsIn(host.repoRoot, relPath),
    sessionTranscriptPath: host.sessionTranscriptPath,
  };
  return deps;
}

