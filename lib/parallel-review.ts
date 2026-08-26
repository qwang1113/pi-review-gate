/**
 * Review planning — how a change is split, and what each reviewer is told.
 *
 * Tiered: small diffs (<20 files AND <500 lines) get the default cross-family
 * reviewers over the whole change; large diffs are split into ≤4 DISJOINT
 * groups covering every changed file. Shard verdicts carry NO docSync — the
 * integration review that follows attests it. Worst verdict wins.
 *
 * NO ENGINE HERE. Reviews are dispatched by the extension (`prepare_review` +
 * plain subagents), because the pdw engine discards a per-agent `cwd` and a
 * reviewer must hold its OWN snapshot of the change it judges (see
 * docs/handoff-remove-pdw.md). Every function in this file is pure over file
 * names and strings, so the split and the reviewer contract can be pinned by
 * tests with no workflow engine, no git and no filesystem.
 */

// Pure module: no engine, no snapshots, no I/O. Reviews are dispatched by the
// extension (prepare_review + subagents); this file only decides HOW to split
// them and WHAT to say to each reviewer.
import { buildStreamDirective } from "./review-stream.ts";

/** Tiered trigger thresholds: a diff meeting either bound triggers sharding. */
export const SHARD_THRESHOLD_FILES = 20;
export const SHARD_THRESHOLD_LINES = 500;

/**
 * Decide whether a diff is large enough to warrant parallel shard review.
 * Returns true when EITHER threshold is met (OR logic: a single 600-line
 * file and a 30-file formatting change both benefit from sharding).
 */
export function shouldShardReview(fileCount: number, lineCount: number): boolean {
  return fileCount >= SHARD_THRESHOLD_FILES || lineCount >= SHARD_THRESHOLD_LINES;
}

/** One shard: a disjoint set of changed files one reviewer audits. */
export interface ReviewShard {
  label: string;
  files: string[];
  /** One-line context for the shard reviewer (why this shard exists). */
  note: string;

}

export interface ShardReviewPlan {
  shards: ReviewShard[];
  fileCount: number;
}

/**
 * Shape of a shard reviewer's structured verdict. Handed to the spawned
 * reviewer as its `outputSchema` (see SHARD_VERDICT_SCHEMA below); the recorded
 * verdict itself is parsed by the gate's own all-fence parser.
 */
export interface ShardVerdict {
  gate: "READY" | "BLOCKED" | "NEEDS_HUMAN";
  /**
   * The directory the reviewer ACTUALLY ran in, from its own `pwd`.
   *
   * Second, independent piece of evidence that the reviewer was inside the
   * snapshot prepared for it (the first is the spawn the gate observed). It
   * also catches the case the spawn guard cannot see: a reviewer pointed at its
   * snapshot correctly that then `cd`-ed into the live worktree. The prompt
   * insists on a real `pwd` rather than copying the path out of the task text,
   * because a copied value proves nothing.
   */
  cwd: string;
  findings: Array<{
    file: string;
    line: number;
    severity: "P0" | "P1" | "P2" | "Nit";
    issue: string;
  }>;
  notes?: string;
}

/**
 * Split changed files into balanced, disjoint review shards.
 *
 * Balancing uses per-file weights (default 1 per file; callers may pass a
 * size estimate such as changed line counts). The greedy sweep keeps at most
 * `maxShards` shards and never produces an empty shard. A single file always
 * lands in exactly one shard.
 */
export function planReviewShards(
  files: readonly string[],
  opts?: { maxShards?: number; weights?: Record<string, number> },
): ShardReviewPlan {
  const maxShards = Math.max(1, Math.min(opts?.maxShards ?? 4, files.length || 1));
  const weights = opts?.weights ?? {};
  const weightOf = (f: string): number => {
    const w = weights[f];
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 1;
  };
  const total = files.reduce((acc, f) => acc + weightOf(f), 0);
  if (total <= 0 || files.length === 0) return { shards: [], fileCount: 0 };

  const target = total / maxShards;
  const shards: ReviewShard[] = [];
  let current: string[] = [];
  let currentWeight = 0;
  const pushCurrent = (): void => {
    if (current.length > 0) {
      shards.push({
        label: `shard-${shards.length + 1}`,
        files: current,
        note: `${current.length} file(s)`,
      });
      current = [];
      currentWeight = 0;
    }
  };
  for (const file of files) {
    const w = weightOf(file);
    if (current.length > 0 && currentWeight + w > target && shards.length < maxShards - 1) {
      pushCurrent();
    }
    current.push(file);
    currentWeight += w;
  }
  pushCurrent();
  return { shards, fileCount: files.length };
}

