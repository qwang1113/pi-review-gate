/**
 * What the L1 ship gate SAYS — its refusal text and its one non-blocking hint.
 *
 * Split out of lib/ship-gate-bash.ts (which DECIDES): every function here is
 * pure text, so the wording can be tested without faking a single dependency
 * of the bash arm (test/ship-gate-hook.test.ts does exactly that).
 */

import { STATION_SHIP_NEXT_STEPS } from "./delivery-station.ts";
import { buildRejection } from "./rejection-copy.ts";
import { lexSegmentTokens } from "./shell-lex.ts";

/**
 * P0-5: describe compound vs single ship for block/lesson messages.
 *
 * Pure, and the reason a compound command reads as one thing in every message
 * that names it (the block reason and the arbiter lesson alike).
 */
export function describeShips(_command: string, ships: Array<{ kind: string }>): string {
  return ships.length > 1
    ? `compound command with ${ships.map((s) => s.kind).join(" + ")}`
    : ships[0].kind;
}

/**
 * A `sleep` long enough to be a WAIT rather than a pause. 30s is the smallest
 * gap that cannot be anything else: a settle delay is a second or two.
 */
const POLLING_SLEEP_SECONDS = 30;

/** File shapes a hand-rolled waiter reads: a channel file or a findings stream. */
const WAIT_EVIDENCE = /rg-channels|review-stream|\.pi\/judge-sessions|RG_JUDGE_STREAM/;

/**
 * Is this command a hand-written wait for a judge — a long `sleep` next to a
 * read of the gate's own channel or findings stream?
 *
 * WHY THE GATE SAYS SOMETHING (2026-09-05, user decision D6). This exact
 * command shape cost a measured nine minutes: `sleep 280` inside one bash call
 * while grepping the channel file. The turn never ends inside a bash call, so
 * the session never settles, so the wake-up that was supposed to deliver the
 * finished review never fires — the agent was waiting for something that could
 * only arrive after it stopped waiting. `judge_wait` is the same wait done
 * right, and it returns on the first message.
 *
 * It is a HINT, never a block, and that is deliberate: this is the opposite
 * of an appeal route. An agent with a diagnostic reason to sleep and read a
 * channel keeps doing exactly that; it just gets told there is a tool.
 *
 * Pure and exported, so the shape is unit-testable without a shell.
 *
 * `sleep` takes a suffix on both GNU and BSD (`5m`, `1h`), so the argument is
 * read as a duration rather than as a bare number — `sleep 5m` is the same
 * wait as `sleep 300`, and reading it as NaN would let the loudest case
 * through.
 */
export function detectHandRolledWaitPolling(command: string): { reason: string } | undefined {
  if (!WAIT_EVIDENCE.test(command)) return undefined;
  let longSleep = false;
  for (const tokens of lexSegmentTokens(command)) {
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== "sleep") continue;
      if (sleepSeconds(tokens[i + 1]) >= POLLING_SLEEP_SECONDS) longSleep = true;
    }
  }
  if (!longSleep) return undefined;
  return {
    reason:
      `review-gate 提示（不拦截）：这条命令看起来是手写的等待轮询（sleep ≥ ${POLLING_SLEEP_SECONDS}s + 读通道/findings 流）。` +
      "在一次 bash 里等，turn 不会结束，门禁的唤醒也就不会发生 —— 实测这样丢过九分钟。" +
      "改用 `judge_wait({role})`：新 finding、judge 提问、本轮结论、pane 消失，任一到达即返回，正文直接带回来。",
  };
}

/** `sleep` accepts a suffix (`30`, `5m`, `1h`); anything else is not a duration. */
function sleepSeconds(token: string | undefined): number {
  const matched = /^(\d+(?:\.\d+)?)([smhd])?$/.exec(token ?? "");
  if (!matched) return Number.NaN;
  const unit = matched[2];
  const multiplier = unit === "m" ? 60 : unit === "h" ? 3_600 : unit === "d" ? 86_400 : 1;
  return Number(matched[1]) * multiplier;
}



/**
 * The refusal text a blocked ship carries, as a pure decision.
 *
 * O13: ONE next-step line. The problems already say what is unmet; the
 * arbitration sentence is added only where it can apply at all (a lone
 * `gh pr edit`), because a ship gate is a FACT — satisfy it, do not argue
 * with it.
 *
 * TWO KINDS OF BLOCK, TWO NEXT STEPS (2026-09-06). Unmet quality is cleared
 * by working (review → precommit → done); a DELIVERY STATION is not — it is
 * the contract for how far this round travels, and only the user can move it.
 * Telling a station-blocked session to "run the review loop" would be a loop
 * with no exit, so a station block replaces that line with
 * {@link STATION_SHIP_NEXT_STEPS} and never offers the arbitration route (the
 * arbiter hears a lone `gh pr edit` only, so it is a dead end that also costs
 * one of three appeals).
 */
export function buildShipBlockReason(input: {
  command: string;
  ships: Array<{ kind: string }>;
  problems: string[];
  crossRepoHint: string;
  /** Ship commands refused because they travel past this round's station. */
  stationProblems?: string[];
}): { recorded: string; shown: string } {
  const stationProblems = input.stationProblems ?? [];
  const allProblems = [...input.problems, ...stationProblems];
  const stationOnly = stationProblems.length > 0 && input.problems.length === 0;
  // ONE rendering per fact: `recorded` and `shown` are two surfaces of the same
  // refusal (the arbiter reads the first, the agent the second), so the list
  // and the compound-command warning are built once and composed twice.
  const problemList = allProblems.map((p) => `  - ${p}`).join("\n");
  const compoundWarning =
    input.ships.length > 1
      ? "\nCompound ship commands are unsafe: later operations run after HEAD changes. Split them."
      : "";
  const recorded =
    `review-gate: ${describeShips(input.command, input.ships)} blocked — ` +
    (stationOnly ? "beyond this round's delivery station:\n" : "quality gates unmet:\n") +
    problemList +
    compoundWarning +
    input.crossRepoHint;
  const nextStep = stationProblems.length > 0
    ? STATION_SHIP_NEXT_STEPS +
      (input.problems.length > 0
        ? "\n上面那些质量门禁项则照常用审查循环清掉（judge_submit → declare_done）。"
        : "")
    : (input.ships.length === 1 && input.ships[0].kind === "pr-edit"
      ? "跑完审查循环清掉门禁（judge_submit → declare_done）；若这条拦截确实是循环死结（唯一的修法就是这条 gh pr edit），可 request_arbitration。"
      : "跑完审查循环清掉门禁（judge_submit → declare_done）。");
  // The agent-facing message is the three-part shape; `recorded` stays the
  // flat text the arbiter and the sidecar read (its exact bytes are pinned).
  const shown = buildRejection({
    what: `${describeShips(input.command, input.ships)} 被拦 —— ` +
      (stationOnly ? "超出本轮的交付站点" : "质量门禁未满足"),
    why: "\n" + problemList + compoundWarning + input.crossRepoHint,
    // Unmet quality is the agent's to clear; a station is the USER's to move.
    // A mixed refusal is labelled for the agent — it has work to do either
    // way (the station half is spelled out in `next`, which asks the user).
    by: stationOnly ? "user" : "agent",
    next: nextStep,
  });
  return { recorded, shown };
}
