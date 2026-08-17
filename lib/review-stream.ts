/**
 * Streaming findings — the reviewer publishes as it goes, instead of only at
 * the end.
 *
 * PROBLEM. A review round is a hard barrier: the reviewer often knows its
 * first real finding within the first minute, but the main agent learns
 * nothing until the whole verdict lands minutes later, and only then starts
 * fixing. The fix work is serialized behind reading work that is already done.
 *
 * WHAT THIS DOES. Every reviewer instance appends one JSON line per CONFIRMED
 * finding to its own stream file, and the main agent reads that file while it
 * waits. Snapshot isolation (lib/review-snapshot.ts) is what makes acting on
 * them safe: the reviewer is reading a frozen copy, so the main agent may fix
 * the live worktree immediately.
 *
 * WHY A PLAIN APPEND-ONLY FILE. It is the lowest common denominator every
 * model gets right with one `>>` redirection, it survives a crashed reviewer
 * (whatever it found is already on disk), it is trivially auditable, and it
 * needs nothing from the subagent framework — this repo has already been
 * burned by depending on a framework capability that silently did not exist
 * (the `intercom` tool contract).
 *
 * THE ONE HARD RULE. A stream line is EVIDENCE, never a verdict. `parseStreamLine`
 * refuses any line carrying a verdict-shaped field, so a partial stream can
 * never be laundered into a recorded gate decision: the verdict comes only
 * from the reviewer's final output, through `record_review`, as before.
 */

/** Severities the main agent may act on before the verdict lands. */
export const ACTIONABLE_SEVERITIES: readonly string[] = Object.freeze(["P0", "P1", "P2"]);

/**
 * Keys that make a line look like a verdict. Any of them ⇒ the line is
 * rejected outright rather than sanitized: a reviewer emitting a verdict into
 * the stream has misunderstood the protocol, and silently accepting a cleaned
 * copy would hide that.
 */
export const VERDICT_KEYS: readonly string[] = Object.freeze(["gate", "verdict", "docSync"]);

export interface StreamFinding {
  /** Stable id, so a re-emitted finding is recognizable. */
  id: string;
  severity: string;
  /** `path/to/file.ts:123` — where the finding lives. */
  location: string;
  issue: string;
  /** One concrete observation backing the claim (empty when absent). */
  evidence: string;
}

