/**
 * L9 — THE REAL-ACCEPTANCE ROUND: the sixth judge, and the only one the GATE
 * dispatches from a COMPLETION call rather than from a submission.
 *
 * WHY IT EXISTS. Every other round reads. The reviewer checks the change
 * against the goal, the quality auditor checks the code itself, the full lane
 * runs the suite — and a change that passes all three can still fail to start,
 * connect, or return the right data. `agents/acceptance.md` is the judge that
 * RUNS it; this module is the mechanical half: WHEN that round is owed, WHAT
 * it is handed, HOW its verdict binds, and WHAT a non-READY costs.
 *
 * WHY `declare_done` IS THE TRIGGER (user decision, 2026-09-22). Acceptance
 * was chosen to be the last thing before completion, so it is the gate — not
 * the agent — that decides a round is owed:
 *
 *   ARMED/AWAITING  the FIRST `declare_done` dispatches the round and hands
 *                   the caller `judge_wait({role:"acceptance"})`; completion
 *                   is refused until the verdict lands.
 *   READY           bound to the CONTENT it ran against. Any change moves the
 *                   fingerprint and the pass stops applying — the same rule
 *                   the review READY lives by.
 *   BLOCKED         completion is refused with the round's own words; the fix
 *                   is code, so the next round re-accepts what changed. Also
 *                   the answer when there is NO USABLE FINGERPRINT at all:
 *                   a round whose verdict could never bind is never dispatched
 *                   (2026-09-22 — it used to be, and re-dispatched forever).
 *   SKIPPED         no code at all, or the GOAL itself declared this round has
 *                   no real acceptance (the user approved that clause).
 *   DISABLED        the gate is turned off for this session by the environment
 *                   the dispatcher wrote (an orchestration child that is not
 *                   the plan's acceptance task).
 *
 * WHY IT IS NOT IN `unmetRequirements`. That function is the SHIP authority
 * read by the git hooks, and a ship-level acceptance requirement would block
 * its own remedy: fixing an acceptance finding needs a commit, committing
 * needs the ship gate, and the ship gate would still be waiting on acceptance.
 * The Copilot cycle (lib/copilot-review.ts) has the same shape and is held the
 * same way — on task COMPLETION only.
 *
 * PURITY. No IO, no clock, no throwing: the goal text arrives as a string, the
 * fingerprint and the record are passed in, `at` is supplied by the caller.
 * The extension owns the git reads, the dispatch and the storage; this module
 * owns the rules — which is what makes every branch below a unit test.
 */

import { JUDGE_COMPLETION_DISCIPLINE } from "./gate-modes.ts";
import { acceptanceTaskId, type RepoPrPlanInput } from "./repo-pr-policy.ts";
import { composeWithUntrustedData } from "./untrusted-data.ts";

/* ───────────────────────────── the gate switch ───────────────────────────── */

/**
 * The environment flag that turns the acceptance round OFF — written by the
 * DISPATCHER (lib/orchestrator-dispatch.ts) and by nothing else.
 *
 * It rides the environment for the same reason `RG_STATION_CAP` does
 * (lib/repo-pr-policy.ts): the task document is text the orchestrator writes,
 * while an environment variable is set by the gate — the one channel a child's
 * own prompt cannot forge. An orchestration child that is NOT the plan's last
 * task gets `off`; a standalone loop session gets no variable at all.
 */
export const ACCEPTANCE_GATE_ENV = "RG_ACCEPTANCE_GATE";

/** The one value that turns the round off. Anything else (or nothing) is on. */
export const ACCEPTANCE_GATE_OFF = "off";

/**
 * IS THE ACCEPTANCE GATE OPEN FOR THIS SESSION?
 *
 * An ABSENT variable is OPEN, and that direction is deliberate: a standalone
 * loop session has no dispatcher above it, and reading absence as "off" would
 * silently exempt every ordinary session from acceptance. Only the explicit
 * word turns it off.
 *
 * THIS IS THE ONE PLACE THAT ANSWERS THAT QUESTION (t5's stage switch calls
 * it rather than re-deriving it): a second answer is how "the round is
 * skipped" and "the round is owed" end up disagreeing.
 */
