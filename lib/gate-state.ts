/**
 * Gate state machine.
 *
 * State lives in TWO places, deliberately:
 *  1. Session entries via `pi.appendEntry()` — survives context compaction
 *     (PR #7 lesson 7: needed [AUTO_LOOP_RESUME] stdout re-injection
 *     because transcript state died on compact; Pi session entries are
 *     excluded from LLM context and survive compaction natively).
 *  2. A sidecar JSON file `.pi/review-gate-state.json` — so the installed
 *     git pre-commit / pre-push hooks (defense-in-depth layer) can verify the
 *     gate without talking to Pi at all.
 *
 * Fail-closed rules:
 *  - A pass is bound to a worktree fingerprint. Fingerprint mismatch = not passed.
 *  - Unreadable/corrupt sidecar = not passed.
 *  - "No checks run" (precommit NO_CHECKS_RUN) = not passed (PR #7 lesson 3).
 */

import type { TaskMode, TaskModeSource } from "./task-mode.ts";
import { FINGERPRINT_VERSION } from "./fingerprint.ts";
import type { CopilotReviewState } from "./copilot-review.ts";
import type { AcceptanceRecord } from "./acceptance-round.ts";
import type { LoopStagesRecord } from "./loop-stages.ts";
import type { RestatementRecord } from "./restatement.ts";
import type { ShipCommandKind } from "./constants.ts";

import type { GoalPrereviewRecord, LoopGoalConfirmation } from "./loop-goal.ts";
import type { QualityRecord } from "./quality-round.ts";
import type { PlanAuditRecord } from "./orchestrator-plan-audit.ts";
import type {
  CheckpointRecord,
  CompletionRecord,
  LastReviewedTree,
  PendingReadyReview,
  PrecommitBinding,
  ProxyDecisionRecord,
  ReviewBinding,
  RoundRecord,
} from "./gate-state-records.ts";

export interface GateState {
  schema: 1;
  /**
   * Algorithm version of the digests in `review.fingerprint` /
   * `precommit.fingerprint` (see FINGERPRINT_VERSION). Optional because
   * sidecars written before versioning have none — those are treated as v1 and
   * their bindings are invalidated on load, never reinterpreted.
   *
   * This is deliberately NOT the `schema` field: the sidecar SHAPE is
   * unchanged, so bumping `schema` would make older hooks reject the file
   * outright ("unknown gate schema") instead of reporting a migration.
   */
  fingerprintVersion?: number;
  sessionId: string | null;
  /**
   * Set when ANOTHER live session holds this worktree — the refusal text,
   * verbatim (lib/session-exclusivity.ts decides it).
   *
   * IN MEMORY ONLY, and that is load-bearing rather than tidy: a refused
   * session must not write this worktree's sidecar at all — the file belongs
   * to the session that holds it, and persisting a refusal into it would tell
   * the HOLDER that its own worktree is taken. `saveSidecar` strips the field
   * as a second line of defence.
   *
   * It lives on the state, rather than beside it, because that is what reaches
   * `unmetRequirements` — the one authority every ship path already shares.
   */
  exclusivityRefusal?: string;

  /**
   * The last review_checkpoint commit (sha + wall-clock time). The review
   * unit of the new execution model: prepare_review computes baseline..HEAD
   * against this, and the verdict recorder binds a READY to the reviewed commit's
   * tree. Written only by review_checkpoint; absent before the first one.
   */
  checkpoint?: CheckpointRecord;

