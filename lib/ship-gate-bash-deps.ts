/**
 * The shapes the L1 bash arm (lib/ship-gate-bash.ts) is wired with: the
 * injected dependency surface and the blocked-ship record
 * `request_arbitration` contests. Split out so the arm itself stays readable;
 * the extension supplies them through lib/ship-gate-hook.ts's `ShipGateHookDeps`.
 */

import type { GateState } from "./gate-state.ts";
import type { DeliveryStation } from "./delivery-station.ts";
import type { ArbitrableAction, BypassToken, TokenBindings } from "./arbitration.ts";
import type { LlmClassifier } from "./llm-classify.ts";
import type { SlowNoticeSink } from "./progress-stream.ts";
import type { ProjectConfig } from "./project-config.ts";
import type { TaskMode } from "./task-mode.ts";
import type { AppealKind } from "./text-appeal.ts";

/** The record `request_arbitration` contests — a REAL block, never a guess. */
export interface BlockedShipRecord {
  command: string;
  problems: string[];
  blockReason: string;
  at: number;
  /**
   * Was any part of this block a DELIVERY STATION refusal?
   *
   * The arbiter rules on whether a QUALITY block is circular; it was never
   * asked how far a round may travel, and no token it could issue would be
   * consulted here (the station check runs above the token path). Without
   * this flag `request_arbitration` would accept the appeal, spend one of the
   * session's three, possibly rule AGENT_WINS — and the command would stay
   * blocked with no explanation (round-1 reviewer P2, 2026-09-06).
   */
  stationBlocked?: boolean;

}

/**
 * Everything the bash arm needs from the outside world.
 *
 * Deliberately narrow and side-effect-explicit: every member is a thing a
 * test replaces with three lines.
 */
export interface ShipGateBashDeps {
  /** The session cwd — a getter (pi hands the real one only at session_start). */
  cwd(): string;
  /** The session's own repo root — a getter, same reason. */
  primaryRepoRoot(): string;
  /**
   * This session's gate mode, read fresh on every command.
   *
   * `undefined` is the UNDECIDED state and is deliberately part of the type:
   * every branch below is an equality test against a named mode, so undecided
   * never takes the `normal` early return.
   */
  taskMode(): TaskMode | undefined;
  /** Is `/gate-bypass` active for the rest of the session? */
  bypassActive(): boolean;
  /** The effective project config (LLM guard switches, doc sync, arbiter). */
  projectConfig(): ProjectConfig;
  /** Every repo this session has touched (the ambiguous-resolution fallback). */
  sessionRepos(): Iterable<string>;
  /** Every repo the session knows about — decides whether to label problems. */
  knownRepoRoots(): string[];
  /** One repo's gate state, or undefined when it has no sidecar. */
  enforcementStateFor(root: string): GateState | undefined;
  /** One repo's state, materializing it (the primary repo's IS the session's). */
  stateForRepo(root: string): GateState;
  /** How a repo is named in a multi-repo problem line. */
  repoLabel(root: string): string;
  /** The branch a repo currently has checked out (rebase-aware). */
  currentBranch(root: string): string | undefined;
  /** The repo's worktree tree oid — half of the message-only-rewrite proof. */
  worktreeTree(root: string): string | undefined;
  /** HEAD's tree oid. */
  headCommitTree(root: string): string;
  /** Whether the index holds a staged change (the other half). */
  hasStagedChanges(root: string): boolean | undefined;
  /** Trees of commits made since the last REVIEWED one. */
  unreviewedTreesSince(root: string, review: GateState["review"]): string[] | undefined;
  /** Has the USER approved this session's loop goal (primary repo)? */
  loopGoalConfirmed(): boolean;
  /**
   * WHERE THIS ROUND STOPS, for one repo — or `undefined` when no delivery
   * contract applies to this session at all.
   *
   * `undefined` is not "precommit". The two are different facts and the gate
   * must not confuse them: a loop session's contract is its approved goal and
   * an orchestration's is its approved plan, but an EXPLORE session has no
   * contract of any kind, and reading its missing station as the strictest one
   * would invent a ship block it never had (the user ruled on exactly this,
   * 2026-09-06: explore and normal keep their current behaviour).
   */
  deliveryStation(root: string): DeliveryStation | undefined;

  /** "your READY is on another repo" — the cross-repo hint for a block. */
  crossRepoVerdictHint(blockedRoots: string[]): string;
  /** The flash classifier the three LLM guards run on. */
  classifier(): LlmClassifier;
  /** The status-bar sink the slow LLM guards report through. */
  notice(ctx: unknown): SlowNoticeSink | undefined;
  /**
   * Record an A-class TEXT block and return its refusal, or `undefined` when a
   * granted appeal pass authorizes this exact content once.
   */
  refuseText(kind: AppealKind, text: string, message: string, ctx: unknown): string | undefined;
  /** Append one line to the gate's lesson log. */
  appendLesson(text: string): void;
  /**
   * Say something to the agent WITHOUT refusing the command.
   *
   * The hook itself can only block or stay silent, so a hint needs its own
   * seam. WHERE IT LANDS MATTERS, and it is the CALLER's result (user
   * decision, 2026-09-14): the extension appends it to the tool result the
   * very call that earned it returns, so the advice sits beside the command it
   * is about. Delivering it as a separate follow-up message was measured
   * wrong — it arrives after the fact, out of context, and reads as an
   * interruption from nowhere. De-duplicated per session; a test replaces this
   * seam with a push into an array.
   */
  hint(message: string): void;

  /**
   * The user's tmux authorization, if any (lib/gate-state.ts `tmuxAccess`).
   *
   * Callbacks rather than values: the grant is minted by a dialog DURING the
   * session, and a captured snapshot would leave the first command after the
   * grant still refused.
   */
  tmuxAccess(): { at: string; scope: "session" | "once" } | undefined;
  /** Spend a one-shot grant. Called only once the command is about to run. */
  consumeTmuxAccess(): void;
  /** The standing single-use arbiter bypass token, if one was issued. */
  bypassToken(): BypassToken | null;
  /** Replace it (used to mark it consumed on attempt). */
  setBypassToken(token: BypassToken | null): void;
  /** Drop it entirely. */
  clearBypassToken(): void;
  /** The current binding material a token is checked against. */
  computeTokenBindings(action: ArbitrableAction, fingerprint: string): Promise<TokenBindings>;
  /** Remember THIS block so `request_arbitration` can only contest a real one. */
  setLastBlockedShip(record: BlockedShipRecord): void;
}