export function acceptanceGateOpen(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[ACCEPTANCE_GATE_ENV];
  if (typeof raw !== "string") return true;
  return raw.trim().toLowerCase() !== ACCEPTANCE_GATE_OFF;
}

/**
 * THE VALUE THE DISPATCHER WRITES for one plan task: `on` for the plan's LAST
 * task — the independent acceptance task (`acceptanceTaskId`, its ONE
 * determination) — and `off` for every other child of an orchestration.
 *
 * This is a consumer of lib/repo-pr-policy.ts's rule, never a second copy of
 * it: "which task accepts" is answered there, and the only thing added here is
 * the rendering into the environment value. A plan with no tasks answers
 * `off` (fail-closed: nothing was authorized).
 */
export function acceptanceGateValue(plan: RepoPrPlanInput, taskId: string): "on" | "off" {
  return acceptanceTaskId(plan) === taskId ? "on" : ACCEPTANCE_GATE_OFF;
}

/* ──────────────────────────── the recorded state ─────────────────────────── */

/**
 * The lifecycle of one acceptance requirement.
 *
 * ARMED is the state a round that was never dispatched is in — it is what an
 * ABSENT record means, and a record may carry it when the gate armed the round
 * but could not dispatch it (the reason field says why).
 *
 * The last three are terminal for the CURRENT content: they stop holding
 * `declare_done` back, and HOW is `acceptanceDecision`'s rule (the only one
 * there is — the READY binds to the fingerprint, the two unconditional
 * releases do not; a dead second reading of it was deleted 2026-09-22 on the
 * user's call, quality round P1).
 */
export type AcceptanceStatus = "ARMED" | "AWAITING" | "READY" | "BLOCKED" | "SKIPPED" | "DISABLED";

const ACCEPTANCE_STATUSES: ReadonlySet<string> = new Set<AcceptanceStatus>([
  "ARMED", "AWAITING", "READY", "BLOCKED", "SKIPPED", "DISABLED",
]);

/**
 * The acceptance slot of the gate sidecar — written by the gate's own
 * conclusion recorder and by the dispatch path, never attested by an agent.
 */
export interface AcceptanceRecord {
  status: AcceptanceStatus;
  /** The judge's verdict word, when a round concluded. */
  verdict?: string;
  /**
   * The WORKTREE FINGERPRINT (lib/fingerprint.ts digest) this record binds to.
   * Same binding as the review READY: any edit — including one made through
   * bash — moves it, so a stale conclusion cannot release a changed round.
   */
  fingerprint?: string;
  at: string;
  /** The round the gate dispatched, for the wait and the record's provenance. */
  judgeId?: string;
  /** How many findings the round carried (diagnostics, like rounds[]). */
  findingsTotal?: number;
  /** Why it was skipped / why it blocks, in the words the agent reads. */
  reason?: string;
}

/**
 * Keep a record read off disk only when it is entirely usable.
 *
 * The sidecar is untrusted input (it is a repo-local file). A record whose
 * status is unknown is DROPPED rather than downgraded, and dropping is
 * fail-closed here: an absent record means "no acceptance conclusion", which
 * means the round is owed. A skipped record carrying an unknown status could
 * only ever be used to RELEASE completion, so guessing is the one direction
 * this must never take.
 */
export function sanitizeAcceptanceRecord(raw: unknown): AcceptanceRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const status = typeof r.status === "string" && ACCEPTANCE_STATUSES.has(r.status)
    ? (r.status as AcceptanceStatus)
    : undefined;
  if (status === undefined) return undefined;
  if (typeof r.at !== "string" || r.at.trim() === "") return undefined;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value : undefined;
  const findingsTotal = typeof r.findingsTotal === "number" && Number.isInteger(r.findingsTotal) && r.findingsTotal >= 0
    ? r.findingsTotal
    : undefined;
  const fingerprint = text(r.fingerprint);
  const verdict = text(r.verdict);
  const judgeId = text(r.judgeId);
  const reason = text(r.reason);
  return {
    status,
    at: r.at,
    ...(fingerprint === undefined ? {} : { fingerprint }),
    ...(verdict === undefined ? {} : { verdict }),
    ...(judgeId === undefined ? {} : { judgeId }),
    ...(reason === undefined ? {} : { reason }),
    ...(findingsTotal === undefined ? {} : { findingsTotal }),
  };
}

