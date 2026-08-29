/**
 * Session gate-mode model — decided IN-SESSION, with strict up/down rules.
 *
 * MODES (strictness order: normal < explore < loop < orchestrator)
 *  - "orchestrator": the PROJECT-MANAGER layer — everything loop enforces,
 *               plus the orchestration constraints: this session may not
 *               write code at all (only its plan and handoff docs), it must
 *               have a plan the USER approved before it may spawn a child
 *               session, and declare_done additionally requires an empty
 *               task queue, no live children and no unreported user
 *               decisions. It requires tmux (its children are panes in the
 *               user's own window). See lib/orchestrator-*.ts.
 *  - "loop":    the full enforced workflow — review READY + precommit PASS
 *               gate every ship, and auto-continuation keeps the agent in the
 *               fix→review loop until gates pass.
 *  - "explore": investigation/troubleshooting workflow. The ONLY essential
 *               difference from loop: the agent may end the task on its own
 *               judgment (declare_done always accepted, no auto-continuation).
 *               Edits and bash stay available — the system prompt merely asks
 *               the agent to prefer read-only work — and agent-initiated ship
 *               commands (git commit/push, gh pr) remain FULLY gated by L1.
 *  - "normal":  the extension steps aside — no workflow prompt injection, no
 *               ship blocking, no auto-continuation, no LLM guard calls
 *               (the output-language directive and the sensitive-file guard
 *               stay: they are user policy / a security floor, not workflow).
 *               For non-dev, non-research tasks where speed matters most.
 *
 * WHO DECIDES — the session's own agent (set_gate_mode tool) or the user
 * (/gate-mode). While the mode is undecided the gate behaves as loop
 * (fail-closed) and the per-turn system prompt instructs the agent to call
 * set_gate_mode as its FIRST action, before the session's work starts. The
 * agent's own pick IS the first classification: no external classifier model
 * is consulted for the mode (deliberately — the extra round-trip bought
 * nothing the rule engine below does not already bound, and the agent has
 * far more context than a three-line prompt). What keeps that safe is the
 * asymmetry the engine enforces: the agent may pick itself INTO the enforced
 * modes (loop, explore) but cannot pick itself OUT of the gate — a first
 * "normal" (total shutdown) still needs the user's confirmation dialog, so no
 * injected instruction can silently switch the gate off.
 * evaluateModeChange() is the single pure authority on what a requested
 * change may do:
 *
 *  - UPGRADES (toward loop) apply immediately — tightening never needs
 *    consent — except in a /tmp session, where the agent cannot enter
 *    loop at all (first classification is remapped; later upgrades reject).
 *    Agent-applied modes record source "auto".
 *  - DOWNGRADES (toward normal) require the USER's explicit confirmation via
 *    a dialog the EXTENSION renders (the tool deliberately has no "confirmed"
 *    parameter — consent cannot be claimed by the caller). A confirmed
 *    downgrade records source "user"; a declined one LOCKS agent-initiated
 *    downgrades for the rest of the session so a prompt-injected agent
 *    cannot grind the user down with repeated dialogs.
 *  - The UNDECIDED state behaves as loop, so undecided→explore counts as an
 *    initial classification only while THIS session has made NO edits of
 *    its own; once the session edits (code or doc) it is a real downgrade
 *    (confirmation required) — otherwise an agent could edit under loop
 *    rules, then slip out of the review loop by "classifying" the session
 *    as explore. Pre-existing worktree/branch changes from before the
 *    session arm the ship gate (state.hasCodeChange) but do NOT block the
 *    consent-free first classification.
 *  - The FIRST decision (undecided → mode) is consent-free only in the
 *    tightening or gate-neutral directions: loop always, explore while THIS
 *    session is clean. A first "normal" is a full gate shutdown and takes the
 *    normal consent path. Agent-applied modes record source "auto" so the git
 *    hooks stay fully enforced either way.
 *  - USER REQUIREMENT (scratch sessions): a session started in /tmp (see
 *    lib/pi-self.ts) NEVER enters loop via the agent. The first classification
 *    applies explore (investigation) or normal (local pi-config work / chores)
 *    automatically via piSelfTask — bounded to a clean, interactive, unlocked
 *    session. A requested "loop" is clamped to normal on first classification
 *    and rejected later; only the user can force loop with /gate-mode. This is
 *    the one case where a consent-free "normal" is allowed, and it is safe
 *    because the clamp is driven by the deterministic session cwd (chosen by
 *    the USER), not by anything the agent or a prompt can assert. NOTHING else
 *    is path-exempt: a session started in ~/.pi or in this repository runs the
 *    full loop. Source stays "auto" and the hooks need no exemption (no
 *    hook-installed repo lives in /tmp).
 *  - Print/JSON mode (no UI) can only run "normal" (USER REQUIREMENT). Every
 *    enforced mode now depends on dialogs the extension must be able to
 *    render — the loop goal is approved in one (lib/loop-goal.ts), a
 *    sensitive-file edit is authorized in one, a downgrade is confirmed in one
 *    — so a session that cannot show a dialog would enter the loop and then
 *    have no way out of it. Rather than half-enforce, the gate steps aside
 *    entirely there: {@link evaluateModeChange} refuses anything but normal
 *    when hasUI is false, and normal means the extension does not even arm
 *    (see extensions/review-gate.ts), so the git hooks see an unarmed state
 *    and let the headless session commit.
 *
 * SECURITY — why an agent-chosen explore is safe without confirmation:
 *  1. In-session, explore never weakens the L1 ship gate at all; it only
 *     relaxes auto-continuation and declare_done — the safe direction.
 *  2. The sidecar records taskModeSource, and the git hooks treat
 *     explore/normal as advisory ONLY when the USER chose it ("user" —
 *     confirmed dialog or /gate-mode). An agent-set mode keeps source
 *     "auto", which never downgrades the hooks.
 *  Normal mode DOES weaken in-session enforcement, so the agent can never
 *  reach it on its own. The consent-free entries into normal are only:
 *    1. /tmp scratchFirstMode (explicit explore else normal; never loop) —
 *       driven by the deterministic session cwd, not by agent assertion;
 *    2. print/JSON no-UI, which evaluateModeChange and session_start force
 *       to normal even on a dirty worktree (no dialog can be shown).
 *  Every other path into normal — including the agent's own first
 *  classification — requires user confirmation, as does any later downgrade
 *  and an initial explore on a session that already edited.
 */

