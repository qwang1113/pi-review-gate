/**
 * Adviser brief — the gate-side template for an `adviser` consultation.
 *
 * Goal criterion 3 (adviser conclusion storage + injection): the gate hands
 * the main agent a ready-made adviser task template carrying (a) the main
 * session's transcript path — the adviser runs `context:"fresh"` and reads it
 * ON DEMAND instead of inheriting a fork of the whole conversation — and
 * (b) the artifact path where the adviser appends its own conclusion. The
 * NEXT consultation of the same goal reads that file back and injects the
 * previous conclusion plus this round's changed files, so a goal that was
 * already argued settles once instead of being re-argued from zero.
 *
 * Pure over strings: the gate collects the facts (goal, transcript path,
 * previous conclusion, changed files), this file decides what to SAY.
 */

export type AdviserVerdict = "SUPPORTS" | "OBJECTS" | "NEUTRAL";

/**
 * Single-quote a shell argument (same shape as the runner's shellQuote):
 * a path or JSON line containing a single quote must still be ONE argument.
 * The brief pastes this into the adviser's bash instruction verbatim.
 */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}


/**
 * Shape predicate for one adviser conclusion line: the goal hash matches,
 * the verdict is whitelisted and points are well-formed. Shared by the
 * parser (last valid line wins) and the baseline-advance counter so the
 * two never drift.
 */
function isValidAdviserConclusion(o: unknown, goalHash: string): boolean {
  return !!o && (o as { goalHash?: string }).goalHash === goalHash &&
    typeof (o as { at?: unknown }).at === "string" &&
    ((o as { verdict?: string }).verdict === "SUPPORTS" ||
      (o as { verdict?: string }).verdict === "OBJECTS" ||
      (o as { verdict?: string }).verdict === "NEUTRAL") &&
    Array.isArray((o as { points?: unknown }).points) &&
    (o as { points: unknown[] }).points.every((p: unknown) =>
      typeof p === "object" && p !== null &&
      typeof (p as { severity?: unknown }).severity === "string" &&
      typeof (p as { issue?: unknown }).issue === "string");
}

/**
 * Parse the conclusion lines an adviser appended to its artifact file.
 *
 * Pure over a raw file body so the shape (skip malformed lines, only count
 * conclusions for the goal in question, last valid line wins) is testable
 * without a filesystem. Returns undefined when no valid conclusion for this
 * goal exists yet.
 */
export function parseAdviserConclusions(raw: string, goalHash: string): AdviserConclusion | undefined {
  let last: AdviserConclusion | undefined;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const o = JSON.parse(trimmed);
      if (isValidAdviserConclusion(o, goalHash)) {
        last = o as AdviserConclusion;
      }
    } catch { /* malformed line: skip */ }
  }
  return last;
}

/**
 * How many VALID conclusions this goal has accumulated in the artifact. The
 * gate uses it to confirm a consultation actually appended before advancing
 * the changed-files baseline (round-3 P1): an aborted consultation must not
 * advance the baseline past changes nobody confirmed.
 */
export function countAdviserConclusions(raw: string, goalHash: string): number {
  let count = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      if (isValidAdviserConclusion(JSON.parse(trimmed), goalHash)) count++;
    } catch { /* malformed line: skip */ }
  }
  return count;
}
/** One conclusion line the adviser appends to its artifact file. */
export interface AdviserConclusion {
  /** ISO time the adviser finished. */
  at: string;
  /** Which goal this consultation judged (goalTextHash of the approved text). */
  goalHash: string;
  verdict: AdviserVerdict;
  /** The points the adviser made, with severities, for the next consult. */
  points: Array<{ severity: string; issue: string }>;
  notes?: string;
}

