/**
 * WHAT IS THAT CHILD DOING RIGHT NOW — the five-state answer, as a pure
 * function.
 *
 * THE MEASURED PROBLEM (second end-to-end run, 2026-08-29/30). Both routes
 * completed, but the orchestrator spent the whole night hand-rolling the
 * supervision: a shell loop of `tmux capture-pane`, an eyeball verdict on
 * whether the child was working, and an Escape when it looked stuck. The
 * verification's own conclusion names one blocker and only one — "the project
 * manager cannot reliably know what a child session is doing". Three of the
 * four situations produced NO signal at all:
 *
 *   waiting-input   the child raised a dialog and the event was swallowed
 *                   (R-16), so nobody was woken;
 *   idle            it stopped without `declare_done` — no event exists for
 *                   "I quietly stopped" (R-23);
 *   dead            its pane vanished and only a later poll noticed.
 *
 * WHAT THE THIRD RUN ADDED, and it is the reason this file now has FIVE
 * states (R3-5, P0). A child that had finished everything — reviewer READY,
 * full precommit, `declare_done` accepted, branch merged — was classified
 * `working` and produced NO event for 725 seconds. Two independent defects
 * met:
 *
 *   (a) "something is running" was matched against the WHOLE capture, so any
 *       `Working` / `esc to interrupt` the child had ever printed kept
 *       matching forever. The signal is now read from the LAST few lines
 *       only, where a live activity indicator actually is;
 *   (b) `done` had no criterion at all. The structured truth was already on
 *       disk — the child's own sidecar records its completion — and nobody
 *       read it. It is now the FIRST thing consulted once the screen settles.
 *
 * The contrast that made it fatal: a sibling that finished the same way was
 * called `idle` (because its screen happened to hold different text) and woke
 * the orchestrator after 47s. One had a signal, the other never would have —
 * decided by which words were left on a terminal. `working` means "all is
 * well", so nobody goes looking; completion was found by a HUMAN getting
 * suspicious about a "still for 718s" line. Finding out that the work is done
 * must be a signal, not a suspicion.
 *
 * THE TRAP THIS MODULE IS BUILT AROUND (R-23, with a measured counter-example).
 * "The token counter stopped growing" is NOT idleness: a child blocked in
 * `judge_wait` for 550s and a child running a 700s poll loop both look frozen
 * and are both perfectly healthy. So the classification leans on STRUCTURED
 * truth first — the child's own sidecar (is a judge round in flight? is it
 * paused on a user question?) and the footer-anchored dialog parse — and uses
 * the screen fingerprint only as the last, weakest signal, after normalizing
 * away the digits that tick on their own.
 *
 * Pure module: observations in, a state out. No tmux, no filesystem, no clock
 * of its own (`at` is passed in), so the whole five-state machine is testable
 * with fake screens — which is the point, because the last round shipped 1918
 * green unit tests and deadlocked on the first real hop.
 */

/** The five states a registered child can be in. All five were observed. */
export type ChildState =
  /** Producing output, or provably blocked on work it started itself. */
  | "working"
  /** A dialog (or a gate pause) is waiting for an answer. */
  | "waiting-input"
  /** Its own gate sidecar records a completed task — the terminal state. */
  | "done"
  /** Alive, nothing on screen moving, and nothing in flight — it stopped. */
  | "idle"
  /** Its pane is gone. */
  | "dead";

/** The structured half of an observation: the child's OWN gate sidecar. */
export interface ChildSidecarFacts {
  /** A judge child process is in flight — blocked here means WORKING. */
  judgeRunning?: boolean;
  /** It is paused waiting for a human answer (ask_user). */
  pausedQuestion?: boolean;
  /** Its last review verdict, when it has one. */
  reviewVerdict?: string;
  /** Its last precommit verdict, when it has one. */
  precommitVerdict?: string;
  /**
   * ISO time its `declare_done` was ACCEPTED — the completion truth (R3-5).
   *
   * Written by the child's own gate when the task was declared complete, so
   * it survives whatever the terminal happens to be showing. This is the one
   * fact that separates "finished" from "stopped", and reading it is the
   * whole reason the `done` state can exist.
   */
  completedAt?: string;
}

