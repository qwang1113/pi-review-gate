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
// The pane-id shape has ONE implementation (quality round P2, 2026-09-18):
// lib/orchestrator-tmux.ts's canonical predicate, not a fourth local regex.
import { isPaneId } from "./orchestrator-tmux.ts";
import type { TaskMode } from "./task-mode.ts";
import {
  MISSING_NOTIFIER_HINT,
  NOTIFIER_BINARY,
  defaultActivateBundle,
  emptyNotifyHistory,
  exitNotifyKind,
  isWatchingPane,
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

/**
 * How long a synchronous `lsappinfo` call may take.
 *
 * The CLI answers in ~10ms on this machine; the bound exists so a wedged
 * CoreApplicationServices cannot hang the dialog that is opening — or the
 * process exit handler that is closing, where a stuck child would hold the
 * exiting session open forever (quality round P2, 2026-09-18).
 */
const LSAPPINFO_TIMEOUT_MS = 2_000;

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
  /**
   * Injected so a test never shells out to `lsappinfo` (and so the
   * "cannot be read" branch is reachable). Defaults to the real CLI.
   */
  frontBundleId?(): string | undefined;
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
    if (!isPaneId(paneId)) return undefined;
    try {
      const out = deps.runTmux(["display-message", "-p", "-t", paneId, "#{window_id}"]);
      const windowId = out.ok ? out.stdout.trim() : "";
      return { paneId, ...(/^@\d+$/.test(windowId) ? { windowId } : {}) };
    } catch {
      return { paneId };
    }
  }

  /**
   * What each attached tmux client is showing RIGHT NOW.
   *
   * `display-message -c <client>` is the one way to ask that question: tmux's
   * format language exposes no `client_active_pane`, so the client itself has
   * to be the context of the query. One call per client, and a client tmux
   * refuses to describe contributes nothing rather than aborting the sweep.
   *
   * `[]` is the honest answer when tmux cannot be asked at all — the caller
   * treats it as "nobody is looking", which is the fail-open direction
   * lib/user-notify.ts's `isWatchingPane` documents.
   */
  function activeClientPanes(): string[] {
    try {
      const clients = deps.runTmux(["list-clients", "-F", "#{client_name}"]);
      if (!clients.ok) return [];
      const panes: string[] = [];
      for (const client of clients.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
        const shown = deps.runTmux(["display-message", "-c", client, "-p", "#{pane_id}"]);
        const pane = shown.ok ? shown.stdout.trim() : "";
        if (pane) panes.push(pane);
      }
      return panes;
    } catch {
      return [];
    }
  }

  /**
   * Bundle id of the FRONTMOST macOS app, or `undefined` when it cannot be
   * read (a non-macOS host, `lsappinfo` gone, an output the parse does not
   * recognize).
   *
   * `lsappinfo` is macOS's own CoreApplicationServices CLI and needs no
   * permission grants — measured on this machine: 9ms for `front` and 11ms for
   * the lookup, paid only when a banner is otherwise about to go out.
   */
  /**
   * BOTH KINDS OF FAILURE ARE "CANNOT READ": the injected one as well as the
   * real CLI (reviewer P1, 2026-09-18). Leaving the injected call outside the
   * try let a throwing stub — or a future reader — escape into `notify()`'s
   * catch-all and turn into `skipped`, i.e. a banner SUPPRESSED by an error in
   * the evidence-gathering. That is the one direction this must never fail in.
   */
  function frontBundleId(): string | undefined {
    try {
      if (deps.frontBundleId) return deps.frontBundleId();
      // TIMED LIKE EVERY OTHER EXTERNAL CALL IN THIS REPO (quality round P2,
      // 2026-09-18): this runs synchronously on the dialog path (askChoice ->
      // raiseBanner) AND inside the process exit handler, where an unbounded
      // child would hang the box that is opening or the exit that is closing.
      const front = execFileSync("/usr/bin/lsappinfo", ["front"], {
        encoding: "utf8",
        timeout: LSAPPINFO_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!front) return undefined;
      const info = execFileSync("/usr/bin/lsappinfo", ["info", "-only", "bundleid", front], {
        encoding: "utf8",
        timeout: LSAPPINFO_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return /bundleid="([^"]+)"/i.exec(info)?.[1];
    } catch {
      return undefined;
    }
  }

  /**
   * IS THE USER LOOKING AT THIS SESSION'S PANE RIGHT NOW?
   *
   * FAIL OPEN ALL THE WAY OUT (reviewer P1, 2026-09-18). Every reading below is
   * host trivia — tmux calls, an `lsappinfo` call — and ANY failure in any of
   * them must leave the banner ON: a suppressed notification is a user who is
   * never told, which is strictly worse than one they did not need. The pure
   * predicate answers `false` for every unknown (lib/user-notify.ts); this
   * wrapper makes sure a THROW lands there too instead of escaping into
   * `notify()`'s catch-all — that path is for the notifier failing, not for the
   * evidence about where the user is looking.
   */
  function userIsWatching(paneId: string | undefined, sessionBundleId: string | undefined): boolean {
    try {
      return isWatchingPane({
        paneId,
        activePanes: activeClientPanes(),
        frontBundleId: frontBundleId(),
        sessionBundleId,
      });
    } catch {
      return false;
    }
  }

  function spawnDetached(argv: readonly string[]): void {
    if (deps.spawnDetached) {
      deps.spawnDetached(argv);
      return;
    }
    const [bin, ...args] = argv;
    const child = spawn(bin!, args, { detached: true, stdio: "ignore" });
    // A DETACHED SPAWN THAT CANNOT START REPORTS IT ASYNCHRONOUSLY (reviewer
    // P2, 2026-09-17): `spawn` returns a ChildProcess and emits `error` later,
    // so `notify()`'s try/catch cannot see a binary that vanished or an EACCES
    // — and an unhandled `error` event on a ChildProcess takes the EXTENSION
    // HOST down. There is nothing to do with it either way: a banner that
    // cannot be delivered is the `missing` case the start hint already covers.
    child.on("error", () => {});
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
      const sessionBundle = defaultActivateBundle(env());
      // ONE LOOK PER BANNER — NOT per process (quality round P2, 2026-09-18):
      // the PANE id is fixed for the process, the WINDOW id is not (join-pane /
      // break-pane / move-pane move this pane elsewhere), so a process-lifetime
      // cache would make every later click jump to a window this pane has left.
      // Within one banner the address cannot change, so the two readers share it.
      let addressResolved = false;
      let address: { paneId: string; windowId?: string } | undefined;
      const ownAddress = (): { paneId: string; windowId?: string } | undefined => {
        if (!addressResolved) {
          addressResolved = true;
          address = ownTmuxAddress();
        }
        return address;
      };
      const plan = planUserNotify({
        kind: opts.kind,
        repoName: deps.repoName(),
        detail: opts.detail,
        taskMode: deps.taskMode(),
        stateVariant: env()[STATE_VARIANT_ENV],
        // A THUNK: eligibility and the throttle must be decided BEFORE a
        // synchronous tmux call is paid (quality round P2).
        tmux: () => ownAddress(),
        // ALSO A THUNK, and lazily resolved for the same reason: this one costs
        // a client sweep plus two `lsappinfo` calls, and a session that can
        // never send (a child, a judge pane) must not pay for it either.
        watching: () => userIsWatching(ownAddress()?.paneId, sessionBundle),
        // ONE BANNER PER SESSION: the notifier REMOVES an older banner with the
        // same group, so a four-question interview leaves one banner in
        // Notification Center instead of four (user report, 2026-09-18).
        group: state.sessionId ?? undefined,
        notifierPath: notifierPath(),
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
    notifierPath,
    startHint: () => (notifierPath() ? "" : MISSING_NOTIFIER_HINT),
  };
}
