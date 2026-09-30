/**
 * THE NOTIFICATION RUNTIME — everything about raising a banner that needs a
 * process: the throttle history, the host's delivery, and the exit handler that
 * has to survive the process dying.
 *
 * HOST-NEUTRAL (2026-09-30, t3-host-factory): where the notifier is, where this
 * session lives, whether the user is looking and how the banner is delivered
 * are the HOST's answers (lib/gate-host.ts `HostNotifier` — `terminal-notifier`
 * under tmux in lib/gate-host-tmux-notify.ts, the client's `notify` under the
 * desktop host). This module sequences them around the policy.
 *
 * WHY IT IS NOT IN THE EXTENSION (quality round P2, 2026-09-17).
 * `extensions/review-gate.ts` is the file AGENTS.md has a rule about; the
 * POLICY was already out (lib/user-notify.ts) and this half followed it. The
 * extension hands over the session's state, the host's notifier, the
 * environment and a persist callback, and calls three methods.
 *
 * THE ONE ASYMMETRY: the exit handler's banner is sent `blocking` — an `exit`
 * handler cannot await, so the host must finish delivering before it returns.
 */

import type { GateState } from "./gate-state.ts";
import { STATE_VARIANT_ENV } from "./gate-state-io.ts";
import type { HostNotifier } from "./gate-host.ts";
import type { TaskMode } from "./task-mode.ts";
import {
  MISSING_NOTIFIER_HINT,
  defaultActivateBundle,
  emptyNotifyHistory,
  exitNotifyKind,
  mayNotifyUser,
  planUserNotify,
  recordNotify,
  type UserNotifyKind,
  type UserNotifyOutcome,
} from "./user-notify.ts";

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
  /** The host's banner (lib/gate-host.ts). */
  notifier: HostNotifier;
  now?(): number;
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

type Address = ReturnType<HostNotifier["address"]>;

export function createUserNotifyRuntime(deps: UserNotifyRuntimeDeps): UserNotifyRuntime {
  const now = () => (deps.now ? deps.now() : Date.now());
  const env = () => deps.env();
  const { notifier } = deps;

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
      const sessionBundle = defaultActivateBundle(env());
      // ONE LOOK PER BANNER — NOT per process (quality round P2, 2026-09-18):
      // the PANE id is fixed for the process, the WINDOW id is not (join-pane /
      // break-pane / move-pane move this pane elsewhere), so a process-lifetime
      // cache would make every later click jump to a window this pane has left.
      // Within one banner the address cannot change, so the two readers share it.
      let addressResolved = false;
      let address: Address;
      const ownAddress = (): Address => {
        if (!addressResolved) {
          addressResolved = true;
          address = notifier.address();
        }
        return address;
      };
      const group = state.sessionId ?? undefined;
      const plan = planUserNotify({
        kind: opts.kind,
        repoName: deps.repoName(),
        detail: opts.detail,
        taskMode: deps.taskMode(),
        stateVariant: env()[STATE_VARIANT_ENV],
        // A THUNK: eligibility and the throttle must be decided BEFORE a
        // synchronous host call is paid (quality round P2).
        tmux: () => ownAddress(),
        // ALSO A THUNK, and lazily resolved for the same reason: a session that
        // can never send (a child, a judge pane) must not pay for it either.
        watching: () => notifier.watching(ownAddress(), sessionBundle),
        // ONE BANNER PER SESSION: the notifier REMOVES an older banner with the
        // same group, so a four-question interview leaves one banner in
        // Notification Center instead of four (user report, 2026-09-18).
        group,
        notifierPath: notifier.path(),
        // WHERE A CLICK LANDS (reviewer Nit, carried two rounds): resolved
        // HERE with the other host facts and passed in, so `planUserNotify`
        // stays pure. An unknown app ⇒ no `-activate` at all, never a guess.
        activateBundle: sessionBundle,
        history,
        now: at,
        interactive: deps.interactive(),
      });
      if (plan.status !== "send") {
        return plan.status === "missing"
          ? { status: "missing", note: plan.hint }
          : { status: plan.status, note: plan.reason };
      }
      const sent = notifier.send({ kind: opts.kind, title: plan.title, body: plan.body, group, argv: plan.argv }, opts.blocking === true);
      // "I could not tell you" is reported as such, never as delivery.
      if (!sent.ok) return { status: "missing", note: sent.error };
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
        if (!mayNotifyUser({ taskMode: deps.taskMode(), stateVariant: env()[STATE_VARIANT_ENV] })) return;
        notify({
          kind,
          // THE BANNER SAYS WHAT THE JUDGE ACTUALLY KNOWS (reviewer P2,
          // 2026-09-17): `exitNotifyKind` decides from `cleanShutdown` alone —
          // "did this process record a session_shutdown" — so a session that
          // DID declare_done and then died on a signal lands here too, and
          // claiming it never declared done would tell the user the opposite
          // of what happened. The SIGKILL limit (no handler runs at all) is
          // named for the same reason: the sentence has to stay true for
          // every exit that can reach this line.
          detail: "会话异常结束：进程没有走正常关闭流程就退出了——如果是你手动 kill 的，忽略这条。",
          blocking: true,
        });
      });
    },
    notifierPath: () => notifier.path(),
    startHint: () => (notifier.path() ? "" : MISSING_NOTIFIER_HINT),
  };
}
