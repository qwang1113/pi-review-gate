/**
 * THE SURVIVAL INVARIANT — a session that has not met its exit contract may
 * not be left stopped.
 *
 * WHY THIS EXISTS (measured 2026-08-30). Auto-continuation used to be purely
 * EVENT-DRIVEN: `agent_settled` fired once per turn, and the only thing that
 * produced the NEXT `agent_settled` was the injection this one made. That
 * makes the loop self-sustaining while it works — and terminal the moment one
 * link is skipped. Six `return`s guard that injection, and any of them ending
 * a turn silently means no event will ever come back to retry.
 *
 * The asymmetry that exposed it: a loop session heals itself, because
 * `loopArmed` is re-armed on the EDIT path ("a new edit un-finishes the
 * task"), so an agent that keeps working re-arms itself by working. An
 * ORCHESTRATOR writes no code (constraint 2), so it can reach none of those
 * re-arm sites: stopped once, stopped for good. Observed exactly that way —
 * loop sessions were revived by the gate, the project manager never was.
 *
 * So the invariant cannot ride on agent events at all. It needs a clock, and
 * a decision that is INDEPENDENT of everything the agent did this turn.
 *
 * WHAT THIS MODULE DELIBERATELY CANNOT SEE (this is the design, not an
 * omission): the continuation budget (`maxRounds`) and the `loop-stall`
 * circuit breaker are not parameters here. They exist to stop the gate from
 * TALKING TO ITSELF — burning quota telling an agent to retry something that
 * cannot move — and they are right about that, for the injection path they
 * guard. They are the wrong answer to "the session stopped with its contract
 * unmet", because a stopped session costs nothing per minute and a silently
 * abandoned task costs the whole run. Keeping them out of this signature is
 * what makes it impossible for a future edit to quietly re-couple them.
 *
 * WHAT IT DOES RESPECT: a human saying stop. Every human stop outranks the
 * invariant, because the invariant exists to beat MACHINE failure modes
 * (a provider error, an agent that decided it was done early), never to
 * override a person. A user who pressed ESC gets silence until their next
 * message; a session waiting on `ask_user` is not nagged while the human is
 * typing into the dialog.
 *
 * Pure: facts in, a decision out. No I/O, no clock of its own, no state — the
 * extension owns the timer and the state, this owns the judgement.
 */

/** Default cadence of the fallback revival check. */
export const REVIVAL_INTERVAL_MS = 60_000;

/**
 * The modes that HAVE an exit contract.
 *
 * `explore` and `normal` are excluded by definition rather than by policy:
 * ending the task on the agent's own judgement is precisely what they mean,
 * so there is no contract left unmet when they stop.
 */
export const REVIVABLE_MODES = ["loop", "orchestrator"] as const;

/**
 * The ways a HUMAN can stop a session. Each one outranks the invariant.
 *
 * These are facts the extension reads off gate state; naming them in one
 * struct keeps the "who is allowed to stop this" question in a single place
 * instead of spread across six early returns.
 */
export interface HumanStop {
  /** ESC — the user aborted the run (cleared by their next message). */
  aborted: boolean;
  /** `ask_user` is waiting on an answer; the dialog is up on their screen. */
  awaitingAnswer: boolean;
  /** `/gate-bypass` — the human asked the gate to stand down. */
  bypassed: boolean;
  /** An arbiter ruling the human resolved as "pause and wait". */
  arbitrationPaused: boolean;
}

/** Everything a revival decision needs. */
export interface RevivalInputs {
  /** The session's gate mode. */
  mode: string;
  /**
   * What the exit contract still lacks — empty means the session has EARNED
   * the right to stop. This is the unified criterion: the orchestration's
   * `declare_done` problems for a project manager, the unmet gates plus
   * completion items for a loop session.
   *
   * LAZY because assembling it costs a worktree fingerprint (~180ms); the
   * cheap guards (mode, handoff, consent, idle, throttle) run first and
   * only a session that might actually be revived pays for the scan.
   */
  exitProblems: () => readonly string[];
  /** Is the agent idle? Waking a working agent is pure noise. */
  idle: boolean;
  humanStop: HumanStop;
  /**
   * This session handed its orchestration to a successor
   * (`orchestrator_handoff`). It is DONE by choice even though the plan is
   * not: reviving it would put two project managers on one orchestration.
   */
  handedOff: boolean;
  /** When this session last injected a revival (ms epoch; undefined = never). */
  lastRevivalAt?: number;
  now: number;
  /** Minimum gap between two revivals. */
  intervalMs: number;
}

