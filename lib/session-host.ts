/**
 * THE SEAM between `extensions/review-gate.ts` and the modules carved out of
 * its closure (t5, wave 1 of the split).
 *
 * The extension's closure holds REASSIGNED bindings — `state` is replaced on
 * every session start, `primaryRepoRoot` / `cwd` / `sessionInGit` move with
 * the session, `latestCtx` follows every hook. A module that captured any of
 * them by value would be reading a stale copy the moment the session moved,
 * so the seam is made of ACCESSORS (read on every call), never values — the
 * same rule `deps.state()` follows in lib/gate-command-tools.ts and
 * `createOrchestratorDeps` in lib/orchestrator-wiring.ts.
 *
 * A mutable binding a module must WRITE (the last UI context, the last user
 * interaction stamp) travels as a `Ref` handle — the shape the extension's
 * `activeRepoRoot = { current }` already uses — so both sides read and write
 * one cell.
 *
 * Types only: this module contains no behavior at all.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GateState } from "./gate-state.ts";

/** One mutable cell shared by the extension and a carved-out module. */
export interface Ref<T> {
  current: T;
}

/** Where this session works, read fresh on every call. */
export interface SessionRepos {
  /** The session repo (cwd's git root, or cwd outside git). */
  primary: string;
  /** The repo the agent most recently edited. */
  active: string;
  /** Every repo this session has edited (the primary included). */
  all: ReadonlySet<string>;
  /** The session cwd (may be a subdirectory of `primary`). */
  cwd: string;
  /** Does the session cwd sit inside a git repository? */
  inGit: boolean;
}

/** What every carved-out module may ask of the session. */
export interface SessionHost {
  /** The primary repo's gate state — the CURRENT object, never a snapshot. */
  state(): GateState;
  /** The gate state of any repo this session touches (primary included). */
  stateFor(root: string): GateState;
  /** Persist the primary repo's state (session entry + widget + sidecar). */
  persist(ctx?: ExtensionContext): void;
  /** Persist one repo's state to its own sidecar. */
  persistRepo(ctx: ExtensionContext, root: string): void;
  repos(): SessionRepos;
  /** The most recent live extension context, when there is one. */
  ctx(): ExtensionContext | undefined;
  /** One line into the repo root's gate-owned audit log. */
  log(text: string): void;
}