/* ─────────────────────────── what the gate should do ─────────────────────── */

/**
 * THE RECORD AS ONE LINE — the status surfaces' readout (`/gate-status`).
 *
 * Why it exists at all (quality round P2, 2026-09-22): a SKIPPED round is a
 * gate the USER left ON being released, and the recorded reason is the only
 * thing that says why. A record nobody renders is a decision nobody can audit;
 * the single-line widget has no room for it, the status command does.
 */
export function acceptanceStatusLine(record: AcceptanceRecord | undefined): string | undefined {
  if (record === undefined) return undefined;
  const at = record.at === "" ? "" : ` (${record.at})`;
  const reason = record.reason === undefined ? "" : ` — ${record.reason.slice(0, 160)}`;
  return `acceptance: ${record.status}${at}${reason}`;
}

/**
 * IS A ROUND DISPATCHED AND STILL OWED A VERDICT?
 *
 * The ONE reading of the record's AWAITING state, for the readers OUTSIDE the
 * decision table. The completion path needs it for a reason the table cannot
 * express: the cascade-close that abandons unrecorded judge rounds must NOT
 * reclaim the pane of a round the gate is itself waiting on. Closing it first
 * makes `acceptanceRoundAlive` answer "gone", and `acceptanceDecision`'s own
 * `roundAlive === false` rule then dispatches a second round on top of a
 * working judge — the first one is killed and paid for twice (reviewer P1,
 * 2026-09-22).
 */
export function acceptanceRoundInFlight(record: AcceptanceRecord | undefined): boolean {
  return record?.status === "AWAITING";
}

/**
 * WHY THIS ROUND WAS DISPATCHED, in one word — the decision `declare_done`
 * acts on. `skip` covers every "not owed" case (`status` says which), `pass`
 * is a READY that still binds, `wait` is a round already in flight, `block` is
 * a settled non-READY that binds, and `dispatch` is "the gate owes this round
 * a dispatch, right now".
 */
export type AcceptanceDecision =
  | { action: "skip"; status: "SKIPPED" | "DISABLED"; reason: string }
  | { action: "pass"; reason: string }
  | { action: "dispatch"; reason: string }
  | { action: "wait"; reason: string }
  | { action: "block"; reason: string };

export interface AcceptanceDecisionInput {
  /**
   * Does this round carry code? The gate's OWN fact (`GateState.hasCodeChange`,
   * set by the edit path), never a diff read here — a docs-only round has
   * nothing to run, and asking the judge to accept a README would spend a
   * top-tier model on a question with no execution behind it.
   */
  hasCodeChange: boolean;
  /** `acceptanceGateOpen(process.env)` — the environment the dispatcher wrote. */
  gateOpen: boolean;
  /**
   * The reason the GOAL declares this round has no real acceptance, WITH a
   * reason — `parseNoAcceptanceDeclaration` only returns one for a declaration
   * that carries usable text (a bare 「本轮无真实验收」 is not an exemption).
   */
  goalSkipsAcceptance?: string | undefined;
  /**
   * IS THERE A PLAN TO WORK? — `extractAcceptancePlan` over a goal that is IN
   * FORCE (`lib/loop-goal.ts`'s approval, not just the file being there).
   *
   * `false` SKIPS with a reason instead of dispatching a judge that has nothing
   * to work from: the round's whole mandate is the user-approved「真实验收方案」，
   * so with the goal stage switched OFF and no approved goal on record there is
   * no checklist to verify against — and a judge told to work a plan it does
   * not have can only answer BLOCKED, which no action of the agent could ever
   * resolve (a hold nobody can end). The reason names both ways out.
   *
   * ABSENT IS “PRESENT” on purpose: the direction that must never happen by
   * default is a silent SKIP, so an older caller that does not know this input
   * keeps dispatching (the stricter side).
   */
  hasPlan?: boolean;
  /** The CURRENT worktree fingerprint digest; `""` when it cannot be read. */
  fingerprint: string;
  /** The record the sidecar carries, if any. */
  record?: AcceptanceRecord;
  /**
   * Is the dispatched round's pane still there? `undefined` = could not tell.
   *
   * `false` re-DISPATCHES: a round whose pane is gone has no report coming,
   * and re-opening it is free — the judge's session id is deterministic, so
   * the new pane continues the SAME transcript (`dispatchJudgeRound` falls
   * through to a fresh open). Waiting instead would strand the agent on a
   * report nobody is going to write.
   */
  roundAlive?: boolean;
}

