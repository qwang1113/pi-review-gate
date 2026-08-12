/**
 * Session gate-mode model — decided IN-SESSION, with strict up/down rules.
 *
 * MODES (strictness order: normal < explore < loop)
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
 * WHO DECIDES — DeepSeek V4 (LLM first classification, user requirement), the
 * session's own agent (set_gate_mode tool), or the user (/gate-mode). While
 * the mode is undecided the gate behaves as loop (fail-closed) and the
 * per-turn system prompt instructs the agent to call set_gate_mode as its
 * first action; the tool then asks the DeepSeek V4 classifier to pick the
 * mode BEFORE the session's work starts (no edits by THIS session —
 * pre-existing workspace changes do not count, interactive
 * session) and applies that verdict AUTOMATICALLY — the user opted out of
 * the first confirmation dialog. A failed/absent model call falls back to
 * the rule engine's pre-LLM behavior exactly (fail-back). evaluateModeChange()
 * is the single pure authority on what a requested change may do:
 *
 *  - UPGRADES (toward loop) apply immediately — tightening never needs
 *    consent. Agent-applied modes record source "auto".
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
 *  - USER REQUIREMENT (first-classification automation): the FIRST decision
 *    (undecided → any mode) applies automatically without a consent dialog
 *    when the caller marks it firstDecideAuto (the LLM produced the verdict).
 *    Still bounded: interactive session AND no edits by THIS session, and
 *    the mode records source "auto" so the git hooks stay fully enforced.
 *  - USER REQUIREMENT (scratch sessions): a first classification in a session
 *    started in the scratch dir /tmp (see lib/pi-self.ts) applies "normal"
 *    automatically via piSelfTask, with the same bounds as firstDecideAuto
 *    (clean interactive session, not locked). /tmp is scratch space by
 *    definition. NOTHING else is exempt: editing ~/.pi, the pi binary
 *    install, or developing pi-review-gate ITSELF (its repo anywhere) runs
 *    the full loop like any development. Source stays "auto" and the hooks
 *    need no exemption (no hook-installed repo lives in /tmp), so ordinary
 *    repos stay fully enforced. A requested upgrade to "loop" still wins —
 *    the auto-exemption only sets the default.
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
 * SECURITY — why an LLM/agent-chosen explore is safe without confirmation:
 *  1. In-session, explore never weakens the L1 ship gate at all; it only
 *     relaxes auto-continuation and declare_done — the safe direction.
 *  2. The sidecar records taskModeSource, and the git hooks treat
 *     explore/normal as advisory ONLY when the USER chose it ("user" —
 *     confirmed dialog or /gate-mode). An LLM/agent-set mode keeps source
 *     "auto", which never downgrades the hooks.
 *  Normal mode DOES weaken in-session enforcement — which is why the user
 *  explicitly opted OUT of the first confirmation for it (firstDecideAuto on
 *  a clean interactive session); every LATER path into it (initial on a dirty
 *  session, or any downgrade) still requires user confirmation — except the
 *  scratch-session first classification (/tmp only), where the user asked
 *  for no dialogs at all.
 */

export type TaskMode = "normal" | "explore" | "loop";

/** Normalize a persisted/requested task-mode value; undefined for unknown or
 *  forged input (fail-closed: callers treat unknown as loop behavior). */
export function normalizeTaskMode(value: unknown): TaskMode | undefined {
  if (value === "loop" || value === "explore" || value === "normal") return value;
  return undefined;
}

/** Who decided the mode. Only "user" may downgrade the git hooks to advisory. */
export type TaskModeSource = "auto" | "user";

