/**
 * Review contract — the ONE reviewer per round, and what it is told.
 *
 * Every review round is a single reviewer over the WHOLE change, judging an
 * IMMUTABLE COMMIT RANGE (`baseline..HEAD`, registered by the extension's
 * `prepare_review`), and its verdict is the only one the gate records
 * (the gate's own recorder reads its structured conclusion off the round's report).
 *
 * NO ENGINE HERE. The reviewer runs in its own tmux pane (interactive pi, gate in judge mode)
 * (dispatched by `judge_submit`); the subagent dispatch surface was retired
 * 2026-09-06 with the pi-subagents companion. Every function in this file
 * is pure over strings, so the reviewer contract can be pinned by tests
 * with no workflow engine, no git and no filesystem.
 */

/**
 * One step of the recorded precommit (cache entry), for the baseline block.
 */
export interface PrecommitBaselineStep {
  name: string;
  command: string;
  status: string;
  durationMs?: number;
}

/**
 * The recorded precommit facts, as read by `prepare_review` from the sidecar
 * and the precommit cache.
 */
export interface PrecommitBaselineFact {
  verdict: string;
  mode?: string;
  testScope?: string;
  at?: string;
  steps: PrecommitBaselineStep[];
}

/**
 * The trusted-checks block injected into the reviewer's task text.
 *
 * The full suite and typecheck ALREADY ran as part of precommit before this
 * review was prepared; a reviewer re-running them burns minutes per round for
 * zero new information. The block states what was verified and when, and
 * steers the reviewer to targeted tests + mutation checks on the code under
 * scrutiny, with an explicit reopen clause for evidence of staleness. Pure
 * over strings so the wording is testable.
 */
export function formatPrecommitBaseline(f: PrecommitBaselineFact): string {
  const lines = [
    "PRE-COMMIT BASELINE — these checks ALREADY ran and passed before this review was prepared:",
    `- precommit: ${f.verdict}` +
      ((f.mode || f.testScope || f.at)
        ? ` (${[f.mode ? `mode ${f.mode}` : "", f.testScope ? `tests ${f.testScope}` : "", f.at ?? ""].filter(Boolean).join(", ")})`
        : ""),
    ...f.steps.map((s) =>
      `- ${s.name}: ${s.status} — \`${s.command}\`` +
      (s.durationMs !== undefined ? ` (${Math.round(s.durationMs / 1000)}s)` : "")),
    // The TRUST wording is lane-aware (round-9 P1): a FULL pass means the
    // whole suite ran on this tree — do not re-run it. A FAST/related lane
    // covered only the related tests, so the reviewer may need to re-run
    // things; it must never be talked out of verification the lane did not
    // provide.
    ...(f.testScope === "full"
      ? [
          "TRUST IT — do NOT re-run the full suite or typecheck: that is exactly the time the baseline just",
          "spent, for zero new signal. Run ONLY targeted tests for the files you examine (e.g. `node --test",
          "test/<file>.test.ts`) and mutation checks on the specific code under scrutiny.",
        ]
      : [
          `The recorded precommit is the ${f.testScope ?? "unknown"} lane — it covered only the related tests,`,
          "not the whole suite. Run the targeted tests for the files you examine; re-run the full suite or",
          "typecheck only if you have reason to doubt the fast lane.",
        ]),
    "If you have evidence a baseline step is stale for THIS change, say so and re-run only that one step.",
  ];
  return lines.join("\n");
}

/**
 * The sidecar precommit fields the baseline trusts (subset of GateState.precommit).
 */
export interface PrecommitBaselineRecord {
  verdict: string;
  fingerprint?: string | null;
  mode?: string;
  testScope?: string;
  at?: string | null;
}

/**
 * Decide the baseline facts from the sidecar record, the CURRENT worktree
 * fingerprint digest and the raw precommit-cache file body.
 *
 * PURE and behaviorally testable (round-10 P1): the fingerprint match is
 * what makes a recorded PASS this round's evidence (a PASS for an older tree
 * yields undefined), and cache entries recorded AFTER the PASS are stale and
 * skipped. Undefined ⇒ the reviewer must decide on its own.
 */