/**
 * WHETHER TO DISPATCH — the whole rule, total and pure.
 *
 * The order is the precedence: a closed gate and an approved goal clause are
 * decided BEFORE the record is read (both are statements about the round
 * itself), then "nothing to run", then the record's own state.
 *
 * An AWAITING round is WAITED, never re-dispatched: re-dispatching would
 * interrupt a judge that is working, and the content-moved case is already
 * handled where it belongs — the recorder checks the fingerprint when the
 * verdict lands and records a mismatch as BLOCKED. So the agent cannot use
 * "I edited while it ran" to slip past acceptance.
 */
export function acceptanceDecision(input: AcceptanceDecisionInput): AcceptanceDecision {
  if (!input.gateOpen) {
    return {
      action: "skip",
      status: "DISABLED",
      reason: "验收环节已关闭（本次会话由门禁标记为不验收：编排子会话默认关闭，只有 plan 的最后一个验收任务开着）—— 跳过真实验收。",
    };
  }
  if (input.goalSkipsAcceptance) {
    return {
      action: "skip",
      status: "SKIPPED",
      reason: `goal 声明「本轮无真实验收」：${input.goalSkipsAcceptance}（该声明是用户在批准 goal 时拍板的，验收 agent 无权自行豁免）—— 跳过真实验收。`,
    };
  }
  if (!input.hasCodeChange) {
    return {
      action: "skip",
      status: "SKIPPED",
      reason: "本轮没有代码改动 —— 没有可真实验收的东西，跳过验收轮。",
    };
  }
  // NO USABLE FINGERPRINT ⇒ NEVER DISPATCH (2026-09-22).
  //
  // This arm is REACHABLE, which is why it is a fix and not a guard for the
  // record: with no fingerprint the round cannot bind anything, yet the old
  // flow dispatched it, recorded the verdict as stale (BLOCKED), kept the
  // record without a fingerprint, and dispatched AGAIN on the next
  // `declare_done` — a loop with no exit that burns a top-tier model every
  // time. Three facts make it reachable, all verifiable in the tree:
  //
  //   1. `declare_done` passes `fingerprintUnavailable: false` as a LITERAL to
  //      `unmetRequirements` (extensions/review-gate.ts), so the
  //      “worktree fingerprint unavailable” problem at lib/gate-state.ts:1816
  //      is never produced from that call site;
  //   2. this module is fed `computeFingerprint(root)` (the worktree digest —
  //      an unreadable submodule, a failed `write-tree` or a sparse-checkout
  //      all make it unavailable), which is NOT the same computation as the
  //      `headCommitTree` the completion path compares;
  //   3. `unmetRequirements` returns `[]` outright while a `/gate-bypass` is
  //      active, so a bypassed session reaches this step with everything else
  //      released — including the review/precommit problems that would
  //      otherwise have stopped it first.
  //
  // FAIL-CLOSED, and the reason says what the human has to do: this is the
  // same direction the review and precommit gates take when the worktree
  // cannot be read. It deliberately does NOT release the round (a skip here
  // would silently retire the user's acceptance switch).
  if (input.fingerprint === "") {
    return {
      action: "block",
      reason: "本轮工作区指纹取不到（git 读不出这棵树）—— 验收结论无法绑定到任何内容，所以不派验收轮。" +
        "这是要人处置的一类（submodule 不可读 / sparse-checkout / 写树失败），把仓库修好后重新 declare_done。",
    };
  }
  const rec = input.record;
  /**
   * NO PLAN, NO DISPATCH — the ONE shape every “we owe this round a dispatch”
   * branch goes through (reviewer P2, 2026-09-22).
   *
   * This check used to sit in the switch's `default` alone, so a READY /
   * BLOCKED record whose fingerprint had moved — or an AWAITING round whose
   * pane died — fell through to `dispatch` while the goal was no longer in
   * force. The extension builds the round's task from `goalText ?? ""`, i.e. an
   * EMPTY checklist: a judge that can only answer BLOCKED, and no action of
   * the agent could ever resolve it — re-negotiating the goal is precisely the
   * stage the user switched off in the state that gets here.
   *
   * WHAT IT DOES NOT OVERRIDE: a settled record still decides for itself. A
   * READY bound to this content PASSES and a bound BLOCKED still blocks —
   * neither needs a new checklist, so neither is affected.
   */
  const missingPlan = (): AcceptanceDecision | undefined =>
    input.hasPlan === false
      ? {
          action: "skip",
          status: "SKIPPED",
          reason: "本轮没有用户批准的验收方案（goal 环节关闭、或 goal 尚未批准——起草中的草稿不算合同）" +
            "—— 没有可依据的清单就不派验收轮：批准一份带「真实验收方案」的 goal，或者把验收环节也关掉。",
        }
      : undefined;
  switch (rec?.status) {
    case "AWAITING":
      if (input.roundAlive === false) {
        return missingPlan() ?? {
          action: "dispatch",
          reason: "上一轮验收的 pane 已经不在了（门禁不会等一个不会来的报告）—— 重新派出验收轮（同一个 session id，transcript 继续）。",
        };
      }
      return {
        action: "wait",
        reason: "验收轮已派出、还没有交卷 —— 用 `judge_wait({role:\"acceptance\"})` 等它的结论" +
          "（report 落盘后门禁会用标准报告唤醒你）。",
      };
    case "READY":
      if (input.fingerprint !== "" && rec.fingerprint === input.fingerprint) {
        return { action: "pass", reason: "验收 READY 且绑定当前内容 —— 真实验收这一关已过。" };
      }
      return missingPlan() ?? {
        action: "dispatch",
        reason: "上一次验收 READY 绑定的内容已经不是当前内容（编辑/提交移动了指纹）—— 上一份结论作废，需要重新验收。",
      };
    case "BLOCKED":
      if (input.fingerprint !== "" && rec.fingerprint === input.fingerprint) {
        return {
          action: "block",
          reason: "验收轮判了 BLOCKED —— " + (rec.reason ?? "看它的 report 里的 findings") +
            "；按 findings 修完再走一遍审查循环（内容一改，这份结论自动失效并重新验收）。",
        };
      }
      return missingPlan() ?? {
        action: "dispatch",
        reason: "内容已经变了，上一轮的 BLOCKED 结论针对的是旧内容 —— 重新验收。",
      };
    default:
      return missingPlan() ?? {
        action: "dispatch",
        reason: "还没有绑定当前内容的验收结论 —— 门禁现在派出 acceptance 轮（真实验收）。",
      };
  }
}