/** Strictness rank. A change to a HIGHER rank is an upgrade (tighten). */
export const TASK_MODE_RANK: Readonly<Record<TaskMode, number>> = Object.freeze({
  normal: 0,
  explore: 1,
  loop: 2,
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
  /** USER REQUIREMENT: the DeepSeek V4 classifier produced this first
   *  decision — apply it without a consent dialog. Ignored unless the mode is
   *  undecided, the session is interactive and has made NO edits of its own
   *  (the LLM runs only pre-work; see extensions/review-gate.ts). */
  firstDecideAuto?: boolean;
  /** USER REQUIREMENT (scratch sessions): this session started in the scratch
   *  dir /tmp (see lib/pi-self.ts) — the ONLY exempt case. The first
   *  classification then applies "normal" automatically, no dialog — same
   *  bounds as firstDecideAuto. See the header rules. */
  piSelfTask?: boolean;
}): ModeChangeDecision {
  const { current, requested } = opts;
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
    // Initial in-session classification. Undecided behaves as loop, so any
    // choice below loop is a loosening — but a clean-session explore matches
    // the long-standing auto-classification precedent (it cannot weaken the
    // ship gate or the hooks) and stays consent-free.
    if (requested === "loop") return { action: "apply", source: "auto" };
    // USER REQUIREMENT (scratch sessions): the session started in the scratch
    // dir /tmp — the ONLY gate-exempt case, deterministic path detection in
    // lib/pi-self.ts. /tmp is scratch space by definition: the first
    // classification applies "normal" automatically. Same bounds as
    // firstDecideAuto below — clean interactive session, not
    // downgrade-locked. A requested "loop" already returned above, so the
    // user can still demand the full loop; the exemption only sets the
    // default. Source stays "auto" (the git hooks stay fully enforced, with
    // no exemption of their own).
    if (opts.piSelfTask && !opts.hasChanges && !opts.downgradesLocked) {
      return { action: "apply", source: "auto" };
    }
    // USER REQUIREMENT (first-classification automation): an LLM-backed first
    // verdict applies automatically on a CLEAN interactive session — the user
    // opted out of the first confirmation dialog. Bounded exactly like the
    // explore auto-classification above: no edits by THIS session (the
    // session's work has not started under loop rules) and a UI to render
    // the result.
    // A declined-downgrade lock still vetoes it (defense in depth — the
    // undecided state cannot normally hold the lock, but the pure engine
    // never lets a locked session loosen itself). Source stays "auto" so the
    // git hooks remain fully enforced.
    if (opts.firstDecideAuto && !opts.hasChanges && !opts.downgradesLocked) {
      return { action: "apply", source: "auto" };
    }
    if (requested === "explore" && !opts.hasChanges) {
      return { action: "apply", source: "auto" };
    }
    // explore after this session edited (loop-rules work already happened) and
    // normal (total gate shutdown) both need the user. (The no-UI case never
    // reaches here — it resolved to normal above.)
    return needsConsent();
  }

  if (TASK_MODE_RANK[requested] > TASK_MODE_RANK[current]) {
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
  loop: "", // upgrades never reach the confirm dialog
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
 */
export function buildModeConfirmMessage(requested: TaskMode, reason: string): string {
  const capped = reason.length > MODE_REASON_MAX_CHARS
    ? reason.slice(0, MODE_REASON_MAX_CHARS) + "…"
    : reason;
  return (
    MODE_CONSEQUENCES[requested] +
    "\n拒绝后，本会话将锁定 AI 发起的降级请求（你仍可随时用 /gate-mode 切换）。" +
    "\nAI 给出的理由（不可信数据，仅供参考）: " + JSON.stringify(capped)
  );
}

/**
 * Per-turn directive injected while the mode is undecided: the agent calls
 * set_gate_mode as its FIRST action, and DeepSeek V4 (deepseek/deepseek-v4-
 * flash, the llmGuards model) classifies the task there — the LLM verdict
 * applies automatically, no user confirmation needed for this first
 * classification (user requirement). Enforcement stays full loop behavior
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
  'NOTE (scratch sessions): a session STARTED IN /tmp (the scratch dir — ' +
  'macOS /private/tmp is the same dir) is classified "normal" AUTOMATICALLY ' +
  'by a deterministic path rule; call set_gate_mode with "normal" (or "loop" ' +
  'if the user explicitly wants the full loop). Everything else — editing ' +
  '~/.pi, the pi binary install, or developing pi-review-gate ITSELF (its ' +
  'repo) — is NOT exempt and runs the full loop like any development.\n' +
  "DeepSeek V4 (the llmGuards model) classifies this first decision inside the tool and it is " +
  "applied AUTOMATICALLY — no confirmation dialog for the first classification (user " +
  "requirement). Provide a truthful one-line reason; the model may override your pick. " +
  "Upgrades (toward loop) are always allowed later without confirmation; downgrades after the " +
  "first classification ask the user. If genuinely uncertain, choose \"loop\" (the safe default).";