export interface AdviserBriefInput {
  /** goalTextHash of the approved goal this consultation judges. */
  goalHash: string;
  /**
   * Directory holding this session's transcripts, e.g.
   * `~/.pi/agent/sessions/<encoded-cwd>/`. The adviser lists it and reads the
   * file named after `sessionId` — on demand, never inherited wholesale.
   */
  sessionDir: string;
  /** The main session's id (part of the transcript filename). */
  sessionId: string;
  /** Absolute path of the conclusion artifact the adviser must append to. */
  artifactPath: string;
  /** The previous consultation's conclusion, when one exists. */
  previous?: AdviserConclusion;
  /**
   * Files changed since the previous consultation. null = the increment could
   * NOT be computed (git unavailable) — the brief then demands a full
   * re-check instead of treating the settled points as confirmed.
   */
  changedFiles: string[] | null;
  /** The approved loop goal this consultation argues against, when approved. */
  goalText?: string;
}

/**
 * Build the task text the main agent pastes into its `adviser` subagent call.
 *
 * First consultation of a goal: full brief. Later ones: the previous verdict
 * and points ride along, changed files are called out, and the adviser is told
 * to settle what already stands rather than re-derive it — the same economy
 * the reviewer's incremental scope provides, for the advisory role.
 */
export function buildAdviserBrief(input: AdviserBriefInput): string {
  const lines = [
    "You are `adviser`, consulting on the CURRENT loop goal of the main session.",
    "",
    "Spawn this adviser with `context: \"fresh\"` explicitly (round-10 P1: a global",
    "defaultSubagentContext would override the agent's own defaultContext).",
    "",
    "CONTEXT MODEL (incremental, not fork): you run with `context:\"fresh\"` — the",
    "main session's conversation is NOT inherited. Read it on demand instead:",
    `- session dir: ${input.sessionDir}`,
    `- session id:  ${input.sessionId} (find the file named <timestamp>_${input.sessionId}.jsonl, grep/read the parts you need)`,
  ];
  if (input.goalText) {
    lines.push("", "The approved loop goal this consultation argues against:", "```", input.goalText, "```");
  }
  const prev = input.previous;
  if (prev) {
    lines.push(
      "",
      `A PREVIOUS consultation of this goal concluded ${prev.verdict} (${prev.at}) with ${prev.points.length} point(s):`,
      ...prev.points.map((p) => `- ${p.severity}: ${p.issue}`),
      "- Address each of those points directly. What it settled and has not changed stays settled —",
      "  do not re-argue it from zero; focus on what changed since.",
    );
    if (input.changedFiles === null) {
      // The increment could not be computed (git unreadable): the settled
      // points are NOT confirmed unchanged — demand a full re-check.
      lines.push(
        "",
        "The changed files since that consultation could NOT be computed (git unavailable) — do NOT treat",
        "the settled points as confirmed: re-check them against the current state, then conclude.",
      );
    } else if (input.changedFiles.length) {
      lines.push(
        "",
        `Changed since that consultation (${input.changedFiles.length} file(s)) — prioritize these:`,
        ...input.changedFiles.map((f) => `- ${f}`),
      );
    } else {
      lines.push("", "No changed files detected since that consultation — confirm the settled points still hold, then conclude.");
    }
  } else {
    lines.push("", "No previous consultation exists for this goal — full consultation.");
  }
  lines.push(
    "",
    "When you finish, append your conclusion as ONE JSON line to the artifact file below (this is how the",
    "next consultation of this goal will know what you settled — write it, do not just say it):",
    `- artifact: ${input.artifactPath}`,
    '  shape: {"at":"<ISO time>","goalHash":"' + input.goalHash + '","verdict":"SUPPORTS"|"OBJECTS"|"NEUTRAL","points":[{"severity":"P1","issue":"…"}],"notes":"…"}',
    "- Append with your `bash` tool (you have no write tool by design): e.g.",
    `  printf '%s\\n' ${shellSingleQuote("<your JSON line>")} >> ${shellSingleQuote(input.artifactPath)}`,
    "  (the quotes are shell-safe: a path containing a single quote is still one argument)",
    "- If you cannot write the artifact, say so in your output — the gate will record no conclusion for",
    "  the next consultation, which is fail-closed, not silent.",
    "",
    "OUTPUT: your recommendation in prose first, then the JSON line above (copy it into the artifact).",
  );
  return lines.join("\n");
}
