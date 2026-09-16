/**
 * THE QUALITY ROUND — a code-quality review that runs IN THE SAME ROUND as
 * the functional one (2026-09-16; it ran before it from 2026-09-15).
 *
 * WHAT IT IS. Every submission already walks a chain inside `judge_submit`:
 * precommit → checkpoint → prepare → dispatch. This module owns the QUALITY
 * judge of that round — the one that judges whether the CODE ITSELF is any
 * good (philosophy / architecture / correctness / performance, then
 * simplicity / readability / maintainability), against a LANGUAGE-NEUTRAL
 * checklist. The gate starts it together with the functional reviewer: both
 * judge the same immutable range, and the cancel matrix below decides who
 * stops whom. Only a quality READY lets a functional READY be RECORDED — a
 * reviewer that concludes first has its conclusion held until the quality
 * verdict lands.
 *
 * WHY A SEPARATE ROLE. `agents/reviewer.md` had architecture, naming and
 * minimalism clauses already, and in practice almost never raised them: a
 * judge carrying requirement-fit, test coverage and doc-sync at once reads
 * quality as taste, not as a checklist. The measured answer is one judge per
 * question — this file is the mechanical half of the quality judge.
 *
 * WHAT LIVES HERE AND WHY. Only decisions, never effects: which rounds skip
 * the quality judge, whether the functional reviewer's verdict may be
 * recorded, who cancels whom, what a recorded quality verdict looks like.
 * `extensions/review-gate.ts` wires them (routing in `submitForReview`, the
 * kill on the settle path, killing the precommit lane) and decides nothing of
 * its own — that file is ~12k lines and got there one "just add the check
 * here" at a time.
 *
 * THE TWO HALVES OF A QUALITY PASS, kept apart on purpose:
 *  - `qualityRoundSkip` answers "is there anything to judge at all?" — a
 *    documentation-only round has no code-quality question to ask, so it is
 *    SKIPPED (and the skip is recorded, never silent).
 *  - `qualityStandingFor` answers "does a quality pass stand for this head?"
 *    — the mechanical fact a recorded READY hangs on.
 */

import { buildStreamDirective } from "./review-stream.ts";
import { QUALITY_ROUND_SPEC, REVIEW_ROUND_SPEC } from "./audit-round-specs.ts";

/**
 * Extensions that carry no code — USED AS AN EXCLUSION LIST, never as a
 * whitelist of languages.
 *
 * The gate is installed on Node, front-end, Rust, Shell, Python and midway
 * repos alike (user requirement), so "is this a source file" has no
 * language-side answer. The only answer that stays correct in a repo this
 * gate has never seen is "compare against what is certainly NOT code":
 * markdown, data, lock files, images. A file language nobody listed (`.rs`,
 * `.sh`, `.vue`, `.proto`, anything) is therefore CODE by default, and a
 * quality round runs on it — the fail-closed direction.
 */
export const NON_SOURCE_EXTENSIONS: readonly string[] = Object.freeze([
  ".md", ".mdx", ".markdown", ".rst", ".adoc", ".txt",
  ".json", ".jsonc", ".json5", ".ndjson",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".properties", ".env",
  ".lock", ".sum", ".mod", ".snap",
  ".csv", ".tsv",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".pdf",
  ".patch", ".diff",
]);

/** Extension-less paths that carry no code (licences, ignore files, notices). */
const NON_SOURCE_BASENAMES: readonly string[] = Object.freeze([
  "license", "licence", "notice", "authors", "contributors", "codeowners",
  "changelog", "changes", "contributing", "readme", "security", "citation",
  ".gitignore", ".gitattributes", ".npmignore", ".editorconfig", ".npmrc",
  ".prettierignore", ".eslintignore", ".dockerignore", ".gitkeep",
]);

/** The basename of a repo-relative or absolute path (no path module needed). */
function basenameOf(file: string): string {
  const trimmed = file.trim().replace(/\\/g, "/");
  const slash = trimmed.lastIndexOf("/");
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase();
}

/**
 * Is this changed file CODE — i.e. does the quality round have anything to
 * judge in it? Unknown ⇒ true (fail-closed, see NON_SOURCE_EXTENSIONS).
 */
