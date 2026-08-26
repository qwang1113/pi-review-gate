/**
 * Reviewer spawn guard — make "every reviewer runs in its OWN snapshot" a
 * MECHANICAL fact instead of a sentence in a prompt.
 *
 * THE BUG THIS EXISTS FOR (measured, in this repo, over several rounds).
 * `prepare_review` materializes one disposable worktree for the reviewer and prints
 * each one's `cwd`. Whether a reviewer actually RUNS there was, until now,
 * entirely up to the spawning agent remembering to pass `cwd`. It did not — for
 * an entire session — and the failure was SILENT in the worst possible
 * direction: a reviewer left in the live worktree never touches its snapshot,
 * so `verifySnapshot` finds the tree unchanged and reports "clean". The gate
 * was verifying an untouched copy while the review happened somewhere else.
 *
 * WHY IT IS NOT SIMPLY "THE AGENT FORGOT". pi-subagents offers two dispatch
 * shapes and only ONE of them can carry a per-child cwd:
 *
 *   - a top-level single-child call — `subagent({ agent, task, cwd })` — where
 *     `cwd` is honored per call, and
 *   - `workflowScript` / `workflowScriptPath`, whose sandbox exposes
 *     `runs.run(key, { agent, task, worktree?, gate? })` — NO `cwd` field at
 *     all (verified in pi-subagents/src/workflows/scripted-workflow.ts: the
 *     word does not appear). The workflow's single top-level `cwd` applies to
 *     every child.
 *
 * Meanwhile the host prompt tells agents to prefer ONE workflowScript for
 * parallel work. Following that advice makes per-reviewer isolation
 * unreachable. So the guard has to block a whole dispatch SHAPE, not just a
 * missing argument.
 *
 * TWO LAYERS, BECAUSE THE FIRST ONE CAN BE BLIND. `decideReviewerSpawn` runs at
 * `tool_call` time and refuses a reviewer spawn that is not pointed at a
 * snapshot. But a reviewer started through a path this process never observes
 * (another session, a future tool name) would slip past it, so
 * `decideSnapshotUsage` re-checks at `record_review` time from the opposite
 * side: every snapshot handed out must show evidence it was actually used, or
 * the READY is withheld. The artifacts pi-subagents writes do NOT record a
 * child's cwd (checked: `*_meta.json` has runId/agent/task/model/…, no cwd), so
 * that evidence has to come from the two sources this module defines.
 *
 * TIGHTEN-ONLY. Nothing here can produce a READY, grant a snapshot, or relax a
 * verdict: `decideReviewerSpawn` either ignores a call or blocks it, and
 * `decideSnapshotUsage` either leaves a verdict alone or downgrades it to
 * BLOCKED. Every function is pure over strings, so the truth table is pinned by
 * tests rather than by the shape of the code.
 */

/**
 * Agents whose spawn MUST be pinned to a snapshot.
 *
 * The judge roles, and only them. An `adviser` or a `recon`
 * reads the live worktree by design — blocking those would
 * cost the parallel exploration the loop depends on and buy nothing, because
 * they never issue a verdict the gate records.
 */
export const REVIEWER_AGENT_NAMES: readonly string[] = Object.freeze([
  "reviewer",
  "reviewer-readonly",
]);

/** Tool name that dispatches subagents (pi-subagents registers exactly this). */
const SUBAGENT_TOOL = "subagent";

export interface PreparedSnapshotRef {
  /** Instance label, as reported by `prepare_review`. */
  label: string;
  /** Absolute path of the snapshot worktree. */
  dir: string;
}

export type ReviewerSpawnDecision =
  /** Not a reviewer dispatch (or nothing to protect) — the gate stays out of it. */
  | { kind: "ignore" }
  /** A reviewer correctly pinned to `snapshotDir`; the caller books it as used. */
  | { kind: "allow"; snapshotDir: string }
  /** Refuse the call; `reason` is shown to the agent verbatim. */
  | { kind: "block"; reason: string };

