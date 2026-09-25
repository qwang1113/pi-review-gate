/**
 * THE SESSION'S CONTRACT READERS — the loop goal, the five stage switches and
 * the delivery station, as this session reads them for any repo it touches.
 * Moved out of `extensions/review-gate.ts` (t8, 2026-09-26, wave 4 of the split).
 *
 * Every rule is still the pure module's (lib/loop-goal.ts, lib/loop-stages.ts,
 * lib/delivery-station.ts); this host only supplies the session's facts: which
 * repo, which state, which file.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname as pathDirname, join as pathJoin } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChoiceUi } from "./choice-dialog.ts";
import {
  DEFAULT_DELIVERY_STATION,
  parseDeliveryStation,
  type DeliveryStation,
} from "./delivery-station.ts";
import type { GateState } from "./gate-state.ts";
import { sidecarPath, stateVariantFrom } from "./gate-state-io.ts";
import type { createGateDialogs } from "./gate-dialogs.ts";
import {
  isLoopGoalConfirmed,
  loopGoalEditGate,
  loopGoalRelPath,
  loopGoalUnconfirmedEditBlock,
  readLoopGoal,
  type LoopGoal,
} from "./loop-goal.ts";
import { buildGoalStageOffDirective, buildLoopGoalDirective } from "./loop-goal-directives.ts";
import {
  ensureLoopStages,
  stageOpen,
  stagesOffered,
  type LoopStage,
  type LoopStagesDeps,
  type LoopStagesRecord,
} from "./loop-stages.ts";
import { orchestrationIdFromEnv } from "./orchestration-id.ts";
import { STATION_CAP_ENV } from "./repo-pr-policy.ts";
import { gitRootOfDir } from "./repo-resolve.ts";
import type { SessionCells } from "./session-cells.ts";
import { isEnforcedMode } from "./task-mode.ts";

/**
 * This process's sidecar variant (F4), resolved ONCE from the environment.
 *
 * A session an orchestrator spawned carries `RG_STATE_VARIANT`, so it reads
 * and writes its OWN `.pi/review-gate-state.<variant>.json` instead of
 * sharing one file with the supervising orchestrator (whose `taskMode`,
 * `askUser` record and unmet-gate list would otherwise overwrite each
 * other's). See lib/gate-state.ts for why the CHILD moves rather than the
 * orchestrator.
 */
export const SESSION_STATE_VARIANT = stateVariantFrom(process.env);

/** The sidecar this process owns, for any repo it touches. */
export function sessionSidecarPath(root: string): string {
  return sidecarPath(root, ".pi", SESSION_STATE_VARIANT);
}

/**
 * The LOOP GOAL this process owns, for any repo it touches (R-10).
 *
 * Same variant as the sidecar, for the same measured reason: an orchestration
 * child shares the supervisor's worktree, so without this two serial children
 * write their approved goals into ONE file and the second overwrites the
 * first — while the reviewer verifies against that file.
 */
export function loopGoalPathIn(root: string): string {
  return pathJoin(root, loopGoalRelPath(SESSION_STATE_VARIANT));
}

/** Read THIS session's goal (never another session's copy). */
export function readSessionLoopGoal(root: string): LoopGoal {
  return readLoopGoal(root, Date.now(), SESSION_STATE_VARIANT);
}

/**
 * HOW FAR THIS SESSION MAY SHIP (2026-09-15) — the ONE reader of
 * `RG_STATION_CAP`, shared by the goal dialog and the restatement dialog.
 *
 * The variable is written by the DISPATCHER (lib/orchestrator-dispatch.ts)
 * and by nothing else, which is the whole point: it lives in an environment
 * the session's own prompt cannot reach, so a child cannot talk itself out
 * of the ceiling its task was dispatched with.
 *
 * An ABSENT variable is `undefined` — NO ceiling — and never
 * `precommit`: a standalone loop session has no plan above it, and reading
 * absence as the strictest station would silently freeze every ordinary
 * session at "the gate's checks pass, the user commits". The two statements
 * are not the same one, so `parseDeliveryStation` (whose default IS the
 * strictest station) is only reached when the variable is really there.
 */
export function stationCapFromEnv(): DeliveryStation | undefined {
  const raw = process.env[STATION_CAP_ENV];
  return raw === undefined || raw.trim() === "" ? undefined : parseDeliveryStation(raw);
}

/**
 * Walk up to the nearest EXISTING ancestor directory. `gitRootOfDir` runs
 * `git rev-parse`, which fails on a path that does not exist — and a
 * `write` creating a NEW nested file targets exactly such a path. An
 * unattributable path falling back to the primary repo is what let repo
 * A's approved goal open repo B's write surface, so attribution must
 * first climb to a directory git can actually resolve.
 */