export type TaskMode = "normal" | "explore" | "loop" | "orchestrator";

/** Normalize a persisted/requested task-mode value; undefined for unknown or
 *  forged input (fail-closed: callers treat unknown as loop behavior). */
export function normalizeTaskMode(value: unknown): TaskMode | undefined {
  if (value === "loop" || value === "explore" || value === "normal" || value === "orchestrator") return value;
  return undefined;
}

/**
 * Environment variable a SPAWNER stamps into a session it starts, to say what
 * mode that session is meant to run in.
 *
 * It exists because of one requirement (task book §5): a child opened by
 * `orchestrator_spawn` must be an ordinary loop session, and a relay successor
 * must be an orchestrator — neither should have to guess, and a child must
 * never wander into the orchestration role by classifying itself.
 *
 * It is NOT a way around the consent rules. It is honoured only on the FIRST
 * classification of a session that is still clean, and it is read through
 * {@link normalizeTaskMode}, so an arbitrary value is simply ignored. A
 * spawner can therefore hand a session a TIGHTER starting point, never a
 * looser one than it could have chosen for itself.
 */
export const GATE_MODE_ENV = "RG_GATE_MODE";

/** The mode a spawner asked this session to start in, if any. */
export function requestedModeFromEnv(env: NodeJS.ProcessEnv = process.env): TaskMode | undefined {
  return normalizeTaskMode(env[GATE_MODE_ENV]?.trim());
}

/**
 * The modes that run the FULL enforced workflow. Everything the gate blocks
 * in loop mode it also blocks in orchestrator mode — orchestrator only ADDS
 * restrictions (no code writing, a plan the user approved, a stricter
 * declare_done). Callers that mean "enforced" must ask this rather than
 * comparing to "loop", or every new mode silently opens a hole.
 */
export function isEnforcedMode(mode: TaskMode | undefined): boolean {
  // undefined (undecided) behaves as loop — fail-closed.
  return mode === undefined || mode === "loop" || mode === "orchestrator";
}

