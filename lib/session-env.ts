/**
 * SESSION ENV — what a gate-opened pane IS, and the environment that tells it so.
 *
 * Split out of lib/session-factory.ts (2026-09-27): the factory sequences the
 * opening of a pane; this module owns the identity it opens it WITH.
 *
 * ── THE ENVIRONMENT IS A CROSS-PROCESS CONTRACT ──
 *
 * {@link buildSessionEnv} is the ONLY place a pane's environment is assembled,
 * and every variable in it is read by a DIFFERENT process running a DIFFERENT
 * build of this extension: `RG_JUDGE_*` by the judge side (lib/judge-side.ts),
 * `RG_ORCHESTRATION_ID` / `RG_STATE_VARIANT` by an orchestration child's own
 * gate. Two of them additionally decide whether the session-exclusivity guard
 * lets the pane live at all (a judge is exempt because it carries `RG_JUDGE_*`,
 * an orchestration child because it carries a non-empty `RG_STATE_VARIANT`), so
 * a dropped variable does not degrade a feature — it kills the pane at boot.
 * Names and value semantics are frozen; tests pin the key set per role.
 */

import { JUDGE_ID_ENV, JUDGE_OPENER_ENV, JUDGE_ROLE_ENV } from "./judge-pane.ts";
// The scratch root a judge pane is given, and the one its worktrees are
// reclaimed from: ONE derivation, so the two sides cannot drift apart.
import { judgeScratchDir } from "./judge-process.ts";
import { JUDGE_STREAM_ENV, JUDGE_TASK_ENV } from "./judge-side.ts";
import { WORKER_ID_ENV, WORKER_OPENER_ENV, WORKER_ROLE_ENV } from "./worker-side.ts";
import { STATE_VARIANT_ENV } from "./gate-state-io.ts";
import { ORCHESTRATION_ID_ENV } from "./orchestration-id.ts";
import { STATION_CAP_ENV } from "./repo-pr-policy.ts";
import { ACCEPTANCE_GATE_ENV } from "./acceptance-round.ts";
import type { DeliveryStation } from "./delivery-station.ts";
import { GATE_MODE_ENV } from "./task-mode.ts";

/**
 * The kinds of session the gate opens. They differ in what the far side
 * reads out of its environment, and in nothing else — layout, decoration and
 * verification are separate axes of `SessionPaneSpec` (lib/session-factory.ts)
 * precisely so that "a judge is decorated like a child" cannot drift back apart.
 */
export type SessionPaneRole =
  | {
      kind: "judge";
      openerId: string;
      judgeId: string;
      role: string;
      /** Round-1 task file, when the opener passed one (judge_spawn does). */
      taskPath?: string;
      /** This round's findings stream, when there is one. */
      streamPath?: string;
    }
  | {
      kind: "orchestration-child";
      orchestrationId: string;
      /** Its OWN gate sidecar variant — also its exclusivity-guard exemption. */
      stateVariant: string;
      /**
       * The delivery station its task may reach (2026-09-15) — the plan's
       * station, narrowed when its repo holds more than one task
       * (lib/repo-pr-policy.ts). Absent for a plan that never narrowed
       * anything and for callers that predate the field, in which case the
       * child's own negotiation is the only ceiling.
       */
      stationCap?: DeliveryStation;
      /**
       * Whether this child may run the REAL-ACCEPTANCE round (2026-09-22).
       *
       * `"on"` for the plan's LAST task — the independent acceptance task
       * (`acceptanceTaskId`) — and `"off"` for every other child of an
       * orchestration, whose completion must not spend a top-tier judge on an
       * acceptance nobody asked for. Absent for a standalone session, which
       * reads absence as ON (lib/acceptance-round.ts `acceptanceGateOpen`).
       */
      acceptanceGate?: "on" | "off";
    }
  | {
      kind: "worker";
      /** The session that dispatched it — also its channel owner. */
      openerId: string;
      /** Its stable handle: the resume key for both the session id and the channel. */
      workerId: string;
      /** Which configured preset it runs as. */
      role: string;
    }
  | {
      kind: "successor";
      /** A relay hands over its own inheritance env, built by the relay module. */
      env: Readonly<Record<string, string>>;
    };