export function isSourceFile(file: string): boolean {
  const base = basenameOf(file);
  if (!base) return true; // an unreadable entry is not a licence for skipping
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  if (ext === "") return !NON_SOURCE_BASENAMES.includes(base);
  return !NON_SOURCE_EXTENSIONS.includes(ext);
}

/** Why a round carries no quality round, in the words the agent reads. */
export interface QualitySkip {
  skip: boolean;
  /** Present when `skip` — recorded on the round and printed to the agent. */
  reason?: string;
}

/**
 * Should THIS round skip the quality judge?
 *
 * Two cases, and both are recorded rather than silent — an exception only the
 * code knows about reads as the rule three rounds later:
 *  - nothing changed at all (the exit-goal round: HEAD..HEAD, zero files);
 *  - every changed file is documentation / data / lock file.
 */
export function qualityRoundSkip(files: readonly string[] | undefined): QualitySkip {
  // AN UNKNOWN FILE LIST IS NOT AN EMPTY ONE. `undefined` reaches here from a
  // caller that has no diff to hand (an older review target, a target that was
  // never registered) — and "we cannot tell what changed" must mean "run the
  // quality round", never "nothing to see here".
  if (files === undefined) return { skip: false };
  const list = files.filter((f) => f.trim() !== "");
  if (list.length === 0) {
    return { skip: true, reason: "本轮没有代码改动（空范围轮）—— 无可审的代码，质量轮跳过" };
  }
  const code = list.filter(isSourceFile);
  if (code.length === 0) {
    return {
      skip: true,
      reason: `本轮只改动了非代码文件（${list.slice(0, 5).join(", ")}${list.length > 5 ? " …" : ""}）—— 质量轮跳过`,
    };
  }
  return { skip: false };
}

/** The quality verdict as the sidecar keeps it. */
export interface QualityStanding {
  verdict: string;
  /** The reviewed HEAD the verdict binds to. */
  commitSha?: string;
}

/** Why the functional reviewer is (or is not) allowed to run. */
export type QualityStandingResult =
  | { ok: true; basis: "pass" | "skipped" }
  | { ok: false; reason: string };

/**
 * THE PRECONDITION OF A RECORDED READY — the mechanical fact that makes the
 * quality round unskippable by accident.
 *
 * A functional READY may be recorded only when the CURRENT head carries a
 * quality READY (or the round was skipped as code-free). Everything else fails
 * closed:
 *  - no record at all;
 *  - a record bound to a DIFFERENT head (the content moved after the quality
 *    round judged it — the checkpoint the next submission writes moves HEAD,
 *    which is exactly how a stale pass is caught);
 *  - a recorded BLOCKED.
 *
 * A SKIP is recorded as a READY carrying `skipped`, so this function needs no
 * third state: "the quality round decided there was nothing to judge" and "the
 * quality round judged it" are the same permission, recorded differently.
 *
 * WHO READS IT. Since 2026-09-16 the two judges start together, so this no
 * longer gates the DISPATCH in the parallel path (the gate dispatched the
 * quality judge in the same breath); it gates the RECORD — `decideQualityHold`
 * below turns it into record / hold / refuse. It still gates the dispatch for
 * every other caller, and there is exactly one of those: a re-submission whose
 * head already carries a quality READY (`dispatchJudgeRound`'s explicit
 * `qualityRoundDispatched` parameter is the only way past it).
 */
export function qualityStandingFor(input: {
  head: string;
  files: readonly string[] | undefined;
  quality: QualityStanding | undefined;
}): QualityStandingResult {
  const skip = qualityRoundSkip(input.files);
  const standing = input.quality;
  if (standing?.verdict === "READY") {
    if (standing.commitSha && standing.commitSha === input.head) {
      return { ok: true, basis: "pass" };
    }
    return {
      ok: false,
      reason:
        `质量轮记录的 READY 绑定在 ${standing.commitSha ? standing.commitSha.slice(0, 12) : "(未记录 commit)"}` +
        `，不是当前 HEAD ${input.head.slice(0, 12)} —— 质量结论已经过期，必须重跑质量轮`,
    };
  }
  if (standing?.verdict === "BLOCKED") {
    return { ok: false, reason: "质量轮上一轮判了 BLOCKED —— 先按 findings 修，再重新送审" };
  }
  if (skip.skip) return { ok: true, basis: "skipped" };
  return { ok: false, reason: "还没有质量轮的结论 —— 本轮改动必须先过质量轮" };
}