export interface ReviewerSpawnInput {
  /** `event.toolName` of the intercepted call. */
  toolName: string;
  /** Raw tool input. */
  params: Record<string, unknown>;
  /** Snapshots `prepare_review` handed out for this repo this round. */
  snapshots: readonly PreparedSnapshotRef[];
  /** Snapshot dirs already booked as spawned into (absolute). */
  consumed: readonly string[];
  /** Resolve a possibly-relative path to absolute (caller binds the session cwd). */
  resolve: (path: string) => string;
  /**
   * Read a `workflowScriptPath` so it can be judged by CONTENT.
   *
   * Optional because the decision stays pure: the caller does the I/O and may
   * refuse (unreadable, oversized, absent). Without it the guard falls back to
   * matching the file NAME, which catches `workflows/review.js` and misses a
   * neutrally-named file — the reason this hook exists at all.
   */
  readScript?: (path: string) => string | undefined;
}

/**
 * Normalize a tool name to its bare form.
 *
 * The same tool reaches this hook as `subagent` in-process and as
 * `mcp__pi__subagent` (or a `server/tool` form) when it is proxied. Comparing
 * the raw string would make the guard silently inert behind a proxy — the exact
 * class of silent failure this module exists to end.
 */
export function normalizeToolName(raw: string): string {
  const tail = raw.split(/__|\//).pop() ?? raw;
  return tail.trim().toLowerCase();
}

/**
 * Normalize an agent reference to its bare name: `agents/reviewer.md`,
 * `./reviewer`, `Reviewer` all mean the same agent to pi-subagents, which
 * resolves by name.
 */
export function normalizeAgentName(raw: string): string {
  const tail = raw.trim().split(/[\\/]/).pop() ?? raw;
  return tail.replace(/\.md$/i, "").trim().toLowerCase();
}

/** Is this agent reference one of the judge roles? */
export function isReviewerAgentName(raw: string): boolean {
  return REVIEWER_AGENT_NAMES.includes(normalizeAgentName(raw));
}

/**
 * Which reviewer role a workflow script dispatches, if any.
 *
 * TWO-STEP ON PURPOSE. A workflow that spawns children always names them in an
 * `agent:` field (`runs.run("a", { agent: "reviewer", … })`), so reading those
 * VALUES is both precise and immune to prose: a task string that merely says
 * "hand this to the reviewer" is not a dispatch and must not be blocked.
 *
 * Only when a script carries no `agent:` field at all do we fall back to a
 * word-boundary scan of the whole text. `\breviewer\b` does not match
 * "reviewers" (a plural in prose) but does match inside "reviewer-readonly"
 * (`-` is a word boundary) — which is another judge role, so that direction of
 * over-matching costs nothing.
 */
export function reviewerAgentInScript(script: string): string | undefined {
  // Quoted OR bare values: `agent: "reviewer"` and `agent: reviewer` (a bare
  // identifier — common in generated/short scripts) must both be caught, or a
  // workflow could dispatch a judge role without the gate ever seeing it.
  const fieldRe = /\bagent\s*:\s*["'`]?([A-Za-z0-9_.\-/]+)["'`]?/g;
  let m: RegExpExecArray | null;
  let sawField = false;
  while ((m = fieldRe.exec(script)) !== null) {
    sawField = true;
    if (isReviewerAgentName(m[1])) return normalizeAgentName(m[1]);
  }
  if (sawField) return undefined;
  for (const name of REVIEWER_AGENT_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(script)) return name;
  }
  return undefined;
}

/**
 * Render the snapshot list as copyable spawn calls for a block reason.
 *
 * `agent` is a PARAMETER, not a constant: a block that names `reviewer-readonly`
 * and then hands back a call spawning `reviewer` would be copied verbatim (that
 * is the point of a copyable shape) and silently dispatch the wrong role — in
 * the single-review protocol, the wrong judge entirely.
 */
function spawnShapes(snapshots: readonly PreparedSnapshotRef[], agent: string): string {
  return snapshots
    .map(
      (s) =>
        `  subagent({ agent: "${agent}", async: true, cwd: "${s.dir}", ` +
        `task: "<the ${s.label} task text from prepare_review>", outputSchema: <REVIEW_VERDICT_SCHEMA> })`,
    )
    .join("\n");
}

const WORKFLOW_EXPLANATION =
  "pi-subagents' workflow sandbox has NO per-child `cwd` (runs.run takes agent/task/worktree/gate " +
  "only), so every reviewer in a workflowScript would run in ONE shared cwd — in practice your live " +
  "worktree, which is exactly the failure this guard ends: the snapshots stay untouched, verify as " +
  "\"clean\", and the review never happened where the gate looked.";

/**
 * Decide what to do with an intercepted subagent call while snapshots are open.
 *
 * Order matters and each step is a deliberate non-block: management actions,
 * non-reviewer agents and scripts that dispatch no reviewer all pass straight
 * through, because the loop's parallel read-only work must keep running while a
 * review is in flight.
 */
export function decideReviewerSpawn(input: ReviewerSpawnInput): ReviewerSpawnDecision {
  const { params, snapshots } = input;
  if (snapshots.length === 0) return { kind: "ignore" };
  if (normalizeToolName(input.toolName) !== SUBAGENT_TOOL) return { kind: "ignore" };
  // NOTE what is deliberately NOT here: an "every snapshot is already booked ⇒
  // let anything through" shortcut. It looked like a kindness (do not strand a
  // retry) and was a hole big enough to drive the original bug back through:
  // after a round every snapshot is booked, and nothing would stop a
  // later-scheduled judge from running in the live worktree with
  // snapshots, so nothing complains. A retry does not need the shortcut: a
  // spawn that carries a snapshot cwd is allowed below whether that snapshot
  // was booked before or not.
  const consumed = new Set(input.consumed);

  // Management/control calls (list, status, steer, …) dispatch nothing — with
  // ONE exception a reviewer found: `action: "schedule.create"` carries a
  // workflowScript and does eventually run it, so an early return here let
  // `{action:"schedule.create", workflowScript: "…agent:'reviewer'…"}` through.
  // A management call that carries NO script is still waved past, and
  // `action: "validate"` is waved past even with one: it only type-checks the
  // script offline, launching nothing, and blocking it would forbid validating
  // a workflow while any review is open.
  const action = typeof params.action === "string" ? params.action.trim() : "";
  const carriesScript = typeof params.workflowScript === "string" || typeof params.workflowScriptPath === "string";
  if (action !== "" && (!carriesScript || action === "validate")) return { kind: "ignore" };

  const script = typeof params.workflowScript === "string" ? params.workflowScript : undefined;
  const scriptPath = typeof params.workflowScriptPath === "string" ? params.workflowScriptPath : undefined;
  if (script !== undefined || scriptPath !== undefined) {
    // A workflow FILE is judged by its CONTENTS, not by its name. An earlier
    // version scanned only the path string, on the theory that a pure function
    // cannot read files — but the caller can, and a reviewer pointed out the
    // obvious consequence: `workflows/wave.js` dispatching `reviewer` sailed
    // straight through. The caller injects the text via `readScript`; when it
    // cannot (unreadable file), the name is the last signal left.
    const body = script !== undefined
      ? script
      : (input.readScript?.(scriptPath!) ?? undefined);
    const hit = body !== undefined
      ? reviewerAgentInScript(body)
      : reviewerAgentInScript(scriptPath ?? "");
    if (!hit) return { kind: "ignore" };
    return {
      kind: "block",
      reason:
        `review-gate: this workflow dispatches \`${hit}\` while ${snapshots.length} review snapshot(s) ` +
        `are open, and a workflow cannot put each reviewer in its own snapshot. ${WORKFLOW_EXPLANATION}\n` +
        "Spawn the reviewers as SEPARATE top-level calls in the same turn instead — one per snapshot, " +
        "each with its own cwd:\n" + spawnShapes(snapshots, hit),
    };
  }

  const agent = typeof params.agent === "string" ? params.agent : undefined;
  if (!agent || !isReviewerAgentName(agent)) return { kind: "ignore" };

  const rawCwd = typeof params.cwd === "string" && params.cwd.trim() !== "" ? params.cwd : undefined;
  const cwd = rawCwd ? input.resolve(rawCwd) : undefined;
  const target = cwd ? snapshots.find((s) => s.dir === cwd) : undefined;
  if (target) return { kind: "allow", snapshotDir: target.dir };

  const open = snapshots.filter((s) => !consumed.has(s.dir));
  return {
    kind: "block",
    reason:
      `review-gate: \`${normalizeAgentName(agent)}\` must run INSIDE the snapshot prepared for it, ` +
      (cwd
        ? `but cwd=${cwd} is not one of this round's snapshots. `
        : "but this call passes no `cwd`, so the reviewer would read your LIVE worktree. ") +
      "A reviewer outside its snapshot judges a tree the gate never fingerprinted, collides with your " +
      "own fixes, and leaves its snapshot untouched — which then verifies as \"clean\" and hides the " +
      "whole problem.\n" +
      (open.length > 0
        ? "Re-issue this call with one of the open snapshots:\n" +
          spawnShapes(open, normalizeAgentName(agent))
        : // Every snapshot of this round already has a reviewer. Re-using one
          // is allowed (same tree) but a fresh prepare_review is the honest call.
          "Every snapshot of this round already has a reviewer. Call prepare_review again for" +
          " a fresh one, or re-use one of this round's snapshots (same tree):\n" +
          spawnShapes(snapshots, normalizeAgentName(agent))),
  };
}

/**
 * Every `cwd` a reviewer self-reported in its fenced JSON verdict.
 *
 * Parsed leniently and independently of `parseReviewOutput`: a verdict whose
 * JSON is malformed still fails closed there, and this side must not be the
 * reason a good verdict is rejected. The regex fallback exists because reviewer
 * output regularly carries unescaped quotes inside `issue` strings (the same
 * reason verdict-parse has a salvage path).
 */
export function extractVerdictCwds(text: string): string[] {
  const found: string[] = [];
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const body = m[1];
    let taken = false;
    try {
      const data = JSON.parse(body) as unknown;
      if (typeof data === "object" && data !== null) {
        const value = (data as Record<string, unknown>).cwd;
        if (typeof value === "string" && value.trim() !== "") {
          found.push(value.trim());
          taken = true;
        }
      }
    } catch { /* fall through to the regex salvage */ }
    if (taken) continue;
    const raw = /["']cwd["']\s*:\s*["']([^"']+)["']/.exec(body);
    if (raw) found.push(raw[1].trim());
  }
  return found;
}

export interface SnapshotUsageInput {
  /** Verdict after the existing guards (drift / stale tree). */
  verdict: string;
  /** Snapshots handed out for this round (empty ⇒ isolation was unavailable). */
  snapshots: readonly PreparedSnapshotRef[];
  /** Snapshot dirs booked at spawn time by `decideReviewerSpawn`. */
  consumed: readonly string[];
  /** Cwds the reviewers reported in their verdicts. */
  verdictCwds: readonly string[];
}

export interface SnapshotUsageResult {
  /** Verdict after this guard. Downgraded at most; never upgraded. */
  verdict: string;
  /** Labels of snapshots with NO evidence of use (empty ⇒ guard was satisfied). */
  unusedLabels: string[];
}

/**
 * Did every snapshot this round actually get a reviewer?
 *
 * PER SNAPSHOT, not per round: the one reviewer of a round must never vouch
 * for a snapshot that was never entered — the change would be unreviewed
 * while the round reported full coverage.
 *
 * Two independent kinds of evidence, either of which suffices:
 *   - the spawn was observed and booked (`consumed`), or
 *   - a verdict named that snapshot as its cwd (`verdictCwds`), which also
 *     catches a reviewer that was pointed correctly and then `cd`-ed away.
 *
 * No snapshots at all means isolation was unavailable (`prepare_review` says so
 * and tells the agent to use `reviewer-readonly`); there is nothing to prove,
 * so the guard stays silent rather than deadlocking that path.
 */
export function decideSnapshotUsage(input: SnapshotUsageInput): SnapshotUsageResult {
  if (input.snapshots.length === 0) return { verdict: input.verdict, unusedLabels: [] };
  const consumed = new Set(input.consumed);
  const unusedLabels = input.snapshots
    .filter((s) => {
      if (consumed.has(s.dir)) return false;
      // A cwd INSIDE the snapshot still means the reviewer was in its copy.
      return !input.verdictCwds.some((c) => c === s.dir || c.startsWith(s.dir + "/"));
    })
    .map((s) => s.label);
  if (unusedLabels.length === 0) return { verdict: input.verdict, unusedLabels };
  // Same asymmetry as the drift guard: only a READY is withheld. Findings from
  // a reviewer that ran in the wrong place are still worth fixing, and BLOCKED
  // ships nothing anyway.
  return {
    verdict: input.verdict === "READY" ? "BLOCKED" : input.verdict,
    unusedLabels,
  };
}