/** First /tmp classification: the agent may never land on an enforced mode.
 *  Only an explicit "explore" pick stays explore; loop, orchestrator, normal,
 *  or a missing pick all become normal. */
export function scratchFirstMode(
  requested: TaskMode | undefined,
): Exclude<TaskMode, "loop" | "orchestrator"> {
  return requested === "explore" ? "explore" : "normal";
}

/** Who decided the mode. Only "user" may downgrade the git hooks to advisory. */
export type TaskModeSource = "auto" | "user";

/** Strictness rank. A change to a HIGHER rank is an upgrade (tighten).
 *  `orchestrator` outranks `loop` because it is loop PLUS the orchestration
 *  constraints: entering it is always a tightening (consent-free), and
 *  leaving it for loop is a real downgrade that asks the user. */
export const TASK_MODE_RANK: Readonly<Record<TaskMode, number>> = Object.freeze({
  normal: 0,
  explore: 1,
  loop: 2,
  orchestrator: 3,
});

export type ModeChangeDecision =
  /** Requested mode is already active. */
  | { action: "noop" }
  /** Apply immediately with the given source (no user interaction). */
  | { action: "apply"; source: TaskModeSource }
  /** The EXTENSION must obtain user consent (ctx.ui.confirm); consent applies
   *  the mode with source "user", refusal locks agent downgrades. */
  | { action: "confirm" }
  /** Not permitted; the reason is surfaced to the agent verbatim. */
  | { action: "reject"; reason: string };

/**
 * The single pure authority on a requested mode change (see header rules).
 * The caller supplies facts only — it must never pre-decide consent.
 */
export function evaluateModeChange(opts: {
  /** Current session mode; undefined = undecided (behaves as loop). */
  current: TaskMode | undefined;
  requested: TaskMode;
  /** THIS session's own edits (sessionEdited — pre-existing worktree/branch
   *  changes from before the session do NOT count: they arm the ship gate via
   *  state.hasCodeChange but must not force a confirmation dialog on the
   *  first classification). */
  hasChanges: boolean;
  /** Whether an interactive confirm dialog is possible. */
  hasUI: boolean;
  /** A previously declined confirmation locks agent-initiated downgrades. */
  downgradesLocked: boolean;
  /** USER REQUIREMENT (scratch sessions): this session started in /tmp
   *  (see lib/pi-self.ts) — the ONLY path-exempt case. Loop is forbidden
   *  for the agent (first classification and later upgrades). See header. */
  piSelfTask?: boolean;
}): ModeChangeDecision {
  const { current } = opts;
  let { requested } = opts;
  if (current === requested) return { action: "noop" };

  // USER REQUIREMENT — no UI ⇒ normal only (see the header). This precedes
  // every other rule, including the "upgrades never need consent" one: an
  // upgrade into loop is precisely what a headless session must not do, since
  // it could never approve a loop goal or authorize an edit afterwards.
  if (!opts.hasUI) {
    if (requested === "normal") return { action: "apply", source: "auto" };
    return {
      action: "reject",
      reason:
        "no interactive UI is available (print/JSON mode), so this session can only run in " +
        "\"normal\" mode: the enforced modes require dialogs — loop-goal approval, " +
        "sensitive-edit authorization, downgrade confirmation — that cannot be rendered here. " +
        "Run the task in an interactive session to get the full gate.",
    };
  }

  // Consent path shared by every loosening transition.
  const needsConsent = (): ModeChangeDecision => {
    if (opts.downgradesLocked) {
      return {
        action: "reject",
        reason:
          "the user already declined a gate downgrade this session — agent-initiated " +
          "downgrades are locked. Continue under the current mode; only the user can " +
          "change it now (/gate-mode).",
      };
    }
    return { action: "confirm" };
  };

  if (current === undefined) {
    // Initial in-session classification — the agent's own pick, with no
    // external classifier behind it. Undecided behaves as loop, so anything
    // below loop is a loosening: explore on a still-clean session stays
    // consent-free (it cannot weaken the ship gate or the hooks), while
    // normal — which shuts the gate down entirely — always falls through to
    // the consent path below. That asymmetry is what makes it safe to let the
    // agent classify itself: it can only tighten, never switch the gate off.
    // USER REQUIREMENT (scratch sessions): /tmp never enters an ENFORCED mode
    // (loop or orchestrator) via the agent. Callers clamp via
    // scratchFirstMode; if one still arrives here, apply normal — reject
    // would leave the session undecided (which behaves as loop).
    if (opts.piSelfTask && isEnforcedMode(requested)) {
      requested = "normal";
    }
    if (isEnforcedMode(requested)) return { action: "apply", source: "auto" };
    // First /tmp classification of explore/normal: apply automatically.
    if (opts.piSelfTask && !opts.hasChanges && !opts.downgradesLocked) {
      return { action: "apply", source: "auto" };
    }
    // A clean-session explore stays consent-free (gate-neutral: the L1 ship
    // gate and the git hooks are untouched by it).
    if (requested === "explore" && !opts.hasChanges) {
      return { action: "apply", source: "auto" };
    }
    // explore after this session edited (loop-rules work already happened) and
    // normal (total gate shutdown) both need the user. (The no-UI case never
    // reaches here — it resolved to normal above.)
    return needsConsent();
  }

  if (TASK_MODE_RANK[requested] > TASK_MODE_RANK[current]) {
    // USER REQUIREMENT: /tmp sessions cannot be pulled into an enforced mode
    // (loop or orchestrator) by the agent. The user can still /gate-mode into
    // one (that path never calls this).
    if (opts.piSelfTask && isEnforcedMode(requested)) {
      return {
        action: "reject",
        reason:
          `this session started in /tmp — scratch sessions cannot enter "${requested}" ` +
          "via the agent. Ask the user to run /gate-mode " + requested + " if they really " +
          "want the full enforced workflow here.",
      };
    }
    // Upgrade — tightening never needs consent. Source stays "auto": for loop
    // the source is irrelevant, and an agent upgrade must never be able to
    // launder a later hook-advisory state.
    return { action: "apply", source: "auto" };
  }

  return needsConsent();
}