  /**
   * The COMPLETION record — `declare_done` was accepted (R3-5).
   *
   * It exists because a supervisor could not tell a finished child from a
   * running one: the orchestration probe was reduced to reading the child's
   * TERMINAL, where "Working" printed an hour ago still matched, and a child
   * that had merged its branch and closed every gate produced no signal for
   * 725 seconds. The gate already knew — it had just accepted the completion
   * — and wrote that fact nowhere. Now it does, in the child's own sidecar,
   * which the orchestrator reads through `childGateState`.
   *
   * Written on ACCEPTANCE only (a rejected `declare_done` records nothing),
   * and never cleared by the loop reset below it: "this task was completed at
   * T" stays true even when the session goes on to do something else.
   */
  completion?: CompletionRecord;
  hasCodeChange: boolean;
  hasDocChange: boolean;
  review: ReviewBinding;
  /**
   * THE QUALITY ROUND's standing verdict (2026-09-15, user requirement).
   *
   * The quality judge runs BETWEEN `prepare` and the functional reviewer, and
   * `lib/quality-round.ts`'s `qualityStandingFor` is the ONE reader that
   * decides whether the reviewer may be dispatched: a READY bound to the
   * current HEAD, or a recorded SKIP (nothing but docs/data changed) —
   * everything else, including an absent record, fails closed.
   *
   * Absent is NORMAL, not an error: the whole point is that a session which
   * never ran a quality round cannot reach the reviewer. Nothing but a
   * finished quality round writes it, and `invalidateBindings` clears a READY
   * the moment the session edits — the content it judged is gone.
   */
  quality?: QualityRecord;
  /**
   * The READY the gate is holding until its verification lands (2026-09-15).
   *
   * Absent is the normal state: it exists only in the window between a
   * reviewer concluding faster than its full lane and that lane landing. While
   * it is set, `review` stays PENDING — nothing ships on a verdict that has
   * not been made yet.
   */
  pendingReady?: PendingReadyReview;
  /**
   * The last READY review's git tree and the files it covered.
   *
   * Kept OUTSIDE `review` on purpose: `review` is replaced wholesale by every
   * verdict, so a single BLOCKED round would erase the very baseline the next
   * round needs. This survives until a new READY replaces it.
   *
   * DIAGNOSTIC INPUT ONLY — it feeds the incremental-review scope
   * (lib/review-scope.ts) and never the ship decision, which stays bound to
   * `review.fingerprint` alone. `review.fingerprint` cannot serve this role:
   * it mixes submodule digests in, so it is not a git object and cannot be
   * diffed. Absent ⇒ the next round is a full review (fail-safe).
   */
  /**
   * Worktree tree OID at the last `prepare_adviser` call for this repo, keyed
   * by goal hash.
   *
   * Lets the NEXT adviser consultation of the SAME goal be told what changed
   * since the previous one (goal criterion 3: incremental advisory), without
   * a consultation of a DIFFERENT goal overwriting the baseline. It is
   * DIAGNOSTIC INPUT only, like `lastReviewedTree` — it never feeds the ship
   * decision. Absent ⇒ the next consultation gets an empty changed-files
   * list and treats the previous conclusion as still standing.
   */
  /**
   * Per-goal advisory baseline: the worktree tree the changed-files list of
   * the NEXT consultation is computed against. `tree` is the tree at the
   * last consultation START (optimistic); `prevTree` is the last CONFIRMED
   * consultation start (rollback target — a consultation that never appended
   * a conclusion must not hide its changes, round-3 P1) or null when NO
   * consultation is confirmed yet (cross-session first advance: the old
   * artifact's conclusions are NOT proof the current one succeeded — the
   * next round then falls back to a full re-check, round-4 P1); `confirmed`
   * is the number of valid conclusions the artifact held when the baseline
   * last advanced.
   */
  adviserBaselines?: Record<string, { tree: string; prevTree: string | null; confirmed: number }>;
  /**
   * THE LAST TREE A REVIEW ROUND CONCLUDED ABOUT (2026-09-19), and the verdict
   * it concluded WITH.
   *
   * This was `lastReadyReview`, written on READY alone — so a round that
   * concluded BLOCKED left no trace of what it had read, and the next
   * `prepare_review` fell back to the branch base and re-reviewed the entire
   * branch. Measured in prime on 2026-09-19: t1-prime-encrypt ran three full
   * deep reviews back to back (15 + 15 + 6 minutes) over the same 65-file
   * diff, because its very first round concluded BLOCKED and the field stayed
   * empty.
   *
   * TWO CONSUMERS, TWO DIFFERENT QUESTIONS — which is why the verdict rides
   * along instead of the field being split in two:
   *   - `reviewScopeFor` asks "what has this session already READ?" — any
   *     concluded round answers that, and `lib/review-scope.ts`'s own
   *     `unreviewedFiles` escalation still forces a FULL round whenever the
   *     increment touches a file the previous round never saw;
   *   - `settledConclusion` asks "what has this session CONFIRMED?" — only a
   *     READY answers that. Handing a BLOCKED tree to the next reviewer as
   *     settled would tell it to skip precisely the content the previous
   *     round refused.
   *
   * The RANGE baseline is untouched by this field: `st.review.commitSha` still
   * moves only when the quality half concluded (`qualityStandingFor`), so a
   * round whose quality judge was cancelled keeps its content inside every
   * later range. Only the DEPTH of the next round reads this tree.
   *
   * DIAGNOSTIC INPUT otherwise, like `adviserBaselines` — it never feeds the
   * ship decision.
   */
  lastReviewedTree?: LastReviewedTree;
  /**
   * EVERY DECISION THE PROXY MADE ON THE USER'S BEHALF (2026-09-19), oldest
   * first.
   *
   * The user leaves, and the gate's dialogs used to wait forever — a session
   * parked on a plan decision, another on a goal approval, with the machine
   * idle. Now a dialog that goes unanswered for `PROXY_ANSWER_TIMEOUT_MS` is
   * handed to `arbiter`, which reads the session's own context and takes the
   * user's place (lib/user-proxy.ts).
   *
   * THIS RECORD IS THE WHOLE SAFETY STORY. Downstream, a stand-in's answer is
   * indistinguishable from the user's own — it opens exactly the same doors
   * (`request_sensitive_edit`, `/gate-bypass`, a goal approval). The only thing
   * that keeps that honest is that the user can SEE it, so two rules follow and
   * both are implemented:
   *   - `declare_done` prints this list mechanically in the completion report;
   *     the user must never have to wonder which decisions were theirs;
   *   - each entry carries enough to re-run the step (question, rows, choice,
   *     reason), so overturning one is re-asking — never undoing.
   *
   * DIAGNOSTIC otherwise: it never feeds the ship decision. A tampered record
   * could only HIDE a proxy decision, which is why nothing here authorizes
   * anything — the answers took effect when they were given.
   */
  proxyDecisions?: ProxyDecisionRecord[];
  precommit: PrecommitBinding;
  rounds: RoundRecord[];
  /**
   * How many reviewer rounds THIS SESSION HAS SENT OUT (2026-09-17, user
   * decision): the strip's `轮 N` reading, and nothing else.
   *
   * WHY IT IS SEPARATE FROM `rounds` ABOVE. `rounds` holds RECORDED verdicts
   * and drives the convergence checks (oscillation / plateau) and the
   * `maxRounds` brake — so it can only move when a judge finishes, which made
   * the strip sit still for the entire duration of every round and read as
   * broken. This one moves the moment a round is SUBMITTED, and deliberately
   * survives `declare_done` (the session's reviewing activity is a fact about
   * the session, not about one task).
   *
   * Incremented once per SUCCESSFUL reviewer dispatch in `judge_submit` —
   * never for a failed one, and never for the adviser / goal-auditor / quality
   * rounds (those are not review rounds the user asked for). Absent on older
   * sidecars ⇒ zero rounds sent.
   */
  sentReviewRounds?: number;
  /**
   * The last polish-gate `reason` the agent supplied to prepare_review
   * (round-18). Injected into the NEXT reviewer's task text so the judge can
   * see why this round exists. Absent on older sidecars ⇒ no reason to
   * carry forward (and no trigger either — the rounds are the trigger).
   */
  lastPolishReason?: { reason: string; at: string; round: number };
  maxRounds: number;
  bypass: {
    active: boolean;
    reason: string | null;
    at: string | null;
  };
  /** Session-level workflow choice. Absent means not chosen yet; consumers
   * must fail closed by treating it as loop until the user decides. */
  taskMode?: TaskMode;
  /**
   * Who chose taskMode. SECURITY: the git pre-commit hook downgrades to
   * advisory ONLY for a user-chosen explore/normal ("user" — confirmed
   * dialog or /gate-mode); an agent/auto selection ("auto") never weakens
   * the hook. Absent ⇒ treated as "auto" (fail-closed — older sidecars keep
   * the full gate).
   */
  taskModeSource?: TaskModeSource;
  /**
   * The orchestration this session runs, when it is an orchestrator
   * (lib/orchestrator-registry.ts). Holds the child registry, the user's plan
   * approval and the notification throttle — everything that has to survive a
   * turn boundary and be readable by a relay successor.
   *
   * Optional: an ordinary loop session never writes it, and older sidecars
   * simply have none.
   */
  orchestrator?: import("./orchestrator-registry.ts").OrchestratorRuntime;
  /**
   * sd0x-dev-flow R10 ("Think Harder") port: whether the one-shot strategic
   * reset checklist has fired for this state lifetime. Optional so schema-1
   * sidecars written by older versions still validate; absent ⇒ not fired.
   */
  strategicResetFired?: boolean;
  /**
   * The loop pause an `ask_user` interview leaves behind: something the user
   * has not answered yet, so L2 auto-continuation is
   * paused until the user's next interactive message. This NEVER affects the
   * ship gate — unmetRequirements() ignores it entirely; a paused loop still
   * blocks git commit/push and gh pr. Persisted so the pause survives a
   * restart while waiting for the user. Absent ⇒ not paused.
   */
  pausedQuestion?: {
    question: string;
    at: string;
  };
  /**
   * The last `ask_user` interview: what was asked and what came back, kept so
   * the Q&A survives the dialogs that carried it (they leave no transcript of
   * their own) and an interrupted interview stays inspectable. Diagnostic
   * only — no enforcement path reads it.
   */
  askUser?: {
    at: string;
    answers: import("./ask-user.ts").AskAnswer[];
  };
  /**
   * What the notification throttle remembers: when this session last raised a
   * banner, and the exact text of the last few (lib/user-notify.ts).
   *
   * PER SESSION, not per orchestration (2026-09-17): a standalone loop session
   * notifies too, and a history only the orchestrator runtime carried would
   * let one of them become a pager storm while the other stayed silent.
   * Absent ⇒ nothing sent yet, which can only ever mean one extra banner.
   */
  notify?: import("./user-notify.ts").NotifyHistory;
  /**
   * The user's authorization to run tmux commands from bash (user decision,
   * 2026-09-17).
   *
   * `session` covers this session AND the `session_handoff` successor it may
   * name — the user's words were “当前会话和他的继承者”, and this rides the same
   * inheritance path as every other confirmed record. `once` is consumed by the
   * first tmux command that goes through.
   *
   * NOT inherited by `orchestrator_attach`: a takeover is a different session
   * taking over an address, not a continuation of this one's judgement, and
   * the same line already governs the plan approval and the goal contract.
   */
  tmuxAccess?: { at: string; scope: "session" | "once" };
  /**
   * THE ONE TMUX SESSION THIS SESSION CREATED FOR ITS CHILDREN (2026-09-25).
   *
   * Written the first time a child is opened (lib/session-tmux-scope.ts) and
   * read back by every later open AND by `declare_done`, which closes it. It is
   * a RECORD, not a permission: the name is derived from this session's own
   * identity, the session carries a marker (`@rg_scope_owner`) written at
   * creation, and the kill proceeds only when the marker matches this record.
   *
   * NOT inherited by a handoff successor: a relay keeps the old layout (user
   * decision, 2026-09-25 — the successor opens beside its predecessor in the
   * user's window), and the successor's own children belong to the successor's
   * own session.
   */
  tmuxScope?: import("./session-tmux-scope.ts").TmuxScopeRecord;
  /**
   * A-class text appeals (lib/text-appeal.ts): how many were spent (a quota
   * SHARED with `gh pr edit` arbitration), which contents were already
   * decided (so a refused text cannot be re-rolled), and the single live
   * content-bound pass, if one was granted.
   *
   * Persisted because all three are anti-abuse facts: an in-memory quota
   * would reset on every restart, and a refused text could be appealed again
   * by killing the session. Absent ⇒ nothing appealed yet.
   */
  appeals?: import("./text-appeal.ts").AppealRecord;
  /**
   * USER-GRANTED review-scope limit: the user confirmed via an
   * extension-rendered dialog (request_scope_limit tool) that the gate only needs to cover
   * THIS session's own edits — pre-existing worktree/branch changes stop
   * arming it. `preexistingFiles` snapshots the changed files exempted at
   * grant time, so every re-arm path (session_start P0-2, bash git re-arm,
   * turn_end reconciliation) exempts exactly those files — and a file this
   * session later edits is RECLAIMED (removed) from the snapshot by the edit
   * handler: the grant never covers the session's own work.
   * Branch commits are exempt for as long as the grant stands — a new
   * commit under a standing grant is either the exempted pre-existing work
   * being shipped (exactly what the user consented to) or a user/bypass
   * action; the session's own NEW edits re-arm the gate before any further
   * agent commit. `sessionFiles` records what this session edited (the scope
   * shown to the reviewer) and grows with each edit. This never
   * fabricates a verdict: narrowing the fence only changes what ARMS the
   * gate — the session's own edits still require READY + PASS. Absent ⇒
   * full-scope gate (fail-closed).
   */
  scopeLimit?: {
    preexistingFiles: string[];
    sessionFiles: string[];
    at: string;
  };
  /**
   * Repo-relative paths of the files THIS session actually edited
   * (successful edit-tool results only). Persisted so a same-session process
   * restart keeps the session's edit attribution — without it, a restart
   * would re-label the session's own edits as "pre-existing" and offer them
   * for a scope-limit exemption. The ship authority (unmetRequirements)
   * never reads it; absent on older sidecars ⇒ no attribution, and the
   * scope hints stay conservative.
   */
  sessionEditedFiles?: string[];
  /**
   * L7: the post-PR Copilot code-review cycle for THIS repo (see
   * lib/copilot-review.ts). Written by the trusted copilot tools and by the
   * arming path that watches successful PR ships.
   *
   * Deliberately NOT read by {@link unmetRequirements}: fixing a Copilot
   * finding requires a commit and a push, so a Copilot requirement inside the
   * ship authority would block its own remedy. It gates task COMPLETION
   * (declare_done + the L2 continuation) instead. Absent ⇒ no cycle is open.
   */
  copilot?: CopilotReviewState;
  /**
   * L9: the REAL-ACCEPTANCE round — the sixth judge, dispatched by the GATE
   * from `declare_done` itself (2026-09-22, user decision; lib/acceptance-round.ts).
   *
   * Written by the gate's own dispatch path (AWAITING) and by its conclusion
   * recorder (READY / BLOCKED), plus the two terminal releases that need no
   * judge (SKIPPED: this round has no real acceptance; DISABLED: the gate is
   * off for this session). Its READY binds to the WORKTREE FINGERPRINT, the
   * same binding the review READY carries — the round ran against that
   * content, so any edit invalidates it.
   *
   * Deliberately NOT read by {@link unmetRequirements}, for the same measured
   * reason {@link copilot} is not: fixing an acceptance finding requires a
   * commit, so an acceptance requirement inside the ship authority would block
   * its own remedy. It gates task COMPLETION instead (declare_done). Absent ⇒
   * no acceptance conclusion: the round is owed (fail-closed).
   */
  acceptance?: AcceptanceRecord;
  /**
   * THE FIVE STAGE SWITCHES the USER chose for this session (2026-09-22;
   * lib/loop-stages.ts owns the rule and the dialog). Absent ⇒ all five are on,
   * which is exactly today's behaviour — an older sidecar and a session that
   * never opened the box behave identically.
   *
   * IT IS THE ONE READ FOR {@link unmetRequirements}'s review/precommit halves:
   * the git hooks read the same record out of this same sidecar, so the L1 ship
   * gate and the L3 hook can never disagree about whether a stage is off.
   */
  stages?: LoopStagesRecord;
  /**
   * L8: the user's approval of the CURRENT loop-goal text (hash + time,
   * written only by propose_loop_goal after an extension-rendered dialog).
   *
   * Absent ⇒ the goal is a draft: its body is withheld from the prompt and
   * loop-mode ships are blocked at L1. Like {@link copilot} it stays out of
   * {@link unmetRequirements}, so the git hooks (which cannot see a dialog)
   * keep judging code facts only.
   */
  loopGoal?: LoopGoalConfirmation;
  /**
   * L8b: the goal-auditor PRE-REVIEW of the current draft (hash + verdict +
   * time, written only by the gate's own audit recorder from the auditor's
   * structured conclusion — never an agent-attested boolean).
   *
   * Absent ⇒ the draft was never audited: propose_loop_goal refuses to show
   * the approval dialog. Like {@link loopGoal} it stays out of
   * {@link unmetRequirements} — the git hooks cannot show a dialog, so a
   * pre-review requirement there could never be unblocked.
   */
  goalPrereview?: GoalPrereviewRecord;
  /**
   * The PLAN pre-audit — `goalPrereview`'s twin for the orchestration layer
   * (round-4 §7), written only by the gate after it read the auditor's
   * structured conclusion inside `orchestrator_plan`'s submit.
   *
   * Absent ⇒ this plan was never audited, and `submit` shows no dialog. It
   * binds to the plan's CANONICAL text (tasks, repos, dependencies,
   * parallelism), so executing the plan — which rewrites statuses constantly
   * — never invalidates it, while moving a task to another repo always does.
   */
  planAudit?: PlanAuditRecord;