/**
 * The quality record to write for a round that just concluded, or the SKIP
 * record when there was nothing to judge.
 *
 * `at` is passed in rather than read here so the writer stays pure (and so a
 * test can pin the exact object the sidecar receives).
 */
export interface QualityRecord extends QualityStanding {
  commitSha: string;
  treeSha?: string;
  at: string;
  /** The round carried no quality round at all — recorded, never silent. */
  skipped?: boolean;
  /** Why it was skipped, in the words the agent will read. */
  skipReason?: string;
  /** How many findings the round carried (diagnostics, like rounds[]). */
  findingsTotal?: number;
}

/** The quality record for a code-free round (see `qualityRoundSkip`). */
export function skippedQualityRecord(input: { head: string; tree?: string; reason: string; at: string }): QualityRecord {
  return {
    verdict: "READY",
    commitSha: input.head,
    ...(input.tree === undefined ? {} : { treeSha: input.tree }),
    at: input.at,
    skipped: true,
    skipReason: input.reason,
  };
}

/** How many structural tests / readers tell the two brands of round apart. */
export const QUALITY_ROLE = "quality-auditor";

/**
 * THE CHECKLIST's path, repo-relative — one constant, because three surfaces
 * name it (the dispatch task, the role body, the module map) and a typo in any
 * of them is a judge reading nothing while reporting confidently.
 */
export const QUALITY_RULES_RELPATH = "docs/code-quality-rules.md";

/**
 * WHAT JUST LANDED — the input of the cancel matrix.
 *
 * The LANE is not a judge (it has no verdict word in common with them: it says
 * PASS, they say READY), and its row of the table is its own, so it is a case
 * of this union rather than a fourth enum member of `party`. A caller that
 * invents a synthetic judge to reach the lane's row is how the matrix ends up
 * implemented twice — which is what the quality round caught on 2026-09-16.
 */
export type RoundLanding =
  | { party: "quality"; verdict: string }
  /**
   * `held` — the recorder PARKED this round's conclusion (the full lane's PASS
   * or the quality verdict is still owed), so `verdict` is not a verdict at all
   * but the state the sidecar is left in (`PENDING`).
   */
  | { party: "reviewer"; verdict: string; held?: boolean }
  | { party: "lane"; verdict: string };

/**
 * WHICH PARTY OF A ROUND AN AUDIT KIND IS — the bridge between the two
 * vocabularies, and the reason it exists is a measured P1.
 *
 * `lib/audit-round-specs.ts` names a round by its KIND (`quality`, `review`,
 * `goal`, `plan`, `advice`); the cancel matrix names its members by ROLE
 * (`quality`, `reviewer`). The extension compared the settle's kind against
 * `"reviewer"` — a word that never appears as a kind — so the matrix's second
 * row was dead code: a BLOCKED functional round neither stopped the quality
 * round nor aborted the lane it was spending minutes on, while the receipt and
 * the quality round's own note promised the agent it had (functional round P1,
 * 2026-09-16).
 *
 * The kinds are READ FROM THE SPECS, not spelled again: a renamed kind then
 * breaks this bridge loudly (the matrix would receive `undefined` and cancel
 * nothing) instead of silently skipping one row — and the test below pins both
 * translations.
 */
export function roundCancelParty(kind: string | undefined): "quality" | "reviewer" | undefined {
  if (kind === QUALITY_ROUND_SPEC.kind) return "quality";
  if (kind === REVIEW_ROUND_SPEC.kind) return "reviewer";
  return undefined;
}

