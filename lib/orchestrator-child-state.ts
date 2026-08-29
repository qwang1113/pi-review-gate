/**
 * WHAT IS THAT CHILD DOING RIGHT NOW — the four-state answer, as a pure
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
 * of its own (`at` is passed in), so the whole four-state machine is testable
 * with fake screens — which is the point, because the last round shipped 1918
 * green unit tests and deadlocked on the first real hop.
 */

/** The four states a registered child can be in. All four were observed. */
export type ChildState =
  /** Producing output, or provably blocked on work it started itself. */
  | "working"
  /** A dialog (or a gate pause) is waiting for an answer. */
  | "waiting-input"
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
  /** The child reported `declare_done` (registry fact). */
  done?: boolean;
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
 * Matched as substrings against the whole capture: the question is "is
 * something running", not "which screen is this".
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
export function screenLooksBusy(text: string | undefined): boolean {
  if (!text) return false;
  return IN_FLIGHT_SIGNATURES.some((sig) => text.includes(sig));
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
 *  4. anything provably in flight (a judge round, an "esc to interrupt"
 *    screen, a screen that just changed) is `working`;
 *  5. only when none of the above holds, and the screen has been still long
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
      (observation.done ? "（它已经报告过 declare_done）" : "（而且它并没有报告 declare_done）"),
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
  return state === "waiting-input" || state === "idle" || state === "dead";
}

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
  const due = last === undefined || now - last >= nextRewakeDelayMs(reported);
  if (!entered && !due) return { raise: false, reason: "", memory };
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
}

const STATE_LABELS: Readonly<Record<ChildState, string>> = Object.freeze({
  working: "working（在跑）",
  "waiting-input": "waiting-input（在等人答）",
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
      return (
        `- ${h.childId}${h.taskId ? `（task=${h.taskId}` : "（"}${h.paneId ? `，pane ${h.paneId}` : ""}）：` +
        `${describeChildState(h.state)}，画面已静止 ${since}` +
        (h.lastActivityAt ? `（最后变化 ${h.lastActivityAt}）` : "") +
        (h.dialogTitle ? `，当前框「${h.dialogTitle}」` : "") +
        (h.done ? "，已报告完成" : "") +
        `\n  依据：${h.reason}`
      );
    })
    .join("\n");
}

