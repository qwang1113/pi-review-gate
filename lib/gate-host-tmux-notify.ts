/**
 * THE TMUX HOST'S BANNER — `terminal-notifier`, with a click that lands back in
 * this tmux pane (lib/gate-host.ts `HostNotifier`).
 *
 * The POLICY (who may send, what it says, the throttle) is lib/user-notify.ts
 * and the RUNTIME (history, the exit handler) is lib/user-notify-runtime.ts;
 * both are host-neutral. What lives here is what only a terminal host has to
 * do: find the binary, read this pane's tmux address, ask tmux which pane each
 * client shows, ask macOS which app is in front, and spawn.
 *
 * THE ONE ASYMMETRY: a `blocking` send spawns SYNCHRONOUSLY. It is the exit
 * handler's banner — an `exit` handler cannot await, and a detached child that
 * has only been forked may be killed with its parent before it ever draws the
 * banner — so that path blocks on a ~50ms `terminal-notifier` call. Every
 * spawn is injectable: a test must never send a real notification.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";

// The pane-id shape has ONE implementation (quality round P2, 2026-09-18):
// lib/orchestrator-tmux.ts's canonical predicate, not a fourth local regex.
import { isPaneId, type TmuxRunner } from "./orchestrator-tmux.ts";
import { NOTIFIER_BINARY, isWatchingPane } from "./user-notify.ts";
import type { HostNotifier } from "./gate-host.ts";

/** Where a click should land: pane, its window, and the server's socket. */
type TmuxAddress = { paneId: string; windowId?: string; socket?: string };

/**
 * How long a synchronous `lsappinfo` call may take.
 *
 * The CLI answers in ~10ms on this machine; the bound exists so a wedged
 * CoreApplicationServices cannot hang the dialog that is opening — or the
 * process exit handler that is closing, where a stuck child would hold the
 * exiting session open forever (quality round P2, 2026-09-18).
 */
const LSAPPINFO_TIMEOUT_MS = 2_000;

export interface TmuxNotifierDeps {
  run: TmuxRunner;
  env(): NodeJS.ProcessEnv;
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

export function createTmuxNotifier(deps: TmuxNotifierDeps): HostNotifier {
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
   * inside it. Looked up per banner — the WINDOW id is not fixed for the
   * process (join-pane / break-pane / move-pane move this pane elsewhere).
   */
  function ownTmuxAddress(): TmuxAddress | undefined {
    const paneId = (env().TMUX_PANE ?? "").trim();
    if (!isPaneId(paneId)) return undefined;
    // `$TMUX` = `<socket>,<server pid>,<session>` — the click must reach THIS server (D42).
    const socket = (env().TMUX ?? "").split(",")[0] || undefined;
    const base = { paneId, ...(socket ? { socket } : {}) };
    try {
      const out = deps.run(["display-message", "-p", "-t", paneId, "#{window_id}"]);
      const windowId = out.ok ? out.stdout.trim() : "";
      return { ...base, ...(/^@\d+$/.test(windowId) ? { windowId } : {}) };
    } catch {
      return base;
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
      const clients = deps.run(["list-clients", "-F", "#{client_name}"]);
      if (!clients.ok) return [];
      const panes: string[] = [];
      for (const client of clients.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
        const shown = deps.run(["display-message", "-c", client, "-p", "#{pane_id}"]);
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
   * BOTH KINDS OF FAILURE ARE "CANNOT READ": the injected one as well as the
   * real CLI (reviewer P1, 2026-09-18). A throwing reader must never turn into
   * a banner SUPPRESSED by an error in the evidence-gathering.
   */
  function frontBundleId(): string | undefined {
    try {
      if (deps.frontBundleId) return deps.frontBundleId();
      // TIMED LIKE EVERY OTHER EXTERNAL CALL IN THIS REPO (quality round P2,
      // 2026-09-18): this runs synchronously on the dialog path AND inside the
      // process exit handler, where an unbounded child would hang either.
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

  function spawnDetached(argv: readonly string[]): void {
    if (deps.spawnDetached) {
      deps.spawnDetached(argv);
      return;
    }
    const [bin, ...args] = argv;
    const child = spawn(bin!, args, { detached: true, stdio: "ignore" });
    // A DETACHED SPAWN THAT CANNOT START REPORTS IT ASYNCHRONOUSLY (reviewer
    // P2, 2026-09-17): an unhandled `error` event on a ChildProcess takes the
    // EXTENSION HOST down, and there is nothing to do with it either way — a
    // banner that cannot be delivered is the `missing` case the start hint
    // already covers.
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

  return {
    path: notifierPath,
    address: ownTmuxAddress,
    /**
     * IS THE USER LOOKING AT THIS SESSION'S PANE RIGHT NOW?
     *
     * FAIL OPEN ALL THE WAY OUT (reviewer P1, 2026-09-18): every reading is
     * host trivia, and ANY failure must leave the banner ON — a suppressed
     * notification is a user who is never told.
     */
    watching: (address, sessionBundle) => {
      try {
        return isWatchingPane({
          paneId: address?.paneId,
          activePanes: activeClientPanes(),
          frontBundleId: frontBundleId(),
          sessionBundleId: sessionBundle,
        });
      } catch {
        return false;
      }
    },
    send: (banner, blocking) => {
      if (blocking) spawnBlocking(banner.argv);
      else spawnDetached(banner.argv);
      return { ok: true };
    },
  };
}