/**
 * The COMPLETION-layer projection: what `declare_done`'s problem list gets.
 *
 * Only the two "not now" outcomes produce a blocking line — a dispatch is the
 * gate's own next move, and a pass/skip is nothing to report. This exists so
 * the extension writes no second judgement: it calls `acceptanceDecision`
 * once, acts on `action`, and prints this.
 */
export function acceptanceProblems(decision: AcceptanceDecision): string[] {
  return decision.action === "block" || decision.action === "wait" ? [decision.reason] : [];
}

/* ─────────────────────────────── the goal side ───────────────────────────── */

/**
 * The clause a goal uses to declare that this round has nothing to accept for
 * real. It must carry a reason — `<…>`-style blanks do not count, and a bare
 * clause without one is NOT an exemption (see the parser).
 */
export const NO_ACCEPTANCE_CLAUSE = "本轮无真实验收";

/**
 * The decoration a goal line may carry BEFORE its first real token.
 *
 * The skeleton writes plain lines, but a draft is free to format them — a
 * markdown heading, a bullet, an ordered item, a bolded opener — and both
 * parsers below must see THROUGH that without ever seeing past a mention of
 * the phrase. One helper, so "what opens the line" is answered the same way
 * for the clause and for the section heading.
 */
function stripLinePrefix(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    // A bullet must be followed by SPACE, or the `*` of `**bold**` would be
    // eaten and the bold wrapper below would never match.
    .replace(/^(?:[-*•]\s+|\d+[.)]\s+|[（(]\d+[）)]\s*)/, "")
    .replace(/^\*\*(.+?)\*\*/, "$1")
    .replace(/^__(.+?)__/, "$1")
    .trim();
}