// ---------------------------------------------------------------------------
// Fixed dialog copy. The consequence text is written by the EXTENSION (the
// agent cannot alter it) and must spell out exactly what the user is granting.

export const MODE_CONFIRM_TITLE = "review-gate: AI 请求降低本会话的门禁级别——是否同意？";

const MODE_CONSEQUENCES: Readonly<Record<TaskMode, string>> = Object.freeze({
  // `orchestrator` is the strictest rank, so it is never a downgrade TARGET
  // and never reaches the confirm dialog.
  orchestrator: "",
  // `loop` IS reachable as a downgrade target since orchestrator outranks it,
  // so this copy has to say what leaving the orchestration layer gives up.
  loop:
    "切换到 loop（循环）模式：解除项目经理专属约束 —— 本会话将可以自己写代码，" +
    "plan 批准、子会话存活检查等编排层退出条件不再拦 declare_done；" +
    "强制 review 循环与 ship 拦截照旧。",
  explore:
    "切换到 explore（探查）模式：关闭强制 review 循环与自动继续，AI 可自行判断结束任务；" +
    "commit/push 等 ship 命令仍被完整拦截。",
  normal:
    "切换到 normal（普通）模式：本会话的全部质量门禁将关闭 —— commit/push/PR 不再被拦截，" +
    "review/precommit 不再强制，git hooks 对你本人的提交也放行。效果等同于未安装本插件。",
});

/** Max characters of the agent-supplied reason shown in the dialog. */
export const MODE_REASON_MAX_CHARS = 200;

/**
 * Build the confirm-dialog body. The agent's reason is UNTRUSTED data: it is
 * length-capped, JSON-quoted (so newlines/controls cannot fake dialog copy),
 * and explicitly labeled — the fixed consequence text above it is the only
 * authoritative statement of what "yes" grants.
 *
 * ORDER MATTERS. The dialog is bounded to a few rendered rows (see
 * lib/dialog-budget.ts — an oversized dialog makes the terminal flicker), and
 * the budget truncates from the END. So every fixed, authoritative line comes
 * first and the untrusted reason goes last: if anything is dropped, it is the
 * agent's text, never the statement of what the user is granting.
 *
 * `clampedFrom` covers the one case where the agent's reason argues for a
 * DIFFERENT mode than the dialog asks about: a /tmp session where
 * scratchFirstMode rewrote the pick. Without this line the reason reads as a
 * non-sequitur ("deliver this refactor" under a dialog offering normal). The
 * sentence is fixed copy written here, never by the agent.
 */