/** One measurement of one child. Every field is observed, never assumed. */
export interface ChildObservation {
  childId: string;
  /**
   * Pane liveness AS MEASURED. `undefined` means tmux could not be read,
   * which is deliberately not `false`: an unreadable pane list once made a
   * live child look dead (F14), and a wrong "dead" ends supervision.
   */
  paneAlive: boolean | undefined;
  /** Rendered screen text; `undefined` when the capture failed. */
  screenText?: string;
  /** A choice list is open (footer-anchored parse — see pane-read). */
  dialogOpen?: boolean;
  /** Its title, for the health snapshot. */
  dialogTitle?: string;
  sidecar?: ChildSidecarFacts;
  /**
   * The registry says this child reported `declare_done` — and that flag is
   * dropped again the moment it is given new work, so unlike the sidecar
   * record it always refers to the CURRENT assignment.
   */
  done?: boolean;
  /**
   * When this child was last GIVEN something to do (ms), if known.
   *
   * A completion record older than this belongs to the PREVIOUS assignment
   * (round-1 P1): without this comparison a child re-tasked after finishing
   * is reported `done` again as soon as its screen settles — including when
   * it has merely got stuck, which is the one thing a supervisor must hear
   * about and the one state that never rings.
   */
  assignedAt?: number;
  /** Wall clock of this observation, in ms. */
  at: number;
}

/** What the probe remembers about one child between observations. */
export interface ChildStateMemory {
  fingerprint?: string;
  /** When the fingerprint last CHANGED (ms). */
  changedAt?: number;
  state?: ChildState;
  /** When the current state was entered (ms). */
  since?: number;
  /** How many times this unresolved state has already woken the orchestrator. */
  reported?: number;
  lastReportedAt?: number;
  /**
   * Out-of-boundary files this child was ALREADY reported for (R3-1).
   *
   * Constraint 8 no longer reads the goal TEXT, so the boundary is enforced
   * against what the child actually edited — and that check runs on every
   * probe rather than once. Remembering which paths were already named is
   * what keeps a standing breach from ringing every ten seconds while a NEW
   * one still rings immediately.
   */
  breachReported?: string[];
}

/** The verdict for one child, plus the memory to carry into the next probe. */
export interface ChildStateVerdict {
  state: ChildState;
  /** One sentence naming the evidence — never a guess dressed as a fact. */
  reason: string;
  memory: ChildStateMemory;
  /** How long the screen has been unchanged (ms), when it is known. */
  stableMs?: number;
}

/**
 * How long a screen must sit still before a visible dialog counts as
 * `waiting-input` rather than a repaint in progress.
 */
export const WAIT_INPUT_STABLE_MS = 2_000;

/**
 * How long everything must sit still before a live child counts as `idle`.
 *
 * Generous on purpose: the cost of calling a working child "idle" is a false
 * wake-up plus an orchestrator that interrupts real work, while the cost of
 * being slow is one more probe interval.
 */
export const IDLE_AFTER_MS = 45_000;

/**
 * Screen signatures that mean "a turn is in flight".
 *
 * Matched as substrings, but ONLY against the tail of the capture (see
 * {@link ACTIVITY_TAIL_LINES}): the question is "is something running RIGHT
 * NOW", not "did this session ever run anything".
 */
const IN_FLIGHT_SIGNATURES: readonly string[] = Object.freeze([
  "esc to interrupt",
  "Esc to interrupt",
  "ESC to interrupt",
  "Working",
  "working…",
  "Thinking",
  "thinking…",
  "Running",
  "esc to cancel",
]);