/**
 * WHO STOPS WHOM — the cancel matrix of a parallel round (2026-09-16), as a
 * pure and total table.
 *
 * All three parties start together, so "which one failed" decides what happens
 * to the others, and that is a decision rather than three branches spread
 * through the extension (which is how the same matrix ends up implemented
 * twice, once per failing party).
 *
 *  - a NON-READY quality verdict ⇒ the reviewer's pane is killed and the lane
 *    is aborted: this round is blocked, and both were spending minutes on
 *    content that is about to change;
 *  - a NON-READY reviewer verdict ⇒ the quality pane is killed and the lane is
 *    aborted, for the same reason;
 *  - the LANE fails ⇒ the reviewer is killed, the quality round KEEPS GOING.
 *    That asymmetry is deliberate (user requirement): the quality judge reads
 *    code, and a failing test suite says nothing about the code's quality.
 *
 * `abortLane` is false on the lane's own row because the lane has already
 * landed — there is nothing left to abort. The lane's row is fail-closed in
 * the same direction as the others: only the exact word PASS cancels nothing.
 *
 * A READY cancels nothing: the other party's conclusion is still owed, and a
 * reviewer READY that arrives before the quality verdict is HELD rather than
 * recorded (`decideQualityHold`).
 */
export interface RoundCancelPlan {
  /** Kill the quality judge's pane. */
  cancelQuality: boolean;
  /** Kill the reviewer's pane. */
  cancelReviewer: boolean;
  /** Abort the full precommit lane still verifying this content. */
  abortLane: boolean;
}

export function roundCancelPlan(landing: RoundLanding): RoundCancelPlan {
  const nothing = { cancelQuality: false, cancelReviewer: false, abortLane: false };
  if (landing.party === "lane") {
    return landing.verdict === "PASS" ? nothing : { cancelQuality: false, cancelReviewer: true, abortLane: false };
  }
  // A PARKED CONCLUSION IS NOT A VERDICT (quality round P0, 2026-09-16).
  // `recordReviewVerdict` returns BEFORE writing `st.review` when it holds a
  // READY, so a caller that reads the sidecar sees `PENDING` — and cancelling
  // off that reading kills the quality round and the lane, i.e. exactly the
  // round the hold exists to keep alive. Nothing is cancelled while a round is
  // parked: every landing re-asks the hold (lib/review-adjudicate.ts).
  if (landing.party === "reviewer" && landing.held === true) return nothing;
  if (landing.verdict === "READY") return nothing;
  return landing.party === "quality"
    ? { cancelQuality: false, cancelReviewer: true, abortLane: true }
    : { cancelQuality: true, cancelReviewer: false, abortLane: true };
}

/** What a functional verdict does with the quality round still owed. */
export type QualityHold = "record" | "hold" | "refuse";

/**
 * THE QUALITY PRECONDITION AS ONE THREE-VALUED READING — satisfied, still
 * owed, or disproven.
 *
 * It is the state the parking machinery (lib/review-adjudicate.ts) consumes,
 * and `decideQualityHold` below is the same reading in the vocabulary of the
 * RECORDER. One policy, two callers — a second spelling of "is the quality
 * round still coming?" is how the park rule and the record rule start to
 * disagree.
 */
export type QualityPrecondition = "ok" | "pending" | "veto";

export function qualityPrecondition(input: {
  /** `qualityStandingFor(...)` for the round's head. */
  standing: QualityStandingResult;
  /**
   * Is THIS ROUND's quality judge still able to conclude? NOT "is some quality
   * pane alive": the pane is reused across rounds and outlives its own
   * verdict, so a registry lookup would answer yes forever (and park a round
   * nothing will ever release). The caller must answer from the round's own
   * record — a quality judge dispatched against THIS head that has not been
   * ruled out.
   */
  qualityRoundInFlight: boolean;
}): QualityPrecondition {
  if (input.standing.ok) return "ok";
  return input.qualityRoundInFlight ? "pending" : "veto";
}

/**
 * MAY THE FUNCTIONAL VERDICT BE RECORDED NOW?
 *
 * The quality precondition, applied at the RECORDING end (2026-09-16). The two
 * judges run together, so a reviewer READY can arrive while the quality round
 * is still thinking — recording it there would ship a round the quality judge
 * never passed, which is exactly the guarantee the parallel design must not
 * cost.
 *
 *  - `record` — the standing is there (a pass, or a recorded skip);
 *  - `hold` — nothing stands YET, and this round's own quality judge is still
 *    able to conclude: the conclusion is parked verbatim and replayed when
 *    that verdict lands (lib/review-adjudicate.ts owns the parking);
 *  - `refuse` — nothing stands and NOBODY is coming back with an answer (the
 *    quality pane died, or the round never dispatched one): fail closed. This
 *    is the same rule `unverified-idle` already follows — a hold with nobody
 *    to end it is a round parked forever.
 */