export function extractPrecommitBaseline(
  pc: PrecommitBaselineRecord | undefined,
  currentDigest: string | undefined,
  cacheRaw: string | undefined,
): string | undefined {
  if (!pc || pc.verdict !== "PASS" || !pc.fingerprint) return undefined;
  if (currentDigest === undefined || pc.fingerprint !== currentDigest) return undefined;
  const steps: PrecommitBaselineStep[] = [];
  if (cacheRaw) {
    try {
      const cache = JSON.parse(cacheRaw);
      const passAt = pc.at ? Date.parse(pc.at) : NaN;
      for (const [name, e] of Object.entries((cache as { entries?: Record<string, Record<string, unknown>> }).entries ?? {})) {
        if (e && typeof e.command === "string" && (e.status === "pass" || e.status === "skip")) {
          const entryAt = typeof e.at === "string" ? Date.parse(e.at) : NaN;
          if (Number.isFinite(passAt) && Number.isFinite(entryAt) && entryAt > passAt) continue;
          steps.push({
            name,
            command: e.command,
            status: e.status === "pass" ? "passed" : "skipped",
            ...(typeof e.durationMs === "number" ? { durationMs: e.durationMs } : {}),
          });
        }
      }
    } catch { /* unparseable cache: the verdict line alone still helps */ }
  }
  return formatPrecommitBaseline({
    verdict: pc.verdict,
    ...(pc.mode ? { mode: pc.mode } : {}),
    ...(pc.testScope ? { testScope: pc.testScope } : {}),
    ...(pc.at ? { at: pc.at } : {}),
    steps,
  });
}

// Pure module: no engine, no I/O. The extension spawns the reviewer as its own
// pi process via judge_submit; this file only decides WHAT to say
// to the reviewer and what verdict shape to hand it as its outputSchema.
import { buildStreamDirective } from "./review-stream.ts";
import { JUDGE_COMPLETION_DISCIPLINE } from "./gate-modes.ts";

/**
 * Shape of a single reviewer's structured verdict. Handed to the spawned
 * reviewer as its `outputSchema` (see REVIEW_VERDICT_SCHEMA below); the
 * recorded verdict is the same shape, taken verbatim off the round's channel
 * report and adjudicated by lib/review-adjudicate.ts.
 */
export interface ReviewVerdict {
  gate: "READY" | "BLOCKED" | "NEEDS_HUMAN";
  /**
   * The directory the reviewer ACTUALLY ran in, from its own `pwd`.
   *
   * What it is, stated without embellishment (round-11 P1): a self-reported
   * consistency check. The gate's verdict recorder compares this string with the repo the
   * round was prepared for and downgrades a READY that does not match. So it
   * rejects a MISMATCHING report — a review run against the wrong repo — and
   * nothing else.
   *
   * It proves nothing. The value is supplied by the reviewed party, and the
   * gate never reads `paneCurrentPath`, so any value equal to the repo root
   * passes, fabricated or not. Calling it identity evidence would be the same
   * over-claim the field exists to catch. (Measuring the pane would not fix
   * that either: a finished judge's pane is gone before the verdict lands.)
   *
   * The prompt still insists on a real `pwd` rather than copying the path out
   * of the task text — an honest reviewer reports what it measured, and that
   * is the case this check can act on.
   */
  cwd: string;
  /**
   * Code↔docs attestation, REQUIRED on the single-review path: no second
   * reviewer carries it, so the reviewer itself must attest (the gate
   * fails closed on a missing attestation).
   */
  docSync: "UPDATED" | "NOT_NEEDED";
  findings: Array<{
    file: string;
    line: number;
    severity: "P0" | "P1" | "P2" | "Nit";
    issue: string;
    /** Where to look, when file:line is not enough. Optional by design. */
    evidence?: string;
  }>;
}