export interface RevivalDecision {
  revive: boolean;
  /** Why, in one phrase — for the audit log. Never empty. */
  reason: string;
}

/** Is this a mode whose sessions carry an exit contract? */
export function isRevivableMode(mode: string): boolean {
  return (REVIVABLE_MODES as readonly string[]).includes(mode);
}

/**
 * Should the gate wake this session up right now?
 *
 * Order matters and encodes BOTH the precedence and the cost: identity (is
 * there a contract at all) → consent (did a human stop this) → timing
 * (is it idle, is it due) → need (is anything actually unmet). The cheap
 * guards run before the expensive problem thunk, so a session that is
 * paused, working or throttled never pays for the fingerprint scan. Human
 * stops are checked BEFORE the problem list so that a paused session is
 * never described as "revived".
 */
export function decideRevival(inputs: RevivalInputs): RevivalDecision {
  if (!isRevivableMode(inputs.mode)) {
    return { revive: false, reason: `mode "${inputs.mode}" 没有退出契约（explore/normal 由 agent 自行结束）` };
  }
  if (inputs.handedOff) {
    return { revive: false, reason: "本会话已交接编排给后继者 —— 主动退出，不是停滞" };
  }

  // Consent before need: a human stop is honoured even with the contract wide
  // open, and saying so in the reason keeps the log honest about WHY it is
  // quiet (the one thing an operator has to be able to tell apart).
  const stopped = firstHumanStop(inputs.humanStop);
  if (stopped) return { revive: false, reason: stopped };

  // Cheap guards first: idle is a boolean, the problem list costs a
  // fingerprint. A working session is never revived, so it never pays.
  if (!inputs.idle) {
    return { revive: false, reason: "会话正在工作中，无需唤醒" };
  }
  const problems = inputs.exitProblems();
  if (problems.length === 0) {
    return { revive: false, reason: "退出契约已满足 —— 会话有权停下" };
  }

  const waited = inputs.lastRevivalAt === undefined
    ? Number.POSITIVE_INFINITY
    : inputs.now - inputs.lastRevivalAt;
  if (waited < inputs.intervalMs) {
    return {
      revive: false,
      reason: `节流窗口内（距上次唤醒 ${Math.max(0, Math.round(waited / 1000))}s < ${Math.round(inputs.intervalMs / 1000)}s）`,
    };
  }

  return {
    revive: true,
    reason: `退出契约还差 ${problems.length} 项，且会话已停下 —— 唤醒`,
  };
}

/** The first human stop in effect, as a reason string; undefined when none. */
function firstHumanStop(stop: HumanStop): string | undefined {
  if (stop.aborted) return "用户按 ESC 中止 —— 等他的下一条消息恢复";
  if (stop.awaitingAnswer) return "正在等用户回答 ask_user —— 不打扰";
  if (stop.bypassed) return "/gate-bypass 生效中 —— 人已要求门禁让路";
  if (stop.arbitrationPaused) return "仲裁裁决为 pause —— 等人的进一步指示";
  return undefined;
}

/**
 * The text injected to revive a session.
 *
 * It says what is MISSING and what to do next, and it never mentions a round
 * number: this path spends no continuation budget, and quoting a budget the
 * agent is not consuming would only teach it to ration itself.
 */
export function buildRevivalMessage(mode: string, exitProblems: readonly string[]): string {
  const orchestrator = mode === "orchestrator";
  const head = orchestrator
    ? "[REVIEW_GATE_REVIVE] 编排还没有完成，但这个会话停下了。还差："
    : "[REVIEW_GATE_REVIVE] 任务还没有完成，但这个会话停下了。还差：";
  const tail = orchestrator
    ? "继续推进 plan：`orchestrator_wait` 拿健康快照与待答请求，该派活的派活、该回答的回答；" +
      "全部任务完成且没有活着的子会话时才 declare_done。不要总结，直接执行。"
    : "继续把它们做完：修改 → `judge_submit({role:\"reviewer\"})` → declare_done。不要总结，直接执行。";
  return `${head}\n${exitProblems.map((p) => `- ${p}`).join("\n")}\n${tail}`;
}
