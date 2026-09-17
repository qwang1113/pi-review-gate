/**
 * THE NOTIFICATION RUNTIME — everything about raising a banner that needs a
 * process: where the notifier is, what this session's tmux address is, the
 * spawn, and the exit handler that has to survive the process dying.
 *
 * WHY IT IS NOT IN THE EXTENSION (quality round P2, 2026-09-17).
 * `extensions/review-gate.ts` is the ~9000-line file AGENTS.md has a rule
 * about. Adding a fourth responsibility to it — after the chat, the gate and
 * the orchestration wiring — is exactly the accumulation that rule exists to
 * stop, and "it is only 60 lines" is how the other 3000 got there. The POLICY
 * was already out (lib/user-notify.ts); this half was not.
 *
 * WHAT STAYS IN THE EXTENSION: the wiring. It hands over the session's state,
 * the tmux runner, the environment and a persist callback, and calls three
 * methods. It owns no decision.
 *
 * THE ONE ASYMMETRY: `notifyOnExit` spawns SYNCHRONOUSLY. An `exit` handler
 * cannot await, and a detached child that has only been forked may be killed
 * with its parent before it ever draws the banner — so the exit path blocks on
 * a ~50ms `terminal-notifier` call. That is the only blocking spawn in the
 * gate, and it is why the runner is injectable: a test must never send a real
 * notification, and the extension must never accidentally adopt a second one.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";

import type { GateState } from "./gate-state.ts";
import { STATE_VARIANT_ENV } from "./gate-state.ts";
import type { TaskMode } from "./task-mode.ts";
import {
  MISSING_NOTIFIER_HINT,
  NOTIFIER_BINARY,
  emptyNotifyHistory,
  exitNotifyKind,
  mayNotifyUser,
  planUserNotify,
  recordNotify,
  type UserNotifyKind,
  type UserNotifyOutcome,
} from "./user-notify.ts";

/** One tmux call, already resolved to argv (never a shell string). */
export interface NotifyTmuxRunner {
  (argv: readonly string[]): { ok: boolean; stdout: string };
}

export interface UserNotifyRuntimeDeps {
  /** The session's gate state — the banner throttle is persisted on it. */
  state(): GateState;
  /**
   * Write the sidecar after the throttle moved. Called once per banner, so the
   * extension passes the same persist its other writers use.
   */
  persist(): void;
  /** The directory name that tells three running sessions apart. */
  repoName(): string;
  /** THE mode gate: a judge pane or a child session may never send. */
  taskMode(): TaskMode | undefined;
  env(): NodeJS.ProcessEnv;
  /** False in tests, CI and headless hosts — nothing may reach a screen. */
  interactive(): boolean;
  /** This session's tmux pane, or undefined outside tmux. */
  runTmux: NotifyTmuxRunner;
  now?(): number;
  /** Injected so a test can count spawns instead of making them. */
  spawnDetached?(argv: readonly string[]): void;
  /** Injected so a test can count the blocking one. */
  spawnBlocking?(argv: readonly string[]): void;
  /** Injected so a test can decide where (or whether) the binary is. */
  resolveNotifier?(): string | undefined;
}

export interface UserNotifyRuntime {
  /** Raise the banner for one event. Never throws. */
  notify(opts: { kind: UserNotifyKind; detail: string; blocking?: boolean }): UserNotifyOutcome;
  /**
   * KIND TWO of three: register the process-exit handler.
   *
   * It reads the clean-shutdown flag recorded by `markCleanShutdown`, so the
   * caller only has to call that from its `session_shutdown` handler — the
   * rule itself (quit/reload/new/resume/fork say nothing; anything else is a
   * crash) lives in lib/user-notify.ts `exitNotifyKind`.
   */
  armExitHandler(): void;
  /** The user ended or restarted this session on purpose. */
  markCleanShutdown(): void;
  /** Absolute path of the notifier, or undefined when it is not installed. */
  notifierPath(): string | undefined;
  /** What to say once at session start when it is missing, or "" when fine. */
  startHint(): string;
}

