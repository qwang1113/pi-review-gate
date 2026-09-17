/**
 * THE refusal renderer — one shape for every "no" the gate says to an agent
 * (user decision, 2026-09-16).
 *
 * WHY IT EXISTS. Measured across the gate's own agent-facing copy: 400
 * messages refuse something, and 27 of them (~7%) say what to do next. The
 * rest state a verdict and stop, so the agent's next move is a guess — and a
 * guess costs a round. The rule lives in `docs/coding-standards.md` §7 (its
 * only substantive home; this module cites it and never restates it):
 * 现象 / 原因 / 下一步, and when the agent cannot clear it alone, WHO can.
 *
 * WHY A TYPE AND NOT A HABIT. The three parts are REQUIRED fields of
 * {@link RejectionParts}, so a call site that forgets one does not compile.
 * That is the entire reason this is a module rather than three lines inlined
 * at each refusal — the shape is guaranteed by the code, not by the author
 * having read §7. Renaming a field therefore breaks the build at every call
 * site, which is the intended failure mode.
 *
 * SCOPE. New refusal sites use it, and existing ones convert as they are
 * touched (six agent-facing high-frequency paths in the first pass). It is
 * deliberately not a framework: no severity, no codes, no registry, no
 * formatting options.
 */

/** Who can clear the refusal. */
export type RejectionActor =
  /** 你 — the agent reading this can fix it itself. */
  | "agent"
  /** 用户 — only the human can decide or grant it. */
  | "user"
  /** 门禁 — the gate's own workflow clears it; the agent just needs to know. */
  | "gate";

export interface RejectionParts {
  /** 现象：what was refused — this call, this file, this one item. */
  what: string;
  /** 原因：the FACT the gate refuses on (a constant, a measurement, a record), never a verdict. */
  why: string;
  /** 谁能让它过去. */
  by: RejectionActor;
  /** 下一步：that actor's action. Multi-line is fine. */
  next: string;
}

/** The actor labels, in the second person the agent reads them in. */
const ACTOR_LABEL: Record<RejectionActor, string> = Object.freeze({
  agent: "你",
  user: "用户",
  gate: "门禁",
});

/**
 * Render one refusal: 现象 / 原因 / 下一步, in that order, always.
 *
 * The `review-gate: ` prefix stays — it is how every message from this
 * extension is recognised in a transcript.
 */
export function buildRejection(parts: RejectionParts): string {
  return [
    `review-gate: ${parts.what}`,
    `原因：${parts.why}`,
    `下一步：${ACTOR_LABEL[parts.by]} —— ${parts.next}`,
  ].join("\n");
}