export interface StreamParseResult {
  findings: StreamFinding[];
  /** Lines that were rejected, with the reason — surfaced, never swallowed. */
  rejected: Array<{ line: string; reason: string }>;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Line numbers arrive as a NUMBER in the documented shape (`"line": 12`) and
 * as a string from models that quote everything. Accepting only strings threw
 * the line number away and produced a location of `lib/a.ts` — a finding the
 * agent then has to hunt for.
 */
function numOrStr(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return str(value);
}

/**
 * Parse one stream line. Returns the finding, or the reason it was rejected.
 *
 * Tolerant about SHAPE (any missing optional field degrades to "") and strict
 * about AUTHORITY (anything verdict-shaped is refused).
 */
export function parseStreamLine(line: string): { finding?: StreamFinding; reason?: string } {
  const trimmed = line.trim();
  if (trimmed === "") return {};
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { reason: "not JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { reason: "not a JSON object" };
  const obj = raw as Record<string, unknown>;
  for (const key of VERDICT_KEYS) {
    if (key in obj) {
      return {
        reason:
          `carries the verdict-shaped key "${key}" — a stream line is evidence, never a decision; ` +
          `the verdict belongs in the reviewer's final output`,
      };
    }
  }
  const issue = str(obj.issue) || str(obj.finding) || str(obj.message);
  if (issue === "") return { reason: "no issue text" };
  const location = str(obj.location) || [str(obj.file), numOrStr(obj.line)].filter(Boolean).join(":");
  return {
    finding: {
      id: str(obj.id) || `${location}#${issue.slice(0, 40)}`,
      severity: str(obj.severity) || "Note",
      location,
      issue,
      evidence: str(obj.evidence),
    },
  };
}

/** Parse a whole stream file's text. Order is preserved (append-only). */
export function parseStream(text: string): StreamParseResult {
  const findings: StreamFinding[] = [];
  const rejected: Array<{ line: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const { finding, reason } = parseStreamLine(line);
    if (reason) {
      rejected.push({ line: line.trim().slice(0, 200), reason });
      continue;
    }
    if (!finding) continue;
    // A reviewer that re-emits a finding (e.g. after refining its evidence)
    // must not make the agent fix it twice.
    if (seen.has(finding.id)) continue;
    seen.add(finding.id);
    findings.push(finding);
  }
  return { findings, rejected };
}

/**
 * Findings the main agent may start fixing before the verdict arrives.
 *
 * Two filters, both learned from how reviewers actually behave:
 *  - severity: Nits are frequently withdrawn or restated in the final output,
 *    and fixing one early buys nothing; P0-P2 have to be fixed either way.
 *  - evidence: a finding with a concrete observation attached is one the
 *    reviewer has already checked. Speculative items ("this might race") are
 *    exactly the ones that disappear from the final verdict, so acting on
 *    them is where wasted work comes from.
 */
export function actionableFindings(findings: readonly StreamFinding[]): StreamFinding[] {
  return findings.filter(
    (f) => ACTIONABLE_SEVERITIES.includes(f.severity.toUpperCase()) && f.evidence !== "",
  );
}

/**
 * The instruction handed to a reviewer. Absolute path on purpose: the
 * reviewer's cwd is its snapshot, so a relative path would write into the
 * snapshot's own `.pi/` — a stream that looks alive and delivers nothing.
 */
export function buildStreamDirective(streamPath: string): string {
  return [
    "STREAM YOUR FINDINGS AS YOU CONFIRM THEM (do not wait for the end):",
    `- Append ONE JSON line per confirmed finding to: ${streamPath}`,
    '  Shape: {"id":"stable-id","severity":"P0|P1|P2|Nit","file":"path.ts","line":12,' +
      '"issue":"what is wrong","evidence":"what you actually observed"}',
    "- Append with a shell redirect (>>) the moment a finding is CONFIRMED, not when you are done.",
    "- `evidence` is what makes a finding actionable: the main agent fixes streamed P0/P1/P2 that " +
      "carry evidence WHILE you are still working, so a speculative line costs it real work. " +
      "Stream what you have verified; keep hunches for the final output.",
    "- NEVER put a verdict in the stream (no `gate`, `verdict` or `docSync` key): the stream is " +
      "evidence, the verdict belongs in your final output. Verdict-shaped lines are rejected.",
    "- The final output must still contain EVERY finding, streamed or not — it is the record.",
  ].join("\n");
}

/**
 * The main agent's side of the protocol: how to consume the stream without
 * burning turns on a busy loop.
 */
export function buildStreamConsumerDirective(streamPaths: readonly string[]): string {
  const list = streamPaths.map((p) => `  - ${p}`).join("\n");
  return [
    "WHILE THE REVIEWER RUNS, work its stream instead of idling:",
    list,
    "- Cadence: subagent_wait with a timeout (~60s) → read the stream file(s) → fix what is " +
      "actionable → wait again. Never poll in a tight loop; never sleep to pass time.",
    "- Fix streamed P0/P1/P2 that carry evidence, and open the file to confirm the finding " +
      "yourself first — a reviewer occasionally withdraws an item in its final output.",
    "- Leave Nits until the verdict lands.",
    "- Your fixes change the worktree while the reviewer reads a frozen snapshot: that is " +
      "intended and safe. The gate ENFORCES the consequence mechanically — it compares the tree the " +
      "reviewer actually read with the tree at record time, and a READY that no longer covers your " +
      "worktree is recorded as BLOCKED (\"STALE TREE\"). That is the normal, fail-closed outcome: the " +
      "next round is short because its fixes are already in.",
    "- Record the verdict from the reviewer's FINAL output only. Stream lines are never a verdict.",
  ].join("\n");
}
