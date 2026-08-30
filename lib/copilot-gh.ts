/**
 * The gh ACCESS layer of the L7 Copilot review loop.
 *
 * Everything the gate BELIEVES about a Copilot review is gathered here, by the
 * extension itself: `gh` runs as an argv (never through a shell), in the
 * target repo, with a timeout, and the JSON is interpreted by the pure
 * lib/copilot-review.ts rules. The agent drives the loop but can never report
 * its own review outcome — the same trust split as run_precommit.
 *
 * It lives here rather than in `extensions/review-gate.ts` for the reason this
 * repository now has a rule about (AGENTS.md §"架构规范"): that file is ~8900
 * lines, and it got there one "just add the helper here" at a time. The
 * orchestration tools moved out first (lib/orchestrator-*-tools.ts), then the
 * judge tools (lib/judge-session-tools.ts, lib/judge-relay-tools.ts), then the
 * prepare family (lib/review-prepare-tools.ts, lib/advisory-prepare-tools.ts).
 * This is the same move for the Copilot family.
 *
 * THE BOUNDARY: this module TALKS to GitHub — it spawns `gh`, retries the
 * version-dependent `--json` whitelist, and hands raw stdout to the pure
 * parsers. It knows nothing about gate state, tool replies or the review
 * cycle's state machine: the two tools that drive that live in
 * lib/copilot-review-tools.ts and reach this module through their injected
 * `gh` seam, so every one of their branches can be exercised with a fake
 * instead of a real PR. That split is also what keeps both files clear of the
 * 600-line hard block on new source files.
 *
 * BEHAVIOR IS FROZEN: this module was moved verbatim out of the extension.
 * The argv spellings, the spawn options, the timeout and the abort handling
 * are the ones that were measured against real repositories; changing any of
 * them is a separate, deliberate change.
 */

import { spawn, type ChildProcess } from "node:child_process";

import {
  COPILOT_HISTORY_PR_COUNT,
  COPILOT_HISTORY_QUERY,
  COPILOT_REVIEWER_LOGIN,
  COPILOT_THREADS_QUERY,
  decideCopilotSupport,
  decidePrView,
  isUnknownJsonFieldError,
  PR_VIEW_JSON_FIELDS,
  parseCopilotHistoryProbe,
  parseCopilotPayload,
  parseNameWithOwner,
  slugFromPrUrl,
  type CopilotPayload,
  type CopilotSupport,
  type PrSummary,
} from "./copilot-review.ts";

/** One `gh` invocation's outcome — never an exception. */
export interface GhResult { ok: boolean; stdout: string; stderr: string }

/**
 * Run one `gh` invocation. Never throws; a missing or failing gh is an
 * ordinary result.
 *
 * ASYNC on purpose, and for the same reason run_precommit is: a synchronous
 * spawn blocks the extension host's event loop, so a slow API call would
 * freeze the session and swallow the user's ESC. The child is killed on
 * timeout and on abort.
 */