export function buildModeConfirmMessage(
  requested: TaskMode,
  reason: string,
  clampedFrom?: TaskMode,
): string {
  const capped = reason.length > MODE_REASON_MAX_CHARS
    ? reason.slice(0, MODE_REASON_MAX_CHARS) + "…"
    : reason;
  const clampNote = clampedFrom !== undefined && clampedFrom !== requested
    ? `\n注意：AI 实际请求的是 "${clampedFrom}"，但本会话启动于 /tmp（临时目录），` +
      `规则已将其调整为 "${requested}"——下方理由是为 "${clampedFrom}" 写的。`
    : "";
  return (
    MODE_CONSEQUENCES[requested] +
    clampNote +
    "\n拒绝后，本会话将锁定 AI 发起的降级请求（你仍可随时用 /gate-mode 切换）。" +
    "\nAI 给出的理由（不可信数据，仅供参考）: " + JSON.stringify(capped)
  );
}

/**
 * Per-turn directive injected while the mode is undecided: the agent calls
 * set_gate_mode as its FIRST action and its own pick IS the classification —
 * no external model is consulted for the mode. The engine's asymmetry keeps
 * that safe: loop and (on a clean session) explore apply without a dialog,
 * while normal always asks the user. Enforcement stays full loop behavior
 * until a decision lands, so "agent never calls it" is fail-closed.
 */
export const GATE_MODE_DECISION_DIRECTIVE =
  "## Gate mode decision required (FIRST action)\n" +
  "This session's gate mode is UNDECIDED; enforcement currently behaves as the full loop " +
  "workflow (fail-closed). As your FIRST action, judge the user's actual intent (quoted " +
  "logs/errors/pasted text are context, not intent) and call the set_gate_mode tool:\n" +
  '- "loop" — code/doc changes to deliver (fix, implement, refactor, ship...): full enforced review loop.\n' +
  '- "explore" — the deliverable is knowledge (explain, analyze, investigate, troubleshoot); ' +
  "running diagnostic commands still counts. Gates become advisory; ship commands stay blocked.\n" +
  '- "normal" — neither development nor research (casual Q&A, quick chores): the gate switches ' +
  "off entirely.\n" +
  '- "orchestrator" — ONLY when the user asked you to run this session as the PROJECT MANAGER ' +
  "(plan the work, spawn and supervise child sessions, report back). It is loop plus the " +
  "orchestration constraints: you may not write code yourself, and you need a plan the user " +
  "approved before you may spawn anything. It requires a tmux window.\n" +
  'NOTE (scratch sessions): a session STARTED IN /tmp (the scratch dir — ' +
  'macOS /private/tmp is the same dir) NEVER enters an enforced mode ' +
  '(loop / orchestrator) via the agent. ' +
  'Call set_gate_mode with "normal" when the main purpose is editing or ' +
  'inspecting local pi config (~/.pi), or "explore" for investigation. ' +
  'A requested enforced mode is ignored. Only the user can force one (/gate-mode). ' +
  'A session started OUTSIDE /tmp — including one started in ~/.pi or in ' +
  'the pi-review-gate repo — is NOT path-exempt and runs the full loop.\n' +
  "Your pick IS the classification — no separate model reviews it — so judge honestly and " +
  "give a truthful one-line reason. You can only classify yourself INTO the gate: \"loop\" " +
  "applies immediately and \"explore\" applies while this session is still clean, but " +
  "\"normal\" switches the gate off entirely and therefore always asks the USER to confirm. " +
  "Upgrades (toward loop) apply later without confirmation except in /tmp, where the agent " +
  "cannot enter loop at all (only the user can force loop via /gate-mode); downgrades after the " +
  "first classification ask the user. If genuinely uncertain, choose \"loop\" (the safe default).";