export function createUserNotifyRuntime(deps: UserNotifyRuntimeDeps): UserNotifyRuntime {
  const now = () => (deps.now ? deps.now() : Date.now());
  const env = () => deps.env();

  /**
   * Where `terminal-notifier` is, resolved ONCE.
   *
   * Resolved rather than left as a bare name because a banner is often raised
   * from the exit handler, where there is no second chance to look anything
   * up: argv that already carries an absolute path cannot fail on a PATH the
   * process no longer has. `undefined` is a real answer — the user has not
   * installed it — and every caller is told so instead of assuming success.
   */
  let resolved: string | undefined | null = null;
  function notifierPath(): string | undefined {
    if (resolved === null) {
      if (deps.resolveNotifier) {
        resolved = deps.resolveNotifier();
      } else {
        try {
          const found = execFileSync("/usr/bin/which", [NOTIFIER_BINARY], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          resolved = found || undefined;
        } catch {
          resolved = undefined;
        }
      }
    }
    return resolved ?? undefined;
  }

  /**
   * This session's own tmux address, as the click needs it.
   *
   * Two calls' worth of information from one place: the window id is what lets
   * a click MOVE THE CLIENT to the right window; the pane id picks the pane
   * inside it. Looked up lazily — the caller passes this as a thunk to the
   * policy, so a session that will never send never pays for it.
   */
  function ownTmuxAddress(): { paneId: string; windowId?: string } | undefined {
    const paneId = (env().TMUX_PANE ?? "").trim();
    if (!/^%\d+$/.test(paneId)) return undefined;
    try {
      const out = deps.runTmux(["display-message", "-p", "-t", paneId, "#{window_id}"]);
      const windowId = out.ok ? out.stdout.trim() : "";
      return { paneId, ...(/^@\d+$/.test(windowId) ? { windowId } : {}) };
    } catch {
      return { paneId };
    }
  }

  function spawnDetached(argv: readonly string[]): void {
    if (deps.spawnDetached) {
      deps.spawnDetached(argv);
      return;
    }
    const [bin, ...args] = argv;
    const child = spawn(bin!, args, { detached: true, stdio: "ignore" });
    child.unref();
  }

  function spawnBlocking(argv: readonly string[]): void {
    if (deps.spawnBlocking) {
      deps.spawnBlocking(argv);
      return;
    }
    const [bin, ...args] = argv;
    spawnSync(bin!, args, { stdio: "ignore", timeout: 10_000 });
  }

  let cleanShutdown = false;

  function notify(opts: {
    kind: UserNotifyKind;
    detail: string;
    blocking?: boolean;
  }): UserNotifyOutcome {
    try {
      const state = deps.state();
      const at = now();
      const history = state.notify ?? emptyNotifyHistory();
      const plan = planUserNotify({
        kind: opts.kind,
        repoName: deps.repoName(),
        detail: opts.detail,
        taskMode: deps.taskMode(),
        stateVariant: env()[STATE_VARIANT_ENV],
        // A THUNK: eligibility and the throttle must be decided BEFORE a
        // synchronous tmux call is paid (quality round P2).
        tmux: () => ownTmuxAddress(),
        notifierPath: notifierPath(),
        history,
        now: at,
        interactive: deps.interactive(),
      });
      if (plan.status !== "send") {
        return plan.status === "missing"
          ? { status: "missing", note: plan.hint }
          : { status: plan.status, note: plan.reason };
      }
      if (opts.blocking) spawnBlocking(plan.argv);
      else spawnDetached(plan.argv);
      deps.state().notify = recordNotify(history, plan.key, at);
      deps.persist();
      return { status: "sent" };
    } catch (error) {
      return { status: "skipped", note: `发通知时出错：${(error as Error).message}` };
    }
  }

  return {
    notify,
    markCleanShutdown: () => {
      cleanShutdown = true;
    },
    armExitHandler: () => {
      /**
       * KIND TWO of three: the session ended WITHOUT a clean shutdown.
       *
       * A `/quit`, a reload, a resume or a fork all call `markCleanShutdown`
       * first — the user did that on purpose and already knows. What is left
       * is the crash, and it is the one banner nobody else can raise because
       * the session that would have sent it is gone.
       *
       * The eligibility check comes BEFORE anything is resolved or spawned:
       * this handler runs on every process exit, including judge panes and
       * child sessions. A SIGKILL runs no handler at all — an honest limit,
       * and the same case as the user's own `kill`, which needs no telling.
       */
      process.on("exit", () => {
        const kind = exitNotifyKind({ cleanShutdown });
        if (!kind) return;
        const state = deps.state();
        if (!mayNotifyUser({ taskMode: deps.taskMode(), stateVariant: env()[STATE_VARIANT_ENV] })) return;
        notify({
          kind,
          detail: "会话没有 declare_done 就退出了（进程异常终止，不是你自己结束的）。",
          blocking: true,
        });
      });
    },
    notifierPath,
    startHint: () => (notifierPath() ? "" : MISSING_NOTIFIER_HINT),
  };
}