export function nearestExistingDir(p: string): string {
  let d = p;
  for (;;) {
    try {
      if (statSync(d).isDirectory()) return d;
    } catch { /* does not exist — keep climbing */ }
    const parent = pathDirname(d);
    if (parent === d) return d;
    d = parent;
  }
}

export function createLoopGoalHost(
  cells: SessionCells,
  deps: {
    stateForRepo(root: string): GateState;
    persistRepo(ctx: ExtensionContext, root: string): void;
    persist(ctx?: ExtensionContext): void;
    knownRepoRoots(): string[];
    isJudgePane(): boolean;
    askMultiChoice: ReturnType<typeof createGateDialogs>["askMultiChoice"];
    log(text: string): void;
  },
) {
  /**
   * Does the goal file's CURRENT text carry the user's approval?
   *
   * The comparison is over content, not time: the sidecar holds the hash of
   * exactly the text shown in the confirm dialog, so an agent edit after the
   * approval silently drops it — which is the intended behaviour, since the
   * contract the user agreed to no longer exists. The raw file is re-read here
   * because the prompt copy is length-capped, and a truncated text cannot be
   * hashed back to the approved one.
   *
   * Multi-repo: `root` defaults to the primary repo, but the L8 edit gate
   * passes the TARGET repo of the write — each repo's goal is checked against
   * that repo's own sidecar confirmation, so a session editing several repos
   * cannot satisfy one repo's goal and then write into another.
   */
  function loopGoalConfirmed(root: string = cells.primaryRepoRoot, st: GateState = cells.state): boolean {
    const goal = readSessionLoopGoal(root);
    if (!goal.present || !st.loopGoal) return false;
    let raw: string;
    try {
      raw = readFileSync(loopGoalPathIn(root), "utf8");
    } catch {
      return false; // unreadable ⇒ unapproved (fail-closed)
    }
    return isLoopGoalConfirmed(goal, st.loopGoal, raw);
  }

  /**
   * THE SESSION'S STAGE RECORD, read for one repo.
   *
   * The user's choice is a SESSION fact (the box is shown once, by this
   * session), while the sidecar that carries it is per repo — so a repo this
   * session has not written to yet falls back to the primary repo's copy
   * instead of reading "no record" as "all five on" behind the user's back.
   */
  function loopStagesRecord(root: string = cells.primaryRepoRoot): LoopStagesRecord | undefined {
    const st = root === cells.primaryRepoRoot ? cells.state : deps.stateForRepo(root);
    return st.stages ?? cells.state.stages;
  }

  /** IS THIS STAGE ON? — the ONE query, at all five checkpoints. */
  function stageIsOn(stage: LoopStage, root?: string): boolean {
    return stageOpen(loopStagesRecord(root), stage);
  }

  /**
   * DOES THIS ROUND OWE NO FULL-LANE VERIFICATION? (quality round P1, 2026-09-22)
   *
   * TWO ways a round owes no lane, and to the adjudicator they are ONE fact
   * (`lib/review-adjudicate.ts`'s `laneVerifiesTree` reads it as "no lane is
   * OWED at all, so nothing is missing"): the user's `/gate-bypass`, and the
   * user's own precommit stage switch. With that stage OFF the chain starts no
   * lane at all (`submitForReview` skips it), so `lastFullPassTree` can never
   * catch up with the content and the old reading withheld EVERY READY as
   * `unverified-idle` — REFUSED, not held — which made the legal combination
   * unconvergeable, and contradicted the switch's own copy.
   *
   * ONE function for BOTH readers — the recorder and the parked-READY re-ask:
   * a second composition at the other call site is how the two readings drift
   * (`laneVerifiesTree`'s docblock is the other half of this rule).
   */
  function laneVerificationWaived(root: string, st: GateState = deps.stateForRepo(root)): boolean {
    return st.bypass.active || !stageIsOn("precommit", root);
  }

  /**
   * IS THE GOAL CONTRACT SATISFIED — because the user approved it, or because
   * the user switched the goal stage off?
   *
   * This is the ENFORCEMENT question, and it is deliberately not folded into
   * `loopGoalConfirmed`: that one is a FACT ("this exact text carries the
   * user's approval") read by the approval machinery itself, while this one
   * asks what the gate should do about it. A stage that is off answers the
   * second question positively without inventing an approval the user never
   * gave.
   */
  function goalStageSatisfied(root: string = cells.primaryRepoRoot, st: GateState = cells.state): boolean {
    return !stageIsOn("goal", root) || loopGoalConfirmed(root, st);
  }

  /**
   * THE LOOP'S STANDING GOAL DIRECTIVE, stage-aware (2026-09-22).
   *
   * With the goal stage ON this is `buildLoopGoalDirective` over this repo's
   * file and approval (unchanged). With it OFF there is no contract to
   * negotiate, and the missing-goal text would send the agent to negotiate one
   * anyway — so the agent is told the truth instead (lib/loop-goal.ts owns
   * that wording, like every other goal paragraph).
   */
  function loopGoalDirectiveText(): string {
    if (!stageIsOn("goal")) return buildGoalStageOffDirective();
    return buildLoopGoalDirective(readSessionLoopGoal(cells.primaryRepoRoot), goalStageSatisfied());
  }

  /**
   * Write the user's choice where every checkpoint reads it: on the primary
   * state, and MIRRORED into every repo this session knows about — each repo
   * has its own sidecar, and the L3 hooks read the repo-local one, so a
   * secondary repo without the mirror would keep enforcing a stage the user
   * switched off.
   */
  function applyStages(record: LoopStagesRecord, ctx: unknown): void {
    cells.state.stages = record;
    for (const root of deps.knownRepoRoots()) {
      const st = deps.stateForRepo(root);
      if (st === cells.state) continue;
      st.stages = record;
      deps.persistRepo(ctx as unknown as ExtensionContext, root);
    }
    deps.persist(ctx as unknown as ExtensionContext);
  }

  const stagesRefusal = () => stagesOffered({
    mode: cells.state.taskMode,
    judge: deps.isJudgePane(),
    orchestrated: orchestrationIdFromEnv(process.env) !== undefined,
  });

  /** The five deps the stage module needs; the dialog is the gate's own box. */
  const loopStageDeps: LoopStagesDeps = {
    state: () => cells.state,
    refusal: stagesRefusal,
    askMulti: (uiCtx, spec, opts) => deps.askMultiChoice(uiCtx as { ui?: ChoiceUi }, spec, {
      ...opts,
      // A MACHINE MUST NOT TURN THE GATES OFF (quality round P1, 2026-09-22):
      // see `askDialog`'s `proxy` option.
      proxy: false,
    }),
    persist: (record, ctx) => applyStages(record, ctx),
    log: (message) => deps.log(`[stages] ${message}`),
  };

  /**
   * THE FALLBACK, asked before a tool whose gate the switches decide
   * (`propose_restatement`, or the first edit/write).
   *
   * ONCE PER SESSION, and only while there is no record: a box the user closed
   * is an answer too ("run it as it is"), and re-opening it on every edit would
   * be grinding. A host that cannot draw it says so once and then keeps the
   * defaults — the same landing a dismissed box has.
   */
  let stagesAsked = false;
  async function ensureLoopStagesFor(ctx: unknown): Promise<void> {
    if (stagesAsked || cells.state.stages !== undefined) return;
    // THE ELIGIBILITY CHECK COMES FIRST (reviewer Nit, 2026-09-22): setting the
    // once-per-session flag before it would spend the only chance on a session
    // that could not be asked — an explore/edit session promoted to loop later
    // would never see the fallback box, and only an explicit
    // `choose_loop_stages` call would exist.
    if (stagesRefusal() !== undefined) return;
    stagesAsked = true;
    await ensureLoopStages(loopStageDeps, ctx);
  }

  /**
   * WHERE THIS ROUND STOPS for one repo, or `undefined` when this session has
   * no delivery contract at all (lib/delivery-station.ts).
   *
   * Two contracts, one per role, and nothing else is consulted:
   *
   *  - loop  — the station the USER approved together with THAT REPO's loop
   *    goal. An unconfirmed goal yields `undefined` rather than the strictest
   *    station: L8 already refuses that ship on its own terms, and answering
   *    "your round stops at precommit" to a session that has no contract yet
   *    would send it to fix the wrong thing.
   *  - orchestrator — the station of the plan the user approved. Missing (an
   *    older runtime, or no approval yet) reads as the strictest station,
   *    which is the reading lib/delivery-station.ts documents for a contract
   *    that forgot to say where it stops.
   *
   * explore and normal have no contract, so they get `undefined` and keep the
   * exact ship behaviour they had before stations existed (user decision,
   * 2026-09-06).
   */
  function deliveryStationFor(root: string): DeliveryStation | undefined {
    const state = cells.state;
    if (state.taskMode === "orchestrator") {
      return state.orchestrator?.approvedPlan?.deliveryStation ?? DEFAULT_DELIVERY_STATION;
    }
    if (!isEnforcedMode(state.taskMode)) return undefined;
    // A stage that is off has no contract to read a station from — the same
    // `undefined` ("no ceiling beyond the ordinary gates") a session that
    // never negotiated a goal has always got.
    if (!stageIsOn("goal", root)) return undefined;
    const st = root === cells.primaryRepoRoot ? state : deps.stateForRepo(root);
    if (!loopGoalConfirmed(root, st)) return undefined;
    return st.loopGoal?.station ?? DEFAULT_DELIVERY_STATION;
  }

  /**
   * L8 edit-gate decision for ONE edit/write call, or undefined to let it
   * pass. Kept OUT of the tool_call body on purpose: the structural security
   * tests forbid EXPLORE branches and negated mode branches inside that
   * handler (the pre-existing `taskMode === "normal"` early return stays),
   * and this helper is also where the explore short-circuit lives — explore
   * never gates on the goal, so it must not pay for the goal lookup either
   * (gitRootOfDir is a git subprocess; loopGoalConfirmed reads the file
   * twice).
   */
  function loopGoalEditBlockFor(absPath: string | undefined): { block: true; reason: string } | undefined {
    const state = cells.state;
    const primaryRepoRoot = cells.primaryRepoRoot;
    // THE WORKTREE COMES FIRST, before any mode branch below.
    //
    // When another live session holds this checkout, nothing this session
    // writes here is safe — the two share one sidecar and one set of
    // uncommitted changes, so an edit made now is an edit made to somebody
    // else's work in progress. It refuses even in explore (an explore session
    // still writes files) and even with an approved goal on disk (a resumed
    // session carries one), which is exactly why it is ABOVE both.
    //
    // (The hook's name is the L8 goal gate's, fixed by the deps interface in
    // lib/ship-gate-edit-guard.ts; what it really is, is this extension's
    // per-edit block decision. The ship side reads the same refusal through
    // `unmetRequirements`.)
    if (state.exclusivityRefusal) {
      return { block: true, reason: state.exclusivityRefusal };
    }
    // explore never gates on the goal (loopGoalEditGate would return true
    // anyway) — skip the lookup before paying for it.
    if (state.taskMode === "explore") return undefined;
    const goalRoot = absPath
      ? // Every write pays the real per-edit git resolution: a fast path that
        // attributed anything under primaryRepoRoot to the primary repo would
        // let an approved primary goal unlock a NESTED independent git repo's
        // write surface (round P2) — the per-repo binding must be exact.
        // (~3.6 ms/edit measured; correctness beats the micro-cost.)
        gitRootOfDir(nearestExistingDir(pathDirname(absPath))) ?? primaryRepoRoot
      : primaryRepoRoot;
    const goalSt = goalRoot === primaryRepoRoot ? state : deps.stateForRepo(goalRoot);
    if (!loopGoalEditGate({ taskMode: state.taskMode, goalConfirmed: goalStageSatisfied(goalRoot, goalSt) })) {
      // Name the repo that lacks an approved goal: in a multi-repo session an
      // anonymous block makes the agent re-approve the PRIMARY goal and stay
      // blocked forever — the propose_loop_goal `repo` parameter is what
      // binds a goal to a specific repo. The hint goes in through the builder,
      // which puts it on the 现象 line where it is read.
      return { block: true, reason: loopGoalUnconfirmedEditBlock(goalRoot === primaryRepoRoot ? undefined : goalRoot) };
    }
    return undefined;
  }

  /**
   * Goal text handed to spawned reviewers. The prompt copy is capped
   * (LOOP_GOAL_MAX_CHARS), and a truncated goal's "read the file for the
   * rest" pointer would be useless without an absolute location — a judge
   * child may be reading from a throwaway worktree of its own — so a
   * truncated goal appends the REAL file path instead.
   */
  function goalTextForReviewers(root: string): { text: string; truncated: boolean } | undefined {
    const goal = readSessionLoopGoal(root);
    if (!goal.present) return undefined;
    // Use readLoopGoal's OWN truncated boolean — never sniff the display
    // marker string (round-17 Nit: the marker is display, the fact is the
    // flag).
    if (!goal.truncated) return { text: goal.text, truncated: false };
    return { text: goal.text + "\n(全文: " + loopGoalPathIn(root) + ")", truncated: true };
  }

  return {
    loopGoalConfirmed,
    loopStagesRecord,
    stageIsOn,
    laneVerificationWaived,
    goalStageSatisfied,
    loopGoalDirectiveText,
    loopStageDeps,
    ensureLoopStagesFor,
    deliveryStationFor,
    loopGoalEditBlockFor,
    goalTextForReviewers,
  };
}

export type LoopGoalHost = ReturnType<typeof createLoopGoalHost>;