/**
 * Verdict JSON schema enforced on every shard reviewer (no docSync: a shard
 * cannot attest the whole change — the integration review does).
 */
export const SHARD_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    gate: { type: "string", enum: ["READY", "BLOCKED", "NEEDS_HUMAN"] },
    cwd: {
      type: "string",
      description:
        "Absolute path you actually ran in, taken from your own `pwd` — not copied from the task text. " +
        "The gate checks it against the snapshot prepared for you.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          severity: { type: "string", enum: ["P0", "P1", "P2", "Nit"] },
          issue: { type: "string" },
        },
        required: ["file", "line", "severity", "issue"],
      },
    },
    notes: { type: "string" },
  },
  // `cwd` is REQUIRED: it is one of the two independent proofs that the
  // reviewer ran inside its snapshot, and an optional field would simply be
  // omitted by the models that most need to be checked.
  required: ["gate", "cwd", "findings"],
} as const;

/**
 * Build the review prompt handed to one shard reviewer.
 *
 * `isolation` is the SAFETY-CRITICAL argument. A shard that got its own
 * snapshot may edit and mutate freely; a shard running in the LIVE worktree
 * (isolation unavailable) must be told the opposite, because the engine-level
 * denylist only removes the edit/write TOOLS — `bash` stays, and a reviewer
 * that had been promised "you are in a disposable copy" would happily rewrite
 * the user's files through it. Omitting the argument therefore means "no
 * snapshot": the read-only contract is the DEFAULT, and the permissive one has
 * to be granted explicitly.
 */
export function buildShardPrompt(
  shard: ReviewShard,
  goalText?: string,
  repoRoot?: string,
  isolation?: { streamPath: string },
): string {
  const streamPath = isolation?.streamPath;
  const lines = [
    "You are a shard reviewer in a PARALLEL review run. Audit ONLY the files listed below — other files are covered by other reviewers. Read each file in the worktree, verify from the code (never guess), and report findings with file paths and line numbers.",
    "",
    `Shard ${shard.label} (${shard.note}):`,
    shard.files.map((f) => `- ${f}`).join("\n"),
    "",
    "Review for: correctness, edge cases, test coverage quality, doc sync for THIS shard's behavior, unintended side effects, and impossibility claims (TODO/FIXME/skipped tests).",
    isolation
      // In a THROWAWAY SNAPSHOT of the change under review, mutation analysis
      // (delete the code, prove the test fails) is the strongest check there is.
      ? "You are running inside a disposable snapshot worktree of the change under review — NOT the user's live worktree. You may edit files and run tests freely, including mutation analysis: delete or break the code a test claims to cover and confirm the test actually fails. RESTORE every mutation before you finish: the gate re-derives this snapshot's tree afterwards, and a snapshot left modified means your final checks ran against your own edits, so a READY from you will not be accepted. Write scratch files OUTSIDE the snapshot (use $TMPDIR), and never write under `node_modules` (it is a symlink to the real repository). Never run git commit/push or any gh command."
      // No snapshot: this IS the user's worktree and the main agent may be
      // working in it. Read-only, exactly as before snapshot isolation existed.
      : "You are reading the USER'S LIVE WORKTREE — snapshot isolation was unavailable for this run, and the main agent may be editing it right now. Do NOT edit any file. Do NOT run tests that write files. `bash` is read-only inspection only (git diff/log/show, reading files). Never run git commit/push or any gh command. Report what you find; verifying by mutation is not available this round.",
  ];
  if (streamPath) lines.push("", buildStreamDirective(streamPath));
  // NOTE: the `diff` field and its prompt block are gone. Nothing produces a
  // per-shard diff any more, and nothing should: the reviewer holds a snapshot
  // of the change, so it runs `git diff HEAD` against the real thing instead of
  // reading a copy that may have drifted. Keeping a dead field invites someone
  // to "restore" the weaker path.
  if (goalText && goalText.trim()) {
    lines.push("", "Loop goal (accept the change against it, criterion by criterion):", goalText.trim());
  }
  lines.push(
    "",
    "OUTPUT: fenced JSON verdict FIRST (the gate parses it; no docSync field — the integration reviewer attests docs), then a prose review below the fence.",
    // The reviewer's own `pwd` is EVIDENCE, and only if it is measured: a value
    // copied out of this prompt would prove nothing about where the review
    // actually happened, which is precisely the failure this field exists for.
    //
    // The SECOND sentence is branch-specific. Promising "the gate checks it
    // against the snapshot prepared for you" on the no-isolation branch
    // contradicts the paragraph above it (which just said there is no snapshot
    // this round) and could push a literal-minded reviewer into a needless
    // non-READY.
    'Before you answer, run `pwd` and put its output in the verdict\'s "cwd" field. Report what the command printed — do NOT copy the path out of this task text.' +
      (isolation
        ? " The gate checks it against the snapshot prepared for you, and a reviewer that ran outside its snapshot cannot approve the change."
        : " There is no snapshot this round, so this only records where you read; the gate does not match it against one."),
    'Verdict shape: {"gate": "READY"|"BLOCKED"|"NEEDS_HUMAN", "cwd": "<your real pwd>", "findings": [{"file": "...", "line": 1, "severity": "P0|P1|P2|Nit", "issue": "..."}], "notes": "<prose review>"}',
    "Severity: P0 = must fix now, P1 = must fix before ship, P2 = should fix, Nit = optional. Any open P0/P1 ⇒ BLOCKED.",
  );
  return lines.join("\n");
}

