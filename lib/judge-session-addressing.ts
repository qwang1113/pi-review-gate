/**
 * WHO a judge-session tool call addresses, and whether the caller may touch
 * it — the two refusals `judge_close` (lib/judge-session-tools.ts) and
 * `judge_wait` (lib/judge-wait-tool.ts) share, plus the failure shapes each
 * of them reports.
 *
 * Its own module so both tools import ONE resolver and ONE opener check
 * instead of each keeping a copy. The gate-self bypass these functions honour
 * is explained in lib/judge-session-tools.ts's module docblock.
 */
import { checkCaller } from "./hierarchy.ts";
import type { JudgeSessionToolDeps } from "./judge-session-tools.ts";

// The list is a NAMED constant because the "needs a role" refusal below names
// the same roles in words: `acceptance` was added to the enum and not to that
// sentence, and the two lists had no way to notice (reviewer P2, 2026-09-22).
// The enum built from it (`ROLE_PARAM`) is declared in lib/judge-session-tools.ts,
// with the reasons each role is addressable.
export const ADDRESSABLE_JUDGE_ROLES: Readonly<Record<string, string>> = Object.freeze({
  reviewer: "reviewer",
  "quality-auditor": "quality-auditor",
  adviser: "adviser",
  "goal-auditor": "goal-auditor",
  acceptance: "acceptance",
});

/**
 * The failure shapes.
 *
 * Each one carries EVERY field its tool's success path reports, with the
 * neutral value: an agent (or a test) reading `details.hasVerdict` must never
 * find the key simply missing because the call failed early.
 */

export function closeFailDetails(): Record<string, unknown> {
  return { closed: false, terminated: false, judgeId: undefined };
}

export function waitFailDetails(): Record<string, unknown> {
  return { done: false, reason: undefined, role: undefined, hasVerdict: false };
}

// ---------- shared addressing ----------

type Addressed =
  | { ok: true; root: string; role: string | undefined; judgeId: string | undefined }
  | { ok: false; text: string };

/**
 * Who is being addressed, and in which repo.
 *
 * Both refusals are identical across the three tools, and both are
 * fail-closed: an unaddressed call names the roles it accepts, and an
 * ambiguous repo is never guessed — reading, closing or waiting on the wrong
 * repo's judge is a silently wrong answer about somebody else's change.
 */
export function addressJudge(
  deps: JudgeSessionToolDeps,
  params: Record<string, unknown>,
  toolName: string,
  gateSelf = false,
): Addressed {
  const role = params.role ? String(params.role) : undefined;
  const judgeId = params.sessionId ? String(params.sessionId) : undefined;
  if (!role && !judgeId) {
    return { ok: false, text: `review-gate: ${toolName} needs a role (${Object.keys(ADDRESSABLE_JUDGE_ROLES).join(" / ")}).` };
  }
  // Gate-self path (2026-09-08): ONLY when the direct caller passes
  // `gateSelf === true` as a FUNCTION ARGUMENT — i.e. the gate's own audit
  // chains (`selfAuditWait` / `auditRunDeps.closeJudge`), which hold the
  // judgeId from their own dispatch. It is keyed on the CALLER, never on the
  // parameter bag: `params` comes from the agent verbatim (unknown keys are
  // stripped nowhere), so a marker living in it would be settable by
  // `judge_wait({sessionId, gateSelf:true})` (reviewer P1, 2026-09-08). The
  // opener check still runs downstream for both paths.
  if (gateSelf && judgeId && deps.findChildById) {
    const direct = deps.findChildById(judgeId);
    if (direct) return { ok: true, root: direct.repoRoot, role: role ?? direct.role, judgeId };
    // Unknown id: fall through to the normal path (which refuses fail-closed
    // on the repo check) rather than inventing a root.
  }
  const target = deps.resolveRepo(typeof params.repo === "string" ? params.repo : undefined);
  if (!target.ok) return { ok: false, text: target.error };
  return { ok: true, root: target.root, role, judgeId };
}

/** Opener check shared by the three tools (read narrows the role first). */
export function checkOpener(
  deps: JudgeSessionToolDeps,
  judgeId: string,
): { ok: true } | { ok: false; text: string } {
  // EVERY identity this session may act under, in order of preference: its
  // own first, then the one it replaced (a handover's successor — see the dep).
  const callers: string[] = [];
  const own = deps.callerId();
  if (own) callers.push(own);
  for (const other of deps.callerIds?.() ?? []) {
    if (other && !callers.includes(other)) callers.push(other);
  }
  if (callers.length === 0) {
    return { ok: false, text: "review-gate: 无法确认调用者身份——身份不明时不能操作任何 review。" };
  }
  let lastReason = "";
  for (const caller of callers) {
    const allowed = checkCaller(deps.hierarchy(), judgeId, caller);
    if (allowed.ok) return { ok: true };
    lastReason = allowed.reason;
  }
  return { ok: false, text: `review-gate: ${lastReason}` };
}