export function decideQualityHold(input: {
  standing: QualityStandingResult;
  qualityRoundInFlight: boolean;
}): QualityHold {
  const state = qualityPrecondition(input);
  if (state === "ok") return "record";
  return state === "pending" ? "hold" : "refuse";
}

/**
 * THE QUALITY JUDGE'S TASK TEXT — deliberately NOT `buildReviewPrompt`.
 *
 * That prompt is built for the functional reviewer and says so in its first
 * line ("Review for: correctness, edge cases, test coverage quality, doc sync
 * …"): handing it to the quality judge would be asking one question and
 * reading an answer to another. What the two rounds SHARE is the range, the
 * change index and the findings-stream mechanics — and those are passed in
 * rather than re-derived here.
 *
 * The checklist itself is NOT copied into this text: `docs/code-quality-rules.md`
 * is its one substantive home (the same rule the minimalism section already
 * lives under), and the task points at it.
 */
export function buildQualityAuditTask(input: {
  range: string;
  files: readonly string[];
  streamPath: string;
  changeIndex?: string;
  rulesPath: string;
  session?: { dir: string; id: string };
}): string {
  const lines = [
    `You are the quality auditor of this round. You judge the CODE ITSELF, on the commit range ${input.range} — immutable git history, and the only code this round judges. Read it with \`git show\` / \`git diff ${input.range}\`.`,
    "",
    `YOUR CHECKLIST: \`${input.rulesPath}\` — read it FIRST (it is short). It has two layers: L1 (philosophy, architecture, correctness, security, performance) and L2 (simplicity, readability, maintainability). Only L1/L2 P0/P1 findings BLOCK the round; language-specific best practice and formatting are explicitly NOT yours (the repo's own linters own those).`,
    "",
    "THE RANGE IS YOUR SCOPE, THE WHOLE REPOSITORY IS YOUR REFERENCE (the checklist's cross-repository clauses): a new helper that already exists elsewhere, an abstraction that two existing modules could share, a function you are touching that is already this messy. Judge the CHANGED lines, but go read the rest of the repo before concluding that a change stands alone.",
    "",
    "SCOPE QUESTIONS GO TO THE USER, NEVER TO YOURSELF: when a cross-repository finding can only be fixed by changing PRE-EXISTING code (a duplicate to replace, a shared abstraction to unify, a messy function to clean up), call `ask_user` with a 2–4 option question about the scope (fold it into this round / only fix what this round already touches / record it as out of scope) and record the answer in the finding's `issue`. You do NOT widen a round on your own authority.",
    "",
    input.changeIndex && input.changeIndex.trim()
      ? input.changeIndex.trim()
      : `Changed files (${input.files.length}) in ${input.range}:\n${input.files.map((f) => `- ${f}`).join("\n")}`,
    "",
    `You are reviewing COMMIT RANGE ${input.range}: immutable git history — the main session may keep editing the worktree while you judge (its new edits are not part of your range). Judge the range, NEVER the live tree. You have no edit/write tools (edit/write are excluded); \`bash\` is read-only inspection. Read the code first — a concrete doubt buys the minimal verification (docs/judge-protocol.md 「验证纪律」 is the rule); if you do run something, check the reviewed commit out into a THROWAWAY worktree under $TMPDIR (\`git worktree add <tmp> HEAD\`) and run there — never installers inside it (.git is shared). Never run git commit/push or any gh command.`,
  ];
  if (input.session) {
    lines.push(
      "",
      "Main session transcript (fresh context — read ON DEMAND if you need the conversation, not inherited):"
        + ` ${input.session.dir} (file named <timestamp>_${input.session.id}.jsonl)`,
    );
  }
  lines.push("", buildStreamDirective(input.streamPath));
  return lines.join("\n");
}