/**
 * How many lines at the BOTTOM of a capture may carry an activity indicator.
 *
 * THE BUG THIS NUMBER FIXES (R3-5a, measured for 725 seconds). The signatures
 * above used to be matched against the whole screen. A pi pane keeps its
 * scrollback on screen, so the moment a child had printed `Working` or `esc
 * to interrupt` ONCE — every child does, every turn — the match held forever
 * and the child was `working` for the rest of its life. It could finish
 * everything and never produce an event, because `working` is the state
 * nobody investigates.
 *
 * A live indicator is rendered by the composer, which sits at the bottom of
 * the pane; 12 lines covers it plus the belowEditor widget and the status
 * line, and excludes the transcript above. Deliberately not 1–2 lines: a
 * repaint mid-capture would then read as "idle" and interrupt a healthy turn.
 */
export const ACTIVITY_TAIL_LINES = 12;

/**
 * The comparable form of a screen.
 *
 * DIGITS ARE ERASED, and that is the whole trick (R-23). A pi pane renders a
 * token count, a cost, an elapsed-seconds counter and a context percentage,
 * all of which tick without anybody doing anything — so a raw text comparison
 * says "changed" forever and nothing is ever idle. Conversely the counters
 * FREEZING is not idleness either (a child blocked in `judge_wait` freezes
 * them), which is why this fingerprint is only ever the weakest of the three
 * signals below.
 */