// NOTE: `runParallelShardReview` and `generateShardReviewScript` used to live
// here. Review does NOT run through the pdw engine any more.
//
// WHY (measured, not assumed): the engine discards a per-agent `cwd` — its
// `runCwd` comes only from its own `isolation: "worktree"`, which checks out
// HEAD and therefore does not contain the change under review. Shard reviewers
// could never hold their own snapshot of what they were judging, so they shared
// the live worktree: colliding with each other, with the main agent's fixes,
// and with the tree the gate fingerprints. Keeping the engine here would have
// meant one shared snapshot and read-only shards — i.e. giving up mutation
// analysis, the strongest check a reviewer has.
//
// Reviews are now dispatched as ordinary subagents: pi-subagents honors a
// per-call `cwd` and enforces a structured `outputSchema`, so every reviewer
// gets its own disposable WRITABLE snapshot. `prepare_review` (the extension)
// computes the shard plan with `planReviewShards` below, so the split stays
// mechanical rather than improvised by whoever is spawning.
//
// What remains here is pure and used in production: the tiered threshold, the
// shard planner, the per-shard prompt, the verdict SCHEMA handed to each spawned
// reviewer, and the record merger.
//
// `parseShardVerdict` and `DEFAULT_REVIEWER_MODEL` were deleted with the engine:
// the engine parsed structured results itself and needed a model spec for the
// script, whereas a spawned reviewer's verdict is parsed by the gate's own
// all-fence parser (`lib/verdict-parse.ts`) and its model comes from the pinned
// agent definition. Keeping them "just in case" is exactly the dead code this
// repo's reviewers keep (correctly) flagging.
//
// The engine is still a hard dependency for wave workers and the decompose
// module loop — docs/handoff-remove-pdw.md plans its retirement there.

/**
 * Render every shard's full raw output as one recordable review block — the
 * Phase A record the main agent feeds to `record_review` (shard fences omit
 * docSync by design; the integration review's record carries it).
 *
 * record_review's parser only recognizes fenced JSON, and a production shard
 * result arrives as a bare structured value — so any shard output that does
 * not already carry a ```json fence gets wrapped in one. The verdict object
 * inside is preserved verbatim.
 */
export function formatShardReviewRecord(
  shards: Array<{ label: string; output: string }>,
): string {
  return shards
    .map((s) => {
      const raw = s.output.trim();
      const fenced = /```(?:json)?\s*\n/.test(raw) ? raw : "```json\n" + raw + "\n```";
      return `### ${s.label}\n\n${fenced}`;
    })
    .join("\n\n---\n\n");
}

// (`generateShardReviewScript` deleted with the engine review path — see the
// note above. Nothing generates a workflow script for reviews any more.)
