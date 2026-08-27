/**
 * Review contract — the ONE reviewer per round, and what it is told.
 *
 * Every review round is a single reviewer over the WHOLE change, holding its
 * OWN disposable snapshot (created by the extension's `prepare_review`), and
 * its verdict is the only one the gate records (`record_review` parses every
 * fence; worst verdict wins if multiple appear).
 *
 * NO ENGINE HERE. Reviews are dispatched by the extension (`prepare_review` +
 * plain subagents), because the pdw engine discards a per-agent `cwd` and a
 * reviewer must hold its OWN snapshot of the change it judges. Every function
 * in this file is pure over strings, so the reviewer contract can be pinned by
 * tests with no workflow engine, no git and no filesystem.
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


// Pure module: no engine, no snapshots, no I/O. Reviews are dispatched by the
// extension (prepare_review + subagents); this file only decides WHAT to say
// to the reviewer and what verdict shape to hand it as its outputSchema.
import { buildStreamDirective } from "./review-stream.ts";

/**
 * Shape of a single reviewer's structured verdict. Handed to the spawned
 * reviewer as its `outputSchema` (see REVIEW_VERDICT_SCHEMA below); the
 * recorded verdict itself is parsed by the gate's own all-fence parser.
 */
export interface ReviewVerdict {
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
  }>;
  notes?: string;
}

/**
 * Verdict JSON schema enforced on the reviewer. `docSync` is REQUIRED on the
 * single-review path: there is no second reviewer to carry the
 * attestation, so the reviewer itself must attest code↔docs (the gate fails
 * closed on a missing attestation — see lib/gate-state.ts).
 */
export const REVIEW_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    gate: { type: "string", enum: ["READY", "BLOCKED", "NEEDS_HUMAN"] },
    cwd: {
      type: "string",
      description:
        "Absolute path you actually ran in, taken from your own `pwd` — not copied from the task text. " +
        "The gate checks it against the snapshot prepared for you.",
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
        },
        required: ["file", "line", "severity", "issue"],
      },
    },
    notes: { type: "string" },
  },
  // `cwd` is REQUIRED: it is one of the two independent proofs that the
  // reviewer ran inside its snapshot, and an optional field would simply be
  // omitted by the models that most need to be checked.
  required: ["gate", "cwd", "docSync", "findings"],
} as const;

/**
 * Build the review prompt handed to the ONE reviewer.
 *
 * `isolation` is the SAFETY-CRITICAL argument. A reviewer that got its own
 * snapshot may edit and mutate freely; a reviewer running in the LIVE worktree
 * (isolation unavailable) must be told the opposite, because the engine-level
 * denylist only removes the edit/write TOOLS — `bash` stays, and a reviewer
 * that had been promised "you are in a disposable copy" would happily rewrite
 * the user's files through it. Omitting the argument therefore means "no
 * snapshot": the read-only contract is the DEFAULT, and the permissive one has
 * to be granted explicitly.
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
): string {
  const streamPath = isolation?.streamPath;
  const range = isolation?.commitRange ?? "baseline..HEAD";
  const lines = [
    scopeKind === "incremental"
      ? "You are the reviewer of this round. Audit the INCREMENT listed below — the files that changed since the last READY review — and re-check every finding the scope block lists. Deep-audit the increment and those findings; material already settled and unchanged gets a consistency scan, not a re-derivation. You keep FULL-diff visibility and authority: reopen any settled conclusion you can contradict with evidence. Verify from the code (never guess), and report findings with file paths and line numbers."
      : `You are the reviewer of this round. Audit the COMMIT RANGE ${range} below — immutable git history, and the ONLY thing this round judges. Read it with \`git show\` / \`git diff ${range}\`, verify from the code (never guess), and report findings with file paths and line numbers.`,
    "",
    `Changed files (${files.length}) in ${range}:`,
    files.map((f) => `- ${f}`).join("\n"),
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
  // per-reviewer diff any more, and nothing should: the reviewer holds a snapshot
  // of the change, so it runs `git diff HEAD` against the real thing instead of
  // reading a copy that may have drifted. Keeping a dead field invites someone
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
    "OUTPUT: fenced JSON verdict FIRST (the gate parses it; docSync is REQUIRED on the single-review path), then a prose review below the fence.",
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
        ? " The gate matches it against the pane it spawned you in (the shared repo root)."
        : " This only records where you read; the gate does not match it against one."),
    // eslint-disable-next-line max-len
    'Verdict shape: {"gate": "READY"|"BLOCKED"|"NEEDS_HUMAN", "cwd": "<your real pwd>", "docSync": "UPDATED"|"NOT_NEEDED", "findings": [{"file": "...", "line": 1, "severity": "P0|P1|P2|Nit", "issue": "..."}], "notes": "<prose review>"}',
    "Severity: P0 = must fix now, P1 = must fix before ship, P2 = should fix, Nit = optional. Any open P0/P1 ⇒ BLOCKED.",
  );
  return lines.join("\n");
}