/**
 * The pane's environment. One assembly point for a cross-process contract:
 * see the module header for why a missing key here is fatal rather than
 * cosmetic.
 */
export function buildSessionEnv(role: SessionPaneRole): Record<string, string> {
  if (role.kind === "judge") {
    return {
      [JUDGE_OPENER_ENV]: role.openerId,
      [JUDGE_ID_ENV]: role.judgeId,
      [JUDGE_ROLE_ENV]: role.role,
      ...(role.taskPath === undefined ? {} : { [JUDGE_TASK_ENV]: role.taskPath }),
      ...(role.streamPath === undefined ? {} : { [JUDGE_STREAM_ENV]: role.streamPath }),
      // THE SCRATCH ROOT, set on the WRITE side (2026-09-14). A reviewer
      // verifies by doing — it checks the reviewed commit out into a throwaway
      // worktree under `$TMPDIR` — and `reapReviewScratch` reclaims exactly the
      // worktrees under `judgeScratchDir(judgeId)` when the pane goes. That
      // reclaim was written but never armed: nothing set this key, so judges
      // built their worktrees in the SYSTEM tmp root instead (a reviewer's
      // `git worktree add $TMPDIR/rgrev-<sha> HEAD`), where the reaper never
      // looks — the worktrees piled up unreclaimed, and one of them broke the
      // repository's shared git hooks for every later commit when it was
      // deleted with the round. The two sides must name the same directory;
      // test/judge-scratch.test.ts pins exactly that.
      TMPDIR: judgeScratchDir(role.judgeId),
    };
  }
  if (role.kind === "worker") {
    // The THREE keys a worker pane is: who opened it, which worker it is, and
    // which preset it was launched as. All three are required on the far side
    // (lib/worker-side.ts), because a pane that binds a channel without knowing
    // whose it is would report into somebody else's file.
    return {
      [WORKER_OPENER_ENV]: role.openerId,
      [WORKER_ID_ENV]: role.workerId,
      [WORKER_ROLE_ENV]: role.role,
      // NOT loop (2026-09-21). A worker has no goal to negotiate, no round to
      // submit and nothing to ship — it reads and reports — so telling it to
      // classify itself into the full loop would hand it a machinery it cannot
      // use (an unapproved-goal gate over a session that never asked for one).
      // `explore` is the mode that already means "investigation, ship still
      // blocked", which is exactly a worker's contract.
      [GATE_MODE_ENV]: "explore",
    };
  }
  if (role.kind === "orchestration-child") {
    return {
      // Wake-ups are addressed to the ORCHESTRATION, so they keep arriving
      // after a relay — the whole point of the id.
      [ORCHESTRATION_ID_ENV]: role.orchestrationId,
      // An ordinary loop session, told so explicitly rather than left to
      // classify itself into something else.
      [GATE_MODE_ENV]: "loop",
      // Its OWN gate sidecar, so supervisor and worker never overwrite each
      // other's mode, Q&A record and unmet-gate list.
      [STATE_VARIANT_ENV]: role.stateVariant,
      // HOW FAR THIS CHILD MAY SHIP (2026-09-15). The dispatcher computed it
      // from the approved plan; the child's goal dialog reads it so the user
      // is never offered a station the plan already ruled out.
      ...(role.stationCap === undefined ? {} : { [STATION_CAP_ENV]: role.stationCap }),
      // WHETHER THIS CHILD RUNS THE ACCEPTANCE ROUND. Same argument as the
      // ceiling above: an environment fact written by the dispatcher, which is
      // the one channel a child's own prompt cannot forge.
      ...(role.acceptanceGate === undefined ? {} : { [ACCEPTANCE_GATE_ENV]: role.acceptanceGate }),
    };
  }
  return { ...role.env };
}