/**
 * Read the goal's "no real acceptance this round" declaration, if it has one.
 *
 * ONLY A LINE THAT OPENS WITH THE CLAUSE COUNTS (2026-09-22, quality round
 * P1). The first version looked for the substring anywhere on the line, and
 * that made every MENTION of it a declaration: the goal skeleton itself says
 * 「就写「本轮无真实验收（理由）」」 inside the section heading, and any goal that
 * describes this very rule carries the phrase in its prose — measured on this
 * round's own goal, which parsed as a SKIP because it explains the exemption.
 * Leading decoration is stripped; everything else must be the clause itself.
 *
 * A PLACEHOLDER IS NOT A REASON either: the skeleton's `（理由）` / `<理由>` is
 * a blank to fill in, and a draft that submits it unfilled must not skip the
 * round by accident. Fail-closed in both directions — an unreadable
 * declaration means the round is still owed, which costs a dispatch, never a
 * release.
 */
export function parseNoAcceptanceDeclaration(goalText: string): { reason: string } | undefined {
  for (const line of goalText.split("\n")) {
    const stripped = stripLinePrefix(line);
    if (!stripped.startsWith(NO_ACCEPTANCE_CLAUSE)) continue;
    let tail = stripped.slice(NO_ACCEPTANCE_CLAUSE.length).trim();
    // 「（理由）：<文本>」 is the form the skeleton TEACHES, so the wrapper is one
    // unit: the optional paren, the optional 「理由」, its closing paren and a
    // following colon all come off together. Peeling them one at a time left
    // the 「）：」 stuck to the reason, and that string is shown to the user in
    // the approval box and recorded in the SKIPPED note.
    tail = tail
      .replace(/^[（(【\[「]?\s*(?:理由\s*)?[）)】\]」]?\s*[:：]?\s*/, "")
      .replace(/[）)】\]」]\s*$/, "")
      .trim();
    // 两个字符以下不构成理由（「无」「-」这类占位）；「理由」/「reason」与
    // 骨架里的 `<…>` 空白也是占位，不是理由。
    if (tail.length < 2) continue;
    if (/^(?:理由|reason|why|说明)$/i.test(tail)) continue;
    if (/^<.+>$/.test(tail)) continue;
    return { reason: tail };
  }
  return undefined;
}

/** The heading that opens the goal's real-acceptance plan. */
export const ACCEPTANCE_PLAN_HEADING = "真实验收方案";

/** Leading whitespace of one goal line — what tells a sub-head from a section. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Is this line the start of another TOP-LEVEL section of the goal?
 *
 * IT MUST NOT BE INDENTED DEEPER THAN THE SECTION THAT IS OPEN (reviewer P2,
 * 2026-09-22). The matcher used to accept ANY colon-terminated line, and the
 * goal skeleton's own acceptance plan is a list of them: a goal that writes
 * 「  - 正向真实调用：」 and puts the content on the NEXT line closed the section
 * at its own first bullet, so `extractAcceptancePlan` returned undefined and
 * the acceptance judge was handed no plan at all. A nested item is indented
 * DEEPER than the heading that opened the section — that is what makes it
 * nested — so the depth is the discriminator, and `#`-headings are held to it
 * too (a `### 正向真实调用` inside the section is content, not a new section).
 */
function isSectionHeading(line: string, sectionIndent: number): boolean {
  const t = line.trim();
  if (t === "") return false;
  if (indentOf(line) > sectionIndent) return false;
  return t.startsWith("#") || t.endsWith("：") || t.endsWith(":");
}