/**
 * Verdict JSON schema enforced on the reviewer. `docSync` is REQUIRED on the
 * single-review path: there is no second reviewer to carry the
 * attestation, so the reviewer itself must attest code↔docs (the gate fails
 * closed on a missing attestation — see lib/gate-state.ts).
 *
 * There is NO `notes` field, on purpose (2026-09-04): a reviewer's conclusion
 * is its verdict plus its findings, its prose was never read by anything, and
 * `judge_conclude` refuses a `notes` argument from this role outright. Not
 * offering the field is what actually stops the prose from being written.
 */
export const REVIEW_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    gate: { type: "string", enum: ["READY", "BLOCKED", "NEEDS_HUMAN"] },
    cwd: {
      type: "string",
      description:
        "Absolute path you actually ran in, taken from your own `pwd` — not copied from the task text. " +
        "The gate checks it against the repo this round was prepared for.",
    },
    docSync: { type: "string", enum: ["UPDATED", "NOT_NEEDED"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          severity: { type: "string", enum: ["P0", "P1", "P2", "Nit"] },
          issue: { type: "string" },
          evidence: { type: "string" },
        },
        required: ["file", "line", "severity", "issue"],
      },
    },
  },
  // `cwd` is REQUIRED so that a mismatching report is actually visible: an
  // optional field would simply be omitted by the models that most need the
  // check. It is a consistency check on a self-reported value, not proof of
  // who produced the verdict — see the field's doc comment.
  required: ["gate", "cwd", "docSync", "findings"],
} as const;

// ---------------------------------------------------------------------------
// THE CHANGE INDEX
//
// WHY THIS EXISTS (2026-09-10). A round's reviewer was handed a commit range
// and a bare list of file names, then left to find out what happened in them
// one `git show` at a time. MEASURED over every reviewer session in this repo:
// 92.5% of its assistant messages carried exactly ONE tool call (mean 1.08),
// each round took 17-59 model round-trips at 11-13s, and tool execution was
// 6% of the round — the rest was the model waiting on itself, once per file.
// pi runs the tool calls of ONE assistant message IN PARALLEL, so the cure is
// not a smaller diff: it is telling the reviewer what moved and handing it a
// batch plan it can fire off in a single message.
//
// IT DOES NOT REPLACE READING HISTORY. The reviewer still runs
// `git diff <range>` against real commits — this is an INDEX and a read plan,
// never a copy of the diff. (That distinction is load-bearing: a per-reviewer
// diff copy used to exist and was deleted, because a copy can drift from the
// range it claims to describe.)
// ---------------------------------------------------------------------------

/** One row of `git diff --numstat`: what moved in one file. */
export interface ChangeIndexRow {
  file: string;
  /** Added lines. Binary files report 0 (git's `-`). */
  added: number;
  /** Deleted lines. Binary files report 0 (git's `-`). */
  deleted: number;
}

/** Rows listed individually before the rest are summarised. */
export const CHANGE_INDEX_MAX_ROWS = 40;
/** Changed lines a batch may carry before the next file starts a new one. */
export const CHANGE_INDEX_BATCH_LINES = 400;
/** Files a batch may carry, whatever their size. */
export const CHANGE_INDEX_BATCH_FILES = 4;

/**
 * Group the changed files into read batches — a pure greedy bin packing.
 *
 * BIG FILES COME FIRST AND GET THEIR OWN BATCH, which is the point: a
 * 600-line file and a 3-line one do not belong in one `git diff`, because the
 * reviewer then has to read the small one to find the large one. Batches are
 * capped by BOTH a line budget and a file count, so neither a few huge files
 * nor a hundred tiny ones can produce an unusable command.
 *
 * Order is preserved inside a batch (the caller's order, which is largest
 * first), so a batch reads top-down like the change itself.
 */