export function screenFingerprint(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return String(text)
    .replace(/\d+/g, "#")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

/**
 * Is a turn visibly in flight on this screen?
 *
 * Exported because delivery needs the same question answered (R-20): a slash
 * command typed at a BUSY child does not execute — it lands in the steering
 * queue as an ordinary message — so the gate waits for the idle window
 * instead of making the orchestrator poll `capture-pane` by hand.
 */
export function screenLooksBusy(
  text: string | undefined,
  tailLines: number = ACTIVITY_TAIL_LINES,
): boolean {
  if (!text) return false;
  const tail = screenTail(text, tailLines);
  return IN_FLIGHT_SIGNATURES.some((sig) => tail.includes(sig));
}

/**
 * The bottom `tailLines` non-blank-terminated lines of a capture.
 *
 * Trailing blank lines are dropped FIRST: a pane whose capture ends in ten
 * empty rows would otherwise push the live indicator out of the window and
 * make a busy child look stopped — the opposite error, and the more expensive
 * one (it interrupts real work).
 */
function screenTail(text: string, tailLines: number = ACTIVITY_TAIL_LINES): string {
  const lines = String(text).split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const count = Math.max(1, Math.floor(tailLines));
  return lines.slice(-count).join("\n");
}

/**
 * Classify ONE observation against what the previous one left behind.
 *
 * ORDER IS THE DESIGN:
 *
 *  1. a pane that is provably gone is `dead` — nothing else matters;
 *  2. liveness that could NOT be measured keeps the previous state (never a
 *    death, never a promotion);
 *  3. an open dialog or a gate pause is `waiting-input` — the only state that
 *    is somebody else's turn to act;
 *  4. a judge round in flight is `working` — blocking there is healthy work;
 *  5. a completion record in the child's OWN sidecar, on a settled screen, is
 *    `done` — the terminal state, and the one a supervisor must never have to
 *    guess at (R3-5);
 *  6. anything else provably in flight (an activity indicator in the screen's
 *    TAIL, a fingerprint that just changed) is `working`;
 *  7. only when none of the above holds, and the screen has been still long
 *    enough, is a child called `idle`.
 */
export function classifyChildState(
  observation: ChildObservation,
  memory: ChildStateMemory = {},
  opts: { idleAfterMs?: number; waitInputStableMs?: number } = {},
): ChildStateVerdict {
  const idleAfter = opts.idleAfterMs ?? IDLE_AFTER_MS;
  const waitStable = opts.waitInputStableMs ?? WAIT_INPUT_STABLE_MS;
  const fingerprint = screenFingerprint(observation.screenText);
  const changed = fingerprint !== undefined && fingerprint !== memory.fingerprint;
  const changedAt = changed ? observation.at : memory.changedAt ?? observation.at;
  const stableMs = Math.max(0, observation.at - changedAt);

  const settle = (state: ChildState, reason: string): ChildStateVerdict => {
    const entered = memory.state === state ? memory.since ?? observation.at : observation.at;
    return {
      state,
      reason,
      stableMs,
      memory: {
        ...(fingerprint === undefined ? { fingerprint: memory.fingerprint } : { fingerprint }),
        changedAt,
        state,
        since: entered,
        reported: memory.state === state ? memory.reported ?? 0 : 0,
        ...(memory.state === state && memory.lastReportedAt !== undefined
          ? { lastReportedAt: memory.lastReportedAt }
          : {}),
        // Boundary reports are about FILES, not about the state machine:
        // they must survive every transition, or a child that alternates
        // working/idle would re-report the same breach forever.
        ...(memory.breachReported ? { breachReported: memory.breachReported } : {}),
      },
    };
  };

  if (observation.paneAlive === false) return settle("dead", "pane 已经不在了（异常退出，或被关掉）");
  if (observation.paneAlive === undefined) {
    return settle(
      memory.state && memory.state !== "dead" ? memory.state : "working",
      "读不到 tmux pane 列表，存活状态未知 —— 沿用上一次的判定，绝不当成死亡",
    );
  }

  const sidecar = observation.sidecar;
  if (observation.dialogOpen && stableMs >= waitStable) {
    return settle(
      "waiting-input",
      `屏幕上有等待回答的对话框${observation.dialogTitle ? `（${observation.dialogTitle}）` : ""}，` +
      `且画面已 ${Math.round(stableMs / 1000)}s 没变`,
    );
  }
  if (sidecar?.pausedQuestion) {
    return settle("waiting-input", "它自己的 sidecar 说它停在一个待用户回答的问题上（ask_user）");
  }
  if (observation.dialogOpen) {
    return settle("working", "屏幕上刚出现一个对话框，但画面还在动 —— 先按在跑处理，下一次探针再定");
  }
  if (sidecar?.judgeRunning) {
    return settle("working", "它的 sidecar 显示有 judge 子进程在跑 —— 阻塞在 judge 上是正常工作态（不是 idle）");
  }
  // R3-5b — THE COMPLETION CRITERION, and its rank is the whole design.
  //
  // Everything ABOVE outranks it, because a finished child that is being
  // asked something, or that was handed a new round, is not "done" any more
  // (the record stays on disk, so it falls back to `done` once it settles
  // again). Everything BELOW it is screen text — which is precisely what
  // classified a finished child as `working` for 725 seconds.
  //
  // A settled screen is still required: it is what separates "it finished"
  // from "it finished and immediately started something else", and it costs
  // exactly one probe interval.
  //
  // AND THE RECORD MUST BE ABOUT THE CURRENT WORK (round-1 P1). `declare_done`
  // writes that record once and nothing clears it, so a child handed a second
  // task would otherwise be called `done` again the moment it settled — which
  // is exactly what a child STUCK on the new work looks like. A completion
  // older than the assignment is history; the registry flag, which the gate
  // drops when it assigns new work, needs no such comparison.
  const completedAt = sidecar?.completedAt;
  const completedMs = completedAt ? Date.parse(completedAt) : Number.NaN;
  const completionIsCurrent = Number.isFinite(completedMs) &&
    (observation.assignedAt === undefined || completedMs >= observation.assignedAt);
  const completed = completionIsCurrent || observation.done === true;
  if (completed && !changed && !screenLooksBusy(observation.screenText)) {
    return settle(
      "done",
      completionIsCurrent
        ? `它自己的 sidecar 记着 declare_done 已被接受（${completedAt}），且画面已静止 —— 任务完成`
        : "登记表里记着它报告过完成，且画面已静止 —— 任务完成",
    );
  }
  if (screenLooksBusy(observation.screenText)) {
    return settle("working", "屏幕上有「正在跑」的标志（esc to interrupt / Working / Thinking）");
  }
  if (changed) return settle("working", "屏幕指纹相对上一次探针发生了变化");
  if (fingerprint === undefined) {
    return settle(
      memory.state && memory.state !== "dead" ? memory.state : "working",
      "读不到它的屏幕（capture-pane 失败）—— 沿用上一次的判定",
    );
  }
  if (stableMs >= idleAfter) {
    return settle(
      "idle",
      `画面已 ${Math.round(stableMs / 1000)}s 没有任何变化，没有对话框、没有在跑的标志、也没有 judge 子进程` +
      (observation.done
        ? "（它已经报告过 declare_done）"
        : completedAt && !completionIsCurrent
          // The distinction a supervisor acts on: this child DID finish
          // something, but that was before the work it is sitting on now.
          ? `（它 sidecar 里那条完成记录是 ${completedAt}，早于本次派活 —— 属于上一轮任务，本轮它没报完成）`
          : "（而且它并没有报告 declare_done）"),
    );
  }
  return settle("working", `画面 ${Math.round(stableMs / 1000)}s 没变，还没到 ${Math.round(idleAfter / 1000)}s 的静止阈值`);
}

// ---------------------------------------------------------------------------
// When to ring the bell — and when to ring it AGAIN
// ---------------------------------------------------------------------------

/**
 * The re-wake backoff (user requirement, 2026-08-30): 10s → 30s → 60s, then
 * every 60s.
 *
 * "The event was dequeued" is not "the matter was handled" (F12), and the
 * second run proved the converse hurts more: a dialog that nobody answered
 * stopped producing events entirely, so the child waited in front of it for
 * six minutes. An UNRESOLVED waiting state therefore rings again, with
 * growing gaps — loud enough to be noticed, quiet enough not to drown the
 * orchestrator's own work.
 */
export const REWAKE_BACKOFF_MS: readonly number[] = Object.freeze([10_000, 30_000, 60_000]);

/**
 * How long after the LAST report the same unresolved state may ring again.
 *
 * `alreadyReported` counts reports that have happened, so the FIRST re-wake
 * (after one report) waits 10s, the second 30s, and everything after that
 * 60s — the sequence the user asked for, counted from the report rather than
 * from the state change.
 */
export function nextRewakeDelayMs(alreadyReported: number): number {
  const index = Math.max(0, Math.min(alreadyReported - 1, REWAKE_BACKOFF_MS.length - 1));
  return REWAKE_BACKOFF_MS[index]!;
}


/** States that are worth waking the orchestrator for. */
export function isNewsworthy(state: ChildState): boolean {
  return state === "waiting-input" || state === "idle" || state === "dead" || state === "done";
}

/**
 * How a COMPLETED child rings (user decision, 2026-08-30, option C).
 *
 * `done` is terminal, so the unresolved-state backoff would just be noise:
 * there is nothing the orchestrator can do to make a finished child less
 * finished. But ringing exactly once is fragile — a supervisor busy inside a
 * long `orchestrator_wait` on ANOTHER child can miss the single event — so it
 * rings a second time a minute later and then goes quiet for good.
 */
export const DONE_REPORT_LIMIT = 2;
export const DONE_REWAKE_MS = 60_000;

/**
 * Should THIS verdict wake the orchestrator, and why?
 *
 * Edge-triggered on entering a newsworthy state, then level-triggered on the
 * backoff above while it stays unresolved. Returns the memory to persist, so
 * the caller cannot forget to record that it already rang.
 */
export function decideChildEvent(
  verdict: ChildStateVerdict,
  previousState: ChildState | undefined,
  now: number,
): { raise: boolean; reason: string; memory: ChildStateMemory } {
  const memory = verdict.memory;
  if (!isNewsworthy(verdict.state)) return { raise: false, reason: "", memory };
  const entered = previousState !== verdict.state;
  const reported = memory.reported ?? 0;
  const last = memory.lastReportedAt;
  const terminal = verdict.state === "done";
  if (terminal && reported >= DONE_REPORT_LIMIT) return { raise: false, reason: "", memory };
  const delay = terminal ? DONE_REWAKE_MS : nextRewakeDelayMs(reported);
  const due = last === undefined || now - last >= delay;
  if (!entered && !due) return { raise: false, reason: "", memory };
  // Entering `done` a second time (it was re-tasked and finished again) starts
  // a fresh pair of rings: `settle` resets `reported` on a state change, so
  // the limit above is per visit to the state, not per lifetime.
  return {
    raise: true,
    reason: verdict.reason,
    memory: { ...memory, reported: reported + 1, lastReportedAt: now },
  };
}

// ---------------------------------------------------------------------------
// The health snapshot — what every wait hands back (R-4, R-11, R-23)
// ---------------------------------------------------------------------------

/**
 * One line of the snapshot every `orchestrator_wait` returns.
 *
 * It exists because the old receipt said "子会话有事找你：等待回答提问" and
 * nothing else: with two children running, the orchestrator could not tell
 * WHICH one was calling and had to `orchestrator_read` both to find out
 * (R-4). And because a human glancing at a pane mis-reads liveness (R-11):
 * the structured facts are the truth, so they are what gets reported.
 */
export interface ChildHealth {
  childId: string;
  taskId?: string;
  paneId?: string;
  state: ChildState;
  reason: string;
  /** ISO time of the last observed CHANGE on its screen. */
  lastActivityAt?: string;
  /** Seconds since that change — the number a supervisor actually reads. */
  secondsSinceActivity?: number;
  /** Title of the dialog it is waiting on, when there is one. */
  dialogTitle?: string;
  /** It reported `declare_done` already. */
  done?: boolean;
  /**
   * Files it has edited that fall OUTSIDE its task's declared boundary (R3-1).
   *
   * Constraint 8 is enforced against this — what the child actually wrote —
   * rather than against path-like words in its goal text, which punished
   * documentation tasks for quoting the files they describe.
   */
  outsideBoundaries?: string[];
}

const STATE_LABELS: Readonly<Record<ChildState, string>> = Object.freeze({
  working: "working（在跑）",
  "waiting-input": "waiting-input（在等人答）",
  done: "done（任务已完成，declare_done 已被接受）",
  idle: "idle（停了，但没 declare_done）",
  dead: "dead（pane 没了）",
});

export function describeChildState(state: ChildState): string {
  return STATE_LABELS[state];
}

/** Render the whole snapshot, one child per line. */
export function formatChildHealth(list: readonly ChildHealth[]): string {
  if (list.length === 0) return "（当前没有开着的子会话）";
  return list
    .map((h) => {
      const since = h.secondsSinceActivity === undefined ? "?" : `${h.secondsSinceActivity}s`;
      const outside = h.outsideBoundaries ?? [];
      return (
        `- ${h.childId}${h.taskId ? `（task=${h.taskId}` : "（"}${h.paneId ? `，pane ${h.paneId}` : ""}）：` +
        `${describeChildState(h.state)}，画面已静止 ${since}` +
        (h.lastActivityAt ? `（最后变化 ${h.lastActivityAt}）` : "") +
        (h.dialogTitle ? `，当前框「${h.dialogTitle}」` : "") +
        // `done` already says it in the state label; repeating it there would
        // read as two separate facts.
        (h.done && h.state !== "done" ? "，已报告完成" : "") +
        `\n  依据：${h.reason}` +
        (outside.length > 0
          ? `\n  ⚠ 越界落点（约束 8，按实际改过的文件判）：${outside.slice(0, 8).join("、")}` +
            (outside.length > 8 ? ` 等 ${outside.length} 个` : "")
          : "")
      );
    })
    .join("\n");
}

