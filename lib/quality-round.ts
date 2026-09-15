/**
 * THE QUALITY ROUND — a code-quality review that runs BEFORE the functional
 * one (2026-09-18, user requirement).
 *
 * WHAT IT IS. Every submission already walks a chain inside `judge_submit`:
 * precommit → checkpoint → prepare → dispatch. This module owns the NEW step
 * wedged between prepare and the functional reviewer — the round that judges
 * whether the CODE ITSELF is any good (philosophy / architecture /
 * correctness / performance, then simplicity / readability / maintainability),
 * against a LANGUAGE-NEUTRAL checklist. Only a READY here lets the functional
 * reviewer be dispatched at all.
 *
 * WHY A SEPARATE ROLE. `agents/reviewer.md` had architecture, naming and
 * minimalism clauses already, and in practice almost never raised them: a
 * judge carrying requirement-fit, test coverage and doc-sync at once reads
 * quality as taste, not as a checklist. The measured answer is one judge per
 * question — this file is the mechanical half of the quality judge.
 *
 * WHAT LIVES HERE AND WHY. Only decisions, never effects: which rounds skip
 * the quality judge, whether the functional reviewer may be dispatched, what a
 * recorded quality verdict looks like. `extensions/review-gate.ts` wires them
 * (routing in `submitForReview`, the hand-off on settle, killing the precommit
 * lane) and writes nothing of its own — that file is ~11.6k lines and got
 * there one "just add the check here" at a time.
 *
 * THE TWO HALVES OF A QUALITY PASS, kept apart on purpose:
 *  - `qualityRoundSkip` answers "is there anything to judge at all?" — a
 *    documentation-only round has no code-quality question to ask, so it is
 *    SKIPPED (and the skip is recorded, never silent).
 *  - `qualityStandingFor` answers "may the functional reviewer run now?" — the
 *    mechanical gate that makes the quality round unskippable by accident.
 */

import { buildStreamDirective } from "./review-stream.ts";

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
 * THE PRECONDITION OF THE FUNCTIONAL REVIEW — the one mechanical fact that
 * makes the quality round unskippable by accident.
 *
 * A reviewer may be dispatched only when the CURRENT head carries a quality
 * READY (or the round was skipped as code-free). Everything else fails closed:
 *  - no record at all;
 *  - a record bound to a DIFFERENT head (the content moved after the quality
 *    round judged it — the checkpoint the next submission writes moves HEAD,
 *    which is exactly how a stale pass is caught);
 *  - a recorded BLOCKED.
 *
 * A SKIP is recorded as a READY carrying `skipped`, so this function needs no
 * third state: "the quality round decided there was nothing to judge" and "the
 * quality round judged it" are the same permission, recorded differently.
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
 * WHAT A FINISHED QUALITY ROUND DOES TO THE ROUND IT WAS HOLDING.
 *
 * The hand-off is three separate effects, and each one is right for a reason a
 * reader can check:
 *  - `dispatchReviewer` — the functional round waited for this pass; it runs
 *    now, verbatim (same task text, same findings stream, same target).
 *  - `dropHeld` — a non-READY verdict means the content is ABOUT TO CHANGE, so
 *    the held functional brief describes a round that will never happen.
 *  - `abortLane` — and the full lane still verifying that content has nothing
 *    left to prove either (user requirement: a blocking quality verdict ends
 *    the precommit that runs beside it). This one is independent of `held`: a
 *    blocking verdict on a round nobody was holding still makes the lane's
 *    remaining minutes pointless, and the NEXT submission would wait for a
 *    quiet lane before starting the verification that matters.
 *
 * PURE, so the table below is a test rather than three branches spread through
 * a 12k-line extension.
 */
export interface QualityFollowUp {
  dropHeld: boolean;
  abortLane: boolean;
  dispatchReviewer: boolean;
}

export function qualityFollowUp(input: { verdict: string | undefined; held: boolean }): QualityFollowUp {
  if (input.verdict !== "READY") {
    return { dropHeld: input.held, abortLane: true, dispatchReviewer: false };
  }
  return { dropHeld: false, abortLane: false, dispatchReviewer: input.held };
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
    `YOUR CHECKLIST: \`${input.rulesPath}\` — read it FIRST (it is short). It has two layers: L1 (philosophy, architecture, correctness, performance) and L2 (simplicity, readability, maintainability). Only L1/L2 P0/P1 findings BLOCK the round; language-specific best practice and formatting are explicitly NOT yours (the repo's own linters own those).`,
    "",
    "THE RANGE IS YOUR SCOPE, THE WHOLE REPOSITORY IS YOUR REFERENCE (the checklist's cross-repository clauses): a new helper that already exists elsewhere, an abstraction that two existing modules could share, a function you are touching that is already this messy. Judge the CHANGED lines, but go read the rest of the repo before concluding that a change stands alone.",
    "",
    "SCOPE QUESTIONS GO TO THE USER, NEVER TO YOURSELF: when a cross-repository finding can only be fixed by changing PRE-EXISTING code (a duplicate to replace, a shared abstraction to unify, a messy function to clean up), call `ask_user` with a 2–4 option question about the scope (fold it into this round / only fix what this round already touches / record it as out of scope) and record the answer in the finding's `issue`. You do NOT widen a round on your own authority.",
    "",
    input.changeIndex && input.changeIndex.trim()
      ? input.changeIndex.trim()
      : `Changed files (${input.files.length}) in ${input.range}:\n${input.files.map((f) => `- ${f}`).join("\n")}`,
    "",
    `You are reviewing COMMIT RANGE ${input.range}: immutable git history — the main session may keep editing the worktree while you judge (its new edits are not part of your range). Judge the range, NEVER the live tree. You have no edit/write tools (edit/write are excluded); \`bash\` is read-only inspection. To try something, check the reviewed commit out into a THROWAWAY worktree under $TMPDIR (\`git worktree add <tmp> HEAD\`) and run there — never installers inside it (.git is shared). Never run git commit/push or any gh command.`,
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