  /**
   * L8b audit HISTORY (goal criterion 2): every goal-auditor audit ever
   * recorded, PASS or FAIL, oldest first — `goalPrereview` above is only the
   * latest record. Persisted so a re-audit chain is inspectable (and the
   * per-draft carryover data survives) even after newer drafts replaced the
   * singular record.
   */
  goalPrereviewHistory?: GoalPrereviewRecord[];
  /**
   * Audits of the CURRENT goal (B2), counted by the gate so the agent never
   * has to. It counts the lineage being negotiated right now — every revision
   * of one draft — and resets when that negotiation ends (a goal the user
   * approved) or when a new session starts negotiating. It is deliberately
   * NOT `goalPrereviewHistory.length`: that history is append-only across
   * every goal the repo ever had, so it would announce "round 22" on the
   * third audit of today's draft.
   */
  goalAuditRound?: number;
  /** P-multi: repo roots (other than the session repo) this session edited,
  /**
   * 2026-09-17 (user decision): consecutive agent turns in loop mode WITHOUT an
   * approved loop goal. Counted in `agent_settled` (aborted/explore/normal/
   * orchestrator turns excluded), persisted so a restart or resume continues the
   * count instead of letting the agent reset the clock by re-spawning. Cleared
   * when the goal is approved. At `GOAL_FORCE_NEGOTIATE_TURN_THRESHOLD` the gate
   * starts injecting the force-negotiate directive.
   */
  turnsWithoutGoal?: number;
  /**
   * The user-confirmed REQUIREMENT RESTATEMENT for this repo (2026-09-06):
   * what the session said the requirement is, plus the delivery station the
   * user agreed this round stops at (lib/restatement.ts).
   *
   * Absent ⇒ nothing was restated: `propose_loop_goal` and
   * `orchestrator_plan({action:"submit"})` refuse WITHOUT rendering a dialog.
   * Like {@link loopGoal} it stays out of {@link unmetRequirements} — the git
   * hooks cannot show a dialog, so a requirement they could never unblock has
   * no business arming them. It deliberately OUTLIVES the drafts that follow
   * it (a rejected goal does not mean the requirement changed); a fresh
   * `propose_restatement` overwrites it.
   */
  restatement?: RestatementRecord;
  /**
   * SHIP KINDS THE GATE WATCHED SUCCEED in this repo (2026-09-06).
   *
   * Written on the `tool_result` of a bash call that carried a ship command
   * and did NOT fail — so it says "the gate saw `gh pr create` exit 0 here",
   * which is as close to "a PR exists" as a purely local check can get. It is
   * never written from a parameter, so it cannot be attested by the agent.
   *
   * The delivery station's ARRIVAL check reads it (lib/delivery-station.ts),
   * as ONE of three evidences — the FREE one, so it is consulted before the
   * gate spends a network round trip. On its own it is not enough, and used to
   * be the whole check (the bug fixed 2026-09-16): a round that appends to an
   * ALREADY open PR never produces one, because `gh` reports "already exists"
   * as an ERROR — which is why the third evidence exists
   * (lib/station-pr-evidence.ts).
   *
   * Absent / unknown entries are dropped by the loader: this is evidence, and
   * unreadable evidence is no evidence (the arrival then blocks, which is the
   * safe direction).
   */
  shippedKinds?: ShipCommandKind[];

  /** P-multi: repo roots (other than the session repo) this session edited,
   *  persisted so a same-session resume re-arms declare_done against all of
   *  them. Ship enforcement never reads it; absence just narrows the
   *  declare_done scope to the session repo (tighten-only). */
  sessionReposPaths?: string[];
  updatedAt: string;
}

export function emptyState(sessionId: string | null, maxRounds: number): GateState {
  return {
    schema: 1,
    fingerprintVersion: FINGERPRINT_VERSION,
    sessionId,
    hasCodeChange: false,
    hasDocChange: false,
    review: { verdict: "PENDING", fingerprint: null, at: null },
    precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
    rounds: [],
    maxRounds,
    bypass: { active: false, reason: null, at: null },
    updatedAt: new Date().toISOString(),
  };
}