export async function runGh(
  argv: string[],
  dir: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<GhResult> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  // Already aborted: an AbortSignal never fires for a listener registered
  // after the fact, so spawning here would run the whole command past the
  // user's ESC. `ok: false` is also the answer every caller must draw from
  // an abort — "could not tell", never a negative finding.
  if (opts.signal?.aborted) {
    return { ok: false, stdout: "", stderr: "aborted before gh started" };
  }
  return await new Promise<GhResult>((resolveResult) => {
    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: dir,
        // GH_PAGER="" keeps gh from piping JSON into a pager; NO_COLOR keeps
        // ANSI escapes out of the payloads we parse.
        env: { ...process.env, GH_PAGER: "", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolveResult({ ok: false, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    const finish = (r: GhResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolveResult(r);
    };
    const kill = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => {
      kill();
      finish({ ok: false, stdout: out, stderr: `gh timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    const onAbort = () => { kill(); finish({ ok: false, stdout: out, stderr: "aborted" }); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", (e: Error) => finish({ ok: false, stdout: out, stderr: e.message }));
    child.on("close", (code: number | null) => finish({ ok: code === 0, stdout: out, stderr: err }));
  });
}

/** First meaningful line of gh's stderr, for the tool's explanation text. */
export function ghError(res: GhResult, fallback: string): string {
  const line = res.stderr.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, 200) : fallback;
}

/** The PR for the repo's current branch, or the reason there is none. */
export async function resolveOpenPr(dir: string, signal?: AbortSignal): Promise<{ pr?: PrSummary; error?: string }> {
  // gh's --json field whitelist is version-dependent: `headRefOid` exists
  // only in newer gh builds. Legacy gh (measured: 2.4.0) rejects the modern
  // list with `Unknown JSON field: "headRefOid"` BEFORE even looking up
  // the PR — so only retry with the legacy list when that whitelist error
  // is actually what failed (the decision logic lives in the pure
  // lib/copilot-review.ts decidePrView; it also makes sure THE RETRY's
  // error is reported when it fails — the whitelist error would mask the
  // real cause, e.g. "no pull requests found"). `analyzeCopilot` anchors
  // proof on timestamps when head is absent (documented fallback).
  const modern = await runGh(["gh", "pr", "view", "--json", PR_VIEW_JSON_FIELDS.modern], dir, { signal });
  const decision = decidePrView(
    modern,
    isUnknownJsonFieldError(modern.stderr)
      ? await runGh(["gh", "pr", "view", "--json", PR_VIEW_JSON_FIELDS.legacy], dir, { signal })
      : undefined,
  );
  if (decision.ok) return { pr: decision.pr };
  return { error: decision.error };
}

/** owner/name for the repo, preferring gh's own answer over URL parsing. */
export async function resolveRepoSlug(dir: string, pr: PrSummary | undefined, signal?: AbortSignal): Promise<string | null> {
  const res = await runGh(["gh", "repo", "view", "--json", "nameWithOwner"], dir, { signal });
  return (res.ok ? parseNameWithOwner(res.stdout) : null) ?? slugFromPrUrl(pr?.url ?? null);
}

/**
 * Ask GitHub for Copilot's review of one PR (reviews + review threads).
 * Variables travel as separate argv values — nothing is interpolated into
 * the query text.
 */
export async function fetchCopilotPayload(
  dir: string,
  slug: string,
  prNumber: number,
  signal?: AbortSignal,
): Promise<CopilotPayload | undefined> {
  const [owner, name] = slug.split("/");
  if (!owner || !name) return undefined;
  const res = await runGh([
    "gh", "api", "graphql",
    "-F", `owner=${owner}`,
    "-F", `name=${name}`,
    "-F", `number=${prNumber}`,
    "-f", `query=${COPILOT_THREADS_QUERY}`,
  ], dir, { signal });
  if (!res.ok) return undefined;
  return parseCopilotPayload(res.stdout);
}

/**
 * Request the Copilot reviewer.
 *
 * The argv is FIXED — the only variable is a PR number that came out of
 * `gh pr view` as an integer. No agent-authored text can reach this command,
 * which is what makes running a `gh pr edit` (a command the ship gate
 * blocks) sound here: the gate blocks that command because it can carry PR
 * title and body text, and this spelling cannot.
 *
 * Older `gh` builds have no `@copilot` shorthand, so a failure falls back to
 * the documented REST review-request endpoint before giving up.
 */
export async function requestCopilotReviewer(
  dir: string,
  pr: PrSummary,
  slug: string | null,
  signal?: AbortSignal,
): Promise<GhResult> {
  const viaCli = await runGh(["gh", "pr", "edit", String(pr.number), "--add-reviewer", "@copilot"], dir, { signal });
  if (viaCli.ok || !slug) return viaCli;
  return await runGh([
    "gh", "api", "--method", "POST",
    `repos/${slug}/pulls/${pr.number}/requested_reviewers`,
    "-f", `reviewers[]=${COPILOT_REVIEWER_LOGIN}`,
  ], dir, { signal });
}

/**
 * Availability probe: has Copilot reviewed ANY recent PR in this repo?
 *
 * `undefined` when the answer could not be read (gh missing, API refusal,
 * unparseable payload) — the caller must then assume nothing.
 *
 * Replaces a `suggestedActors` capability probe and a pair of
 * "did the review request land?" read-backs. All three were measured and
 * found unusable: the capability filter answers a different question
 * (assignee, not reviewer) and returned no Copilot on a repo Copilot
 * demonstrably reviews, and a request that GitHub silently drops still
 * leaves `reviewRequests` empty on every surface — gh JSON, GraphQL and
 * REST alike — while both request calls report success. Together they made
 * "unsupported" the near-certain verdict for any PR that had not already
 * been reviewed by Copilot once.
 */
export async function probeCopilotHistory(
  dir: string,
  slug: string | null,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const [owner, name] = (slug ?? "").split("/");
  if (!owner || !name) return undefined;
  const res = await runGh([
    "gh", "api", "graphql",
    "-F", `owner=${owner}`,
    "-F", `name=${name}`,
    "-F", `count=${COPILOT_HISTORY_PR_COUNT}`,
    "-f", `query=${COPILOT_HISTORY_QUERY}`,
  ], dir, { signal });
  if (!res.ok) return undefined;
  return parseCopilotHistoryProbe(res.stdout);
}

/**
 * Decide availability for one repo, cheapest evidence first.
 *
 * Remembered evidence short-circuits the query entirely; the history probe
 * only runs when nothing is known yet. `confirmed` tells the caller whether
 * the answer is worth remembering in the sidecar (policy is not evidence).
 *
 * The allow-list `owners` arrives from the caller (the extension's project
 * config) rather than being read here: this module has no configuration of
 * its own, and the tools must be able to fake this whole surface.
 */
export async function resolveCopilotSupport(
  dir: string,
  slug: string | null,
  supportConfirmed: boolean,
  owners: string[],
  opts: { onPr?: boolean; signal?: AbortSignal } = {},
): Promise<{ support: CopilotSupport; confirmed: boolean }> {
  const remembered = supportConfirmed === true;
  if (remembered || opts.onPr === true) {
    return { support: "CONFIRMED", confirmed: true };
  }
  const history = await probeCopilotHistory(dir, slug, opts.signal);
  const support = decideCopilotSupport({
    history,
    slug,
    owners,
  });
  return { support, confirmed: support === "CONFIRMED" };
}