export function planChangeBatches(
  rows: readonly ChangeIndexRow[],
  limits: { maxLines?: number; maxFiles?: number } = {},
): ChangeIndexRow[][] {
  const maxLines = limits.maxLines ?? CHANGE_INDEX_BATCH_LINES;
  const maxFiles = limits.maxFiles ?? CHANGE_INDEX_BATCH_FILES;
  const batches: ChangeIndexRow[][] = [];
  let current: ChangeIndexRow[] = [];
  let lines = 0;
  for (const row of rows) {
    const cost = Math.max(1, row.added + row.deleted);
    // An empty batch always takes the file: a single file larger than the
    // budget must still be read, and refusing to start a batch for it would
    // drop it from the plan entirely.
    if (current.length > 0 && (lines + cost > maxLines || current.length >= maxFiles)) {
      batches.push(current);
      current = [];
      lines = 0;
    }
    current.push(row);
    lines += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * The change index block injected into the reviewer's task text.
 *
 * It answers two questions the old task text left open — WHAT moved, and HOW
 * to read it without spending a model round-trip per file — and it answers
 * them with commands, not advice: the batches are ready to paste, and the
 * batching is already done by the gate (philosophy one: the agent expresses
 * intent, the gate performs the act).
 *
 * PURE over its inputs, so the wording and the batching are both testable
 * without a repository.
 */
export function formatChangeIndex(rows: readonly ChangeIndexRow[], commitRange: string): string {
  if (rows.length === 0) return "";
  const shown = rows.slice(0, CHANGE_INDEX_MAX_ROWS);
  const hidden = rows.length - shown.length;
  const added = rows.reduce((n, r) => n + r.added, 0);
  const deleted = rows.reduce((n, r) => n + r.deleted, 0);

  const lines = [
    `CHANGE INDEX — ${rows.length} file(s), +${added}/−${deleted} in ${commitRange} (largest first):`,
    ...shown.map((r) => `- +${r.added}/−${r.deleted}  ${r.file}`),
  ];
  if (hidden > 0) {
    lines.push(`- … and ${hidden} more file(s) not listed here (run \`git diff --stat ${commitRange}\` for the rest).`);
  }

  const batches = planChangeBatches(shown);
  lines.push(
    "",
    "READ IT IN BATCHES — the tool calls of ONE message run IN PARALLEL, so several reads in one message cost",
    "one model turn instead of one per file. These batches are pre-split (largest files first); issue the ones",
    "you need in a single message, and skip what the change cannot affect:",
    ...batches.map((b, i) => `${i + 1}. git diff ${commitRange} -- ${b.map((r) => r.file).join(" ")}`),
  );
  if (hidden > 0) {
    lines.push(
      `${batches.length + 1}. git diff ${commitRange} -- $(git diff --name-only ${commitRange} | tail -n +${
        CHANGE_INDEX_MAX_ROWS + 1
      })`,
    );
  }
  return lines.join("\n");
}

/**
 * The base review prompt handed to the ONE reviewer.
 *
 * `isolation` is the SAFETY-CRITICAL argument. It says the reviewer runs as
 * its own judge child, so it may check the reviewed range out into a THROWAWAY
 * worktree and mutate freely there; a reviewer with no isolation must be told
 * the opposite, because the engine-level denylist only removes the edit/write
 * TOOLS — `bash` stays, and a reviewer that had been promised "you may edit
 * freely" would happily rewrite the user's files through it. Omitting the
 * argument therefore means "no isolation": the read-only contract is the
 * DEFAULT, and the permissive one has to be granted explicitly.
 */
export function buildReviewPrompt(
  label: string,
  files: string[],
  goalText?: string,
  repoRoot?: string,
  isolation?: { streamPath: string; commitRange: string },
  scopeDirective?: string,
  /**
   * The DECISION kind driving the opening instruction (round-3 P1 fix): a
   * non-empty scopeDirective does NOT imply incremental — prepare_review
   * always passes a formatted directive, and a no-baseline/escalated round
   * yields a FULL block. Only an explicit "incremental" opens with the
   * increment wording; anything else audits the whole change.
   */
  scopeKind?: "full" | "incremental",
  session?: { dir: string; id: string },
  precommitBaseline?: string,
  /**
   * The reason the MAIN session gave for opening this round while the gate
   * was already met (round-18 polish gate). Injected verbatim so the
   * reviewer can judge whether this round should exist at all.
   */
  polishReason?: { reason: string; at: string; round: number } | undefined,
  /**
   * THE CHANGE INDEX (see {@link formatChangeIndex}) — what moved, and the
   * pre-split batch plan that reads it in one message instead of one
   * round-trip per file. Absent ⇒ the bare file list is rendered instead
   * (the cheap fallback: an older caller, a test fixture, an empty range).
   */
  changeIndex?: string,
): string {
  const streamPath = isolation?.streamPath;
  const range = isolation?.commitRange ?? "baseline..HEAD";
  const lines = [
    // Empty range: nothing to diff — the round audits ONLY the exit goal.
    // The reviewer judges whether the task is DONE (goal met), not a diff.
    files.length === 0 && range.split("..")[0] === range.split("..")[1]
      ? "You are the reviewer of this round. There is NO code change to audit (empty commit range " + `${range}` + ") this round exists to verify the EXIT GOAL is met. Check the loop goal below criterion by criterion (accept only if EVERY criterion is verifiably met), confirm the worktree is clean, and report a READY only when the task is genuinely done. A BLOCKED with findings is the correct verdict when any criterion is unmet or unverifiable."
      : scopeKind === "incremental"
        // SUMMARY + POINTER, never a second copy of the contract: the scope
        // block further down IS the contract (rendered by
        // lib/review-carryover.ts, the one authoritative source). Restating
        // its clauses here is how the two used to drift.
        ? "You are the reviewer of this round, and this round is INCREMENTAL. The \"Review scope for this round\" block below states the contract you work under — deep-audit the increment it names, re-check the findings it lists, and read its clauses on what a consistency scan is and when a settled conclusion may be reopened. That block is the authority; nothing here overrides it. Verify from the code (never guess), and report findings with file paths and line numbers."
        : `You are the reviewer of this round. Audit the COMMIT RANGE ${range} below — immutable git history, and the ONLY thing this round judges. Read it with \`git show\` / \`git diff ${range}\`, verify from the code (never guess), and report findings with file paths and line numbers.`,
    // THE CHANGE INDEX replaces the bare name list whenever prepare computed
    // one: it carries every changed file WITH its line counts and a pre-split
    // batch plan, so the plain list would be a second, poorer copy of the same
    // fact. MEASURED (2026-09-10): without it the reviewer found out what
    // happened one `git show` per message — 92.5% of its messages carried a
    // single tool call, and tool execution was 6% of a 226-285s round.
    ...(changeIndex && changeIndex.trim()
      ? [changeIndex.trim()]
      : [
          `Changed files (${files.length}) in ${range}:`,
          files.map((f) => `- ${f}`).join("\n"),
        ]),
    "",
    "Review for: correctness, edge cases, test coverage quality, doc sync for the behavior you see, unintended side effects, and impossibility claims (TODO/FIXME/skipped tests).",
    // Commit isolation (2026-08-27 execution model): the change under review
    // is IMMUTABLE git history, so the main session may keep editing the
    // worktree while the review runs — its new edits simply are not part of
    // the judged range. Verification happens in a THROWAWAY checkout.
    isolation
      ? `You are reviewing COMMIT RANGE ${range}: immutable git history — the main session may keep editing the worktree while you judge (its new edits are not part of your range). Judge the range with \`git show\` / \`git diff\`, NEVER the live tree. You have no edit/write tools (edit/write are excluded); \`bash\` is read-only inspection. To run tests or mutations, check the reviewed commit out into a THROWAWAY worktree under $TMPDIR (\`git worktree add <tmp> HEAD\`) and run there — never installers inside it (.git is shared). A test run directly in the live worktree is ADVISORY: the main session may be editing it, so results may be polluted. Never run git commit/push or any gh command.`
      : "You are reading the USER'S LIVE WORKTREE, and the main agent may be working in it. Do NOT edit any file. Do NOT run tests that write files. `bash` is read-only inspection only (git diff/log/show, reading files). Never run git commit/push or any gh command. Report what you find.",
  ];
  if (streamPath) lines.push("", buildStreamDirective(streamPath));
  // NOTE: the `diff` field and its prompt block are gone. Nothing produces a
  // per-reviewer diff any more, and nothing should: the reviewer judges an
  // immutable commit range, so it runs `git show` / `git diff baseline..HEAD`
  // against real history instead of reading a copy that may have drifted.
  // Keeping a dead field invites someone
  // to "restore" the weaker path.
  if (goalText && goalText.trim()) {
    lines.push("", "Loop goal (accept the change against it, criterion by criterion):", goalText.trim());
  }

  // Incremental scope (round 2+ with a READY baseline): the directive above
  // tells the reviewer what was already settled, what is new this round, and
  // which findings must be re-checked. Absent (no baseline, escalation to
  // full, or a caller that did not compute one) the reviewer audits the whole
  // change as the opening line says.
  if (scopeDirective && scopeDirective.trim()) {
    lines.push("", scopeDirective.trim());
  }

  // Round-18 polish gate: this round exists only because the main session
  // said WHY. Give the reviewer that reason verbatim — it is part of what
  // this round is judged against ("does this round deserve to exist?").
  if (polishReason && polishReason.reason.trim()) {
    lines.push(
      "",
      `REASON FOR THIS ROUND (given by the main session while the gate was already met, round ${polishReason.round} at ${polishReason.at}):`
      + ` ${polishReason.reason.trim()}`
    );
  }

  // Fresh-context pointer (goal criterion 4): the reviewer no longer forks
  // the main session, so when the conversation itself matters it reads the
  // transcript ON DEMAND instead of inheriting it.
  if (session) {
    lines.push(
      "",
      `Main session transcript (fresh context — read ON DEMAND if you need the conversation, not inherited):`
      + ` ${session.dir} (file named <timestamp>_${session.id}.jsonl)`
    );
  }



  // Trusted-checks baseline (user ask, 2026-08-27): precommit already ran the
  // full suite + typecheck before the review was prepared — the reviewer
  // re-running them wastes minutes per round. Injected only when a PASS is on
  // record; absent, the reviewer decides on its own.
  if (precommitBaseline && precommitBaseline.trim()) {
    lines.push("", precommitBaseline.trim());
  }

  lines.push(
    "",
    "OUTPUT: call judge_conclude and stop (the gate records it; docSync is REQUIRED on the single-review path). Everything you have to say goes in that call — there is no prose section, and this role's call has no notes parameter.",
    // The prompt asks for a MEASURED `pwd`, not one copied out of this text —
    // a copied value says nothing about where the review actually happened,
    // and only a measured one makes the check below meaningful.
    //
    // BOTH branches make the same promise, because since round-9 the gate
    // really does compare it: the verdict recorder checks the reported cwd against
    // the repo THIS ROUND WAS PREPARED FOR and downgrades a READY that reports
    // something else. (That is all it does — see the `cwd` field's doc
    // comment.) Telling the reviewer otherwise on one branch would be the same
    // class of lie this field exists to catch.
    'Before you answer, run `pwd` and pass its output as the call\'s "cwd" field. Report what the command printed — do NOT copy the path out of this task text.' +
      " The gate matches it against the repo this round was prepared for" +
      (isolation
        ? " (the shared repo root), so `cd` back there before you answer if you ended up inside your throwaway worktree."
        : "."),
    // eslint-disable-next-line max-len
    'Conclude shape: judge_conclude({verdict: "READY"|"BLOCKED"|"NEEDS_HUMAN", cwd: "<your real pwd>", docSync: "UPDATED"|"NOT_NEEDED", findings: [{"file": "...", "line": 1, "severity": "P0|P1|P2|Nit", "issue": "...", "evidence": "<optional — omit when file:line says it>"}]})',
    "Severity: P0 = must fix now, P1 = must fix before ship, P2 = should fix, Nit = optional. Any open P0/P1 ⇒ BLOCKED.",
    // Round-17 (user ask), tightened 2026-09-04: the gate consumes ONLY the
    // conclude call and the finding stream. There is no `notes` parameter for
    // this role — passing one is refused — so the conclusion has nowhere to
    // become prose, and prose after the call is read by nobody.
    "输出纪律:交卷即停 —— 调完 judge_conclude 就结束本轮,不写复述、不写自评、不写过程说明;结论就是 verdict + findings(能给证据就填 evidence)。",
    "",
    JUDGE_COMPLETION_DISCIPLINE,
  );
  return lines.join("\n");
}