/**
 * The goal's real-acceptance plan — the section the judge works through.
 *
 * THE SECTION IS FOUND BY ITS OPENING LINE, not by the first mention of the
 * phrase (2026-09-22, quality round P1): a goal whose criteria say
 * 「`LOOP_GOAL_SKELETON` 含「真实验收方案」段」 mentions it long before the section
 * exists, and a substring search handed the judge that criteria text as if it
 * were the plan. Leading bullets and numbers are stripped so a nested section
 * still opens; `undefined` means the goal has no such section (an older goal,
 * or one that declared no acceptance). The section is handed over verbatim:
 * it is agent-authored text and travels as UNTRUSTED DATA in the task, but it
 * is also the USER-APPROVED checklist, so nothing here may summarize it.
 */
export function extractAcceptancePlan(goalText: string): string | undefined {
  const lines = goalText.split("\n");
  const start = lines.findIndex((line) => stripLinePrefix(line).startsWith(ACCEPTANCE_PLAN_HEADING));
  if (start < 0) return undefined;
  // The section's OWN depth, so a nested sub-head cannot close it (below).
  const sectionIndent = indentOf(lines[start]!);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (isSectionHeading(line, sectionIndent)) break;
    body.push(line);
  }
  const text = body.join("\n");
  // Verbatim: the first line's indentation is part of what the agent wrote,
  // so only the tail is trimmed — and an empty section is `undefined` rather
  // than an empty plan a judge would try to work from.
  return text.trim() === "" ? undefined : text.replace(/\s+$/, "");
}

/* ────────────────────────── the dispatched round's task ──────────────────── */

/** Everything the acceptance round is handed. */
export interface AcceptanceTaskInput {
  /** Absolute repo root — the judge runs in this checkout. */
  repoRoot: string;
  /** The FULL approved goal text (the acceptance plan is extracted from it). */
  goalText: string;
  /** The immutable range this round's content lives in (`baseline..HEAD`). */
  range?: string;
  /** The files the round changed, when the gate knows them. */
  files?: readonly string[];
}

/**
 * THE ACCEPTANCE ROUND'S TASK — gate instructions first, agent text last.
 *
 * Same shape as every other judge task (`composeWithUntrustedData`), and the
 * same reason: the goal is agent-authored text the judge must not obey, while
 * the four lines above it are the gate's own contract. What is DIFFERENT is
 * what it carries — the goal's real-acceptance plan and this round's range,
 * because this judge verifies by RUNNING, and "what to run" lives in the goal.
 */
export function buildAcceptanceTask(input: AcceptanceTaskInput): string {
  const plan = extractAcceptancePlan(input.goalText);
  const range = input.range?.trim();
  const files = (input.files ?? []).filter((f) => f.trim() !== "");
  const instructions = [
    "You are acceptance — the gate dispatched this round at task COMPLETION, and your job is defined in your role file:",
    "verify the work on the REAL system. The plan in the data block below is the loop goal's own acceptance plan — work it.",
    "Bring the changed thing up for real, call what the change was for, compare the returned data, then re-check the",
    "neighbouring paths the change could have broken. Reading the code and concluding \"this would work\" is the failure",
    "mode you exist to catch.",
    "No real execution evidence ⇒ you may NOT conclude READY. If real acceptance is impossible in this environment,",
    "report that as the finding and conclude BLOCKED — never exempt yourself.",
    `You run in ${input.repoRoot} — work in that checkout, and report your own \`pwd\` as \`cwd\` (required field).`,
    JUDGE_COMPLETION_DISCIPLINE,
  ].join("\n");
  return composeWithUntrustedData(instructions, [
    ...(plan === undefined
      ? []
      : [{ tag: "acceptance_plan", label: `===== goal 的「${ACCEPTANCE_PLAN_HEADING}」段（你按它验收） =====`, text: plan }]),
    {
      tag: "goal_text",
      label: "===== 本轮 loop goal 全文（退出条约，验收判据的出处） =====",
      text: input.goalText,
    },
    ...(range === undefined || range === ""
      ? []
      : [
          {
            tag: "round_range",
            label: "===== 本轮范围（baseline..HEAD） =====",
            text: `${range}${files.length ? `\n改动文件：\n${files.map((f) => `- ${f}`).join("\n")}` : ""}`,
          },
        ]),
  ]);
}
