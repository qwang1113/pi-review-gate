/**
 * L7 — the Copilot code-review loop that runs AFTER a PR exists.
 *
 * WHY THIS EXISTS. Every other layer of this gate stops at the moment the PR
 * is opened: review READY + precommit PASS, and `gh pr create` is allowed
 * through. What GitHub Copilot then says about the PR was nobody's job. This
 * module models the missing tail of the workflow: once a PR is created or
 * updated, a Copilot review must be requested, waited for, and *worked off* —
 * every thread either fixed and resolved, or answered with the reason it is
 * not being fixed.
 *
 * WHERE IT IS ALLOWED TO BITE. Deliberately NOT in `unmetRequirements()`
 * (lib/gate-state.ts), the single ship authority read by both the tool_call
 * ship gate and the L3 git hooks. Fixing a Copilot finding requires a commit
 * and a push, so a Copilot requirement that blocked commits would block its
 * own remedy — a deadlock. It binds to "is the task finished?" instead:
 * `declare_done` and the L2 auto-continuation.
 *
 * WHAT IT CAN AND CANNOT PROVE. The extension gathers the facts itself (the
 * agent never reports its own review outcome), so "a Copilot review exists"
 * and "these threads are unresolved" are trustworthy. What it cannot judge is
 * the SUBSTANCE of a reply: a thread answered with "won't fix: out of scope"
 * and one answered with "ok" are structurally identical. That limit is
 * inherent to the user's own rule ("explain why, then move on") and is
 * documented rather than pretended away — same philosophy as the docSync
 * attestation, which trusts the reviewer's judgement instead of counting
 * touched files.
 *
 * HOW "IS COPILOT AVAILABLE HERE?" IS DECIDED. GitHub exposes NO capability
 * API for Copilot code review, and — measured, not assumed — every request
 * surface reports success even where the request is silently dropped:
 * `gh pr edit --add-reviewer @copilot` exits 0 and REST
 * `POST .../requested_reviewers` answers 200 on a repository that then shows
 * `reviewRequests.totalCount == 0`, no `ReviewRequestedEvent` in the timeline,
 * and no review at all. So neither the exit code nor a `reviewRequests`
 * read-back can decide this. Only POSITIVE evidence counts, in this order:
 *
 *   CONFIRMED  a Copilot review or Copilot thread exists on THIS PR, or the
 *              repository's recent PRs contain one (COPILOT_HISTORY_QUERY)
 *   ASSUMED    the repository owner is on the configured owner allow-list
 *   UNKNOWN    neither — treated as "not available", released without waiting
 *
 * UNKNOWN releases instead of waiting because the user's rule is explicit:
 * a repo that cannot do this must not cost the task 20 minutes of polling.
 * The cost of the heuristic is bounded and self-healing: one real Copilot
 * review anywhere in the repo's recent PRs flips it to CONFIRMED forever.
 *
 * PURITY. No IO, no clock, no throwing: payloads arrive as strings, `now` is
 * injected, and every function returns a new value. The extension owns `gh`,
 * the timers and the storage; this module owns the rules.
 */

/**
 * Lifecycle of one Copilot requirement.
 *
 *   ARMED       a PR-affecting ship was observed; no review requested yet
 *   AWAITING    a review was requested; Copilot has not answered yet
 *   OPEN        Copilot answered and left threads that still need work
 *   SATISFIED   every Copilot thread is resolved or answered
 *   UNSUPPORTED no PR / no gh / repo or account cannot do Copilot review
 *   EXHAUSTED   Copilot never answered within the wait budget — released,
 *               escalate to human (there is no round budget)
 *
 * The last three are terminal for the current cycle: they stop blocking
 * `declare_done`. A new PR-affecting ship re-arms from any of them (see
 * {@link armCopilotReview}) — that is what makes the loop a loop, and what
 * closes the "push first, open the PR afterwards" ordering hole.
 */
export type CopilotStatus =
  | "ARMED"
  | "AWAITING"
  | "OPEN"
  | "SATISFIED"
  | "UNSUPPORTED"
  | "EXHAUSTED";

const COPILOT_STATUSES: ReadonlySet<string> = new Set<CopilotStatus>([
  "ARMED", "AWAITING", "OPEN", "SATISFIED", "UNSUPPORTED", "EXHAUSTED",
]);

/** Statuses that no longer hold `declare_done` back. */
const RELEASED: ReadonlySet<CopilotStatus> = new Set<CopilotStatus>([
  "SATISFIED", "UNSUPPORTED", "EXHAUSTED",
]);

/**
 * There is NO cap on Copilot review cycles, on purpose.
 *
 * There used to be one (3 rounds, project-configurable). It was a third way to
 * finish a task with Copilot findings unhandled: on a PR where Copilot keeps
 * commenting, round 4 simply released the requirement. "Round 4 of a review
 * conversation" is not a reason to stop caring what the reviewer said, and
 * unlike a wait, another round costs nothing but the agent's own work — the
 * way out is always in the agent's hands (fix it, or reply why not).
 *
 * The loop still cannot run forever: it advances only when the agent pushes
 * new code, and every cycle that Copilot does not answer is bounded by
 * {@link COPILOT_AWAIT_TIMEOUT_MS}.
 */

/**
 * How long a requested review may stay unanswered before the requirement is
 * released as EXHAUSTED. Copilot normally answers within a minute; a repo
 * where the feature is silently unavailable would otherwise wait forever.
 *
 * This is the ONLY remaining budget, and it is deliberately the one that
 * cannot drop feedback: it fires exactly when there is no feedback to drop.
 */
export const COPILOT_AWAIT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Tolerance when comparing OUR local timestamps against GitHub's. Only used
 * for the timestamp fallback — the primary "this review covers the current
 * code" test compares commit SHAs and needs no clock at all.
 */
export const COPILOT_CLOCK_SKEW_MS = 2 * 60 * 1000;

export interface CopilotReviewState {
  status: CopilotStatus;
  /** PR number the requirement tracks; null until a PR was resolved. */
  pr: number | null;
  /** ISO time the requirement was armed by a PR-affecting ship. */
  armedAt: string;
  /** ISO time the EXTENSION requested the review (never agent-supplied). */
  requestedAt?: string;
  /**
   * ISO time of the FIRST request in this cycle. The wait budget is anchored
   * here, not on `requestedAt`: re-requesting must not push the deadline out,
   * or an agent that keeps calling `request_copilot_review` could wait forever
   * on a repo where Copilot never answers.
   */
  firstRequestedAt?: string;
  /** PR head SHA the current cycle was requested against / satisfied at. */
  head?: string;
  /**
   * Copilot review cycles since the requirement was first armed. Bookkeeping
   * only — nothing caps it (see COPILOT_AWAIT_TIMEOUT_MS).
   */
  rounds: number;
  /** ISO time of the last transition. */
  at?: string;
  /** Human-readable explanation of the last transition. */
  note?: string;
  /** Threads still needing work at the last check (status OPEN). */
  openThreads?: number;
  /**
   * Sticky memory of a CONFIRMED availability probe (a real Copilot review was
   * seen on this PR or in the repo's recent PRs). Cached because the evidence
   * is monotonic — a repository that has done a Copilot review can do one —
   * so later cycles skip the history query entirely. Never set from an
   * ASSUMED (owner allow-list) decision: an allow-list entry is a policy, not
   * evidence, and must stay re-evaluable when the policy changes.
   */
  supportConfirmed?: boolean;
}

/** How sure are we that Copilot code review works on this repository? */
export type CopilotSupport = "CONFIRMED" | "ASSUMED" | "UNKNOWN";

/**
 * Logins that mean "the Copilot reviewer".
 *
 * GitHub spells the reviewer differently depending on the surface: the REST
 * review-request endpoint takes `copilot-pull-request-reviewer[bot]`, GraphQL
 * reports the bot login without the suffix, and the CLI shorthand is
 * `@copilot`. Matching is case-insensitive and the `[bot]` suffix is optional,
 * so all three spellings map to the same actor.
 */
export function isCopilotAuthor(login: string | null | undefined): boolean {
  if (typeof login !== "string") return false;
  const normalized = login.trim().toLowerCase().replace(/\[bot\]$/, "");
  return normalized === "copilot" ||
    normalized === "copilot-pull-request-reviewer" ||
    normalized === "github-copilot";
}

/** The reviewer login the REST fallback must request. */
export const COPILOT_REVIEWER_LOGIN = "copilot-pull-request-reviewer[bot]";

/**
 * A PR-affecting ship happened: (re)open a Copilot cycle.
 *
 * This deliberately overrides EVERY terminal status. Without that, the most
 * common ordering — push the branch, then open the PR — would resolve to
 * UNSUPPORTED ("no PR yet") on the push and stay there, and the feature would
 * be bypassed by the normal way people work. `rounds` stays cumulative across
 * re-arms so the count reads as "how long has this conversation been going",
 * not "how many times was the counter reset".
 */
export function armCopilotReview(
  prev: CopilotReviewState | undefined,
  nowIso: string,
): CopilotReviewState {
  return {
    status: "ARMED",
    pr: prev?.pr ?? null,
    armedAt: nowIso,
    rounds: prev?.rounds ?? 0,
    // Availability evidence survives re-arming: it is a fact about the
    // repository, not about this cycle.
    ...(prev?.supportConfirmed ? { supportConfirmed: true } : {}),
    at: nowIso,
    note: "PR created or updated — a Copilot review round is due",
  };
}

/** The extension requested a review: stamp the authoritative time + head. */
export function recordCopilotRequest(
  prev: CopilotReviewState | undefined,
  args: {
    pr: number | null;
    head: string | null;
    nowIso: string;
    note?: string;
    supportConfirmed?: boolean;
  },
): CopilotReviewState {
  return {
    status: "AWAITING",
    pr: args.pr,
    armedAt: prev?.armedAt ?? args.nowIso,
    requestedAt: args.nowIso,
    // Anchor the wait budget on the first request of this cycle. Older
    // sidecars have no `firstRequestedAt`; their `requestedAt` is that anchor.
    firstRequestedAt: prev?.firstRequestedAt ?? prev?.requestedAt ?? args.nowIso,
    ...(args.head ? { head: args.head } : {}),
    rounds: (prev?.rounds ?? 0) + 1,
    ...(args.supportConfirmed || prev?.supportConfirmed ? { supportConfirmed: true } : {}),
    at: args.nowIso,
    note: args.note ?? "Copilot review requested",
  };
}

/**
 * Terminal transition (release the requirement) with an explanation.
 *
 * `openThreads` is carried into the terminal state on purpose: releasing with
 * Copilot findings still unhandled is allowed (nothing may strand a task), but
 * the count has to survive the release. It is the ONLY thing that survives on
 * the paths that matter — the PR is gone, `gh` lost its credentials, the API
 * refused, so there is no payload left to list from — and the extension turns
 * it into the "you are abandoning N findings, tell the user" line those paths
 * used to be silent about.
 */
export function releaseCopilotReview(
  prev: CopilotReviewState | undefined,
  status: "SATISFIED" | "UNSUPPORTED" | "EXHAUSTED",
  note: string,
  nowIso: string,
  head?: string | null,
  openThreads?: number,
): CopilotReviewState {
  const boundHead = head ?? prev?.head ?? null;
  const unhandled = openThreads ?? prev?.openThreads;
  return {
    status,
    pr: prev?.pr ?? null,
    armedAt: prev?.armedAt ?? nowIso,
    ...(prev?.requestedAt ? { requestedAt: prev.requestedAt } : {}),
    ...(prev?.firstRequestedAt ? { firstRequestedAt: prev.firstRequestedAt } : {}),
    ...(boundHead ? { head: boundHead } : {}),
    rounds: prev?.rounds ?? 0,
    ...(prev?.supportConfirmed ? { supportConfirmed: true } : {}),
    ...(typeof unhandled === "number" ? { openThreads: unhandled } : {}),
    at: nowIso,
    note,
  };
}

/** Does this state still hold `declare_done` back? */
export function isCopilotOutstanding(state: CopilotReviewState | undefined): boolean {
  if (!state) return false;
  return !RELEASED.has(state.status);
}

/**
 * The unmet-requirement lines for `declare_done` / the L2 continuation.
 * Empty when nothing is outstanding. Never used by the ship gate.
 */
export function copilotProblems(state: CopilotReviewState | undefined): string[] {
  if (!isCopilotOutstanding(state) || !state) return [];
  const pr = state.pr === null ? "the PR" : `PR #${state.pr}`;
  switch (state.status) {
    case "ARMED":
      return [`Copilot code review not requested for ${pr} — call request_copilot_review`];
    case "AWAITING":
      return [`Copilot code review of ${pr} has not come back yet — call check_copilot_review`];
    case "OPEN":
      return [
        `${state.openThreads ?? 0} Copilot review thread(s) on ${pr} still need work — fix and ` +
        "resolve them, or reply in the thread with the reason it will not be fixed, then call " +
        "check_copilot_review",
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Payload parsing (tolerant: a shape we do not recognize is "no data", never
// an exception and never an optimistic default).
// ---------------------------------------------------------------------------

export interface PrSummary {
  number: number;
  head: string | null;
  url: string | null;
  state: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return undefined; }
}

/**
 * `gh pr view --json` field sets, versioned by gh's own field whitelist.
 * `headRefOid` only exists in newer gh builds; legacy gh (measured: 2.4.0)
 * rejects the modern list with `Unknown JSON field: "headRefOid"` and the
 * gate must retry with the legacy list — `analyzeCopilot` then anchors proof
 * on timestamps instead of the commit (documented fallback).
 */
export const PR_VIEW_JSON_FIELDS: Readonly<{ modern: string; legacy: string }> = Object.freeze({
  modern: "number,headRefOid,url,state",
  legacy: "number,url,state",
});

/** True when gh rejects a --json field list it does not know (version drift). */
export function isUnknownJsonFieldError(stderr: string): boolean {
  return /Unknown JSON field/.test(stderr);
}

/** First non-empty stderr line (gh's real cause), else the fallback text. */
export function firstErrorLine(stderr: string, fallback: string): string {
  const line = stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, 200) : fallback;
}

export interface GhCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type PrViewDecision =
  | { ok: true; pr: PrSummary }
  | { ok: false; error: string };

/**
 * Decide the `gh pr view` outcome from the modern and (optional) legacy
 * attempts. Pure so the version-drift control flow is behavior-testable:
 *
 *  - modern ok      → its payload wins (unparseable ⇒ its own error).
 *  - modern failed  → the retry with the legacy field list happens ONLY for
 *    the field-whitelist error (`Unknown JSON field: "headRefOid"`, legacy
 *    gh); any other failure is the real cause and is reported as-is.
 *  - modern whitelist-failed, legacy ok → legacy payload wins (head null;
 *    `analyzeCopilot` then anchors proof on timestamps).
 *  - modern whitelist-failed, legacy also failed → THE LEGACY error is
 *    reported — the whitelist error would mask the real cause (e.g.
 *    "no pull requests found for branch \"main\"").
 */
export function decidePrView(
  modern: GhCommandResult,
  legacy: GhCommandResult | undefined,
  fallbackText = "`gh pr view` failed (gh missing, not authenticated, or no PR)",
): PrViewDecision {
  if (modern.ok) {
    const pr = parsePrView(modern.stdout);
    if (pr) return { ok: true, pr };
    return { ok: false, error: "`gh pr view` returned no recognizable pull request" };
  }
  if (!isUnknownJsonFieldError(modern.stderr)) {
    return { ok: false, error: firstErrorLine(modern.stderr, fallbackText) };
  }
  if (!legacy) {
    return { ok: false, error: firstErrorLine(modern.stderr, fallbackText) };
  }
  if (!legacy.ok) {
    return { ok: false, error: firstErrorLine(legacy.stderr, fallbackText) };
  }
  const pr = parsePrView(legacy.stdout);
  if (!pr) return { ok: false, error: "`gh pr view` returned no recognizable pull request" };
  return { ok: true, pr };
}

/** Parse `gh pr view --json number,headRefOid,url,state` (head optional). */
export function parsePrView(raw: string): PrSummary | undefined {
  const obj = asRecord(parseJson(raw));
  if (!obj) return undefined;
  const number = obj.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return undefined;
  return {
    number,
    head: typeof obj.headRefOid === "string" && obj.headRefOid.length > 0 ? obj.headRefOid : null,
    url: typeof obj.url === "string" ? obj.url : null,
    state: typeof obj.state === "string" ? obj.state : null,
  };
}

/** Parse `gh repo view --json nameWithOwner` → "owner/name". */
export function parseNameWithOwner(raw: string): string | null {
  const obj = asRecord(parseJson(raw));
  const value = obj?.nameWithOwner;
  return typeof value === "string" && /^[^/\s]+\/[^/\s]+$/.test(value) ? value : null;
}

/**
 * Fallback slug extraction from a PR URL. Works for github.com and GHES alike
 * because it anchors on the `/pull/<n>` suffix rather than on the host.
 */
export function slugFromPrUrl(url: string | null): string | null {
  if (typeof url !== "string") return null;
  const m = /\/([^/\s]+)\/([^/\s]+)\/pull\/\d+(?:$|[/?#])/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * How many recent PRs the availability probe looks back over.
 *
 * Large enough that a repository which uses Copilot at all almost certainly
 * shows one (measured: 7 of the last 20 PRs on a repo that uses it), small
 * enough to stay one cheap query.
 */
export const COPILOT_HISTORY_PR_COUNT = 20;

/**
 * Availability probe: has Copilot EVER reviewed a PR in this repository?
 *
 * This replaced a `suggestedActors(capabilities:[CAN_BE_ASSIGNED])` probe that
 * looked reasonable and was measurably useless: that filter answers "who can
 * be an ASSIGNEE" (the Copilot coding agent), not "who can review", and
 * GraphQL has no other filter to offer — `RepositorySuggestedActorFilter` only
 * defines CAN_BE_ASSIGNED and CAN_BE_AUTHOR. Measured on a repository whose
 * PRs Copilot demonstrably reviews, that probe returned NO Copilot actor, so
 * it was a constant "false" driving a constant "unsupported".
 *
 * Past reviews, by contrast, are direct evidence of the exact capability we
 * care about.
 */
export const COPILOT_HISTORY_QUERY = `query($owner:String!,$name:String!,$count:Int!){
  repository(owner:$owner,name:$name){
    pullRequests(last:$count,states:[OPEN,MERGED,CLOSED]){
      nodes{reviews(last:20){nodes{author{login}}}}
    }
  }
}`;

/**
 * Parse {@link COPILOT_HISTORY_QUERY}: `true` when a Copilot review was found,
 * `false` when the PR list was readable and held none, `undefined` when the
 * payload was not readable at all.
 *
 * `false` means "no evidence", NOT "unsupported" — a repository nobody has
 * ever asked has the same empty history as one that cannot. The caller
 * combines it with the owner allow-list before concluding anything.
 */
export function parseCopilotHistoryProbe(raw: string): boolean | undefined {
  const repo = asRecord(asRecord(asRecord(parseJson(raw))?.data)?.repository);
  const nodes = asRecord(repo?.pullRequests)?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  return nodes.some((pr) => {
    const reviews = asRecord(asRecord(pr)?.reviews)?.nodes;
    return Array.isArray(reviews) && reviews.some((r) => isCopilotAuthor(login(r)));
  });
}

/** The `owner` half of an `owner/name` slug, lowercased; null when unusable. */
export function ownerOfSlug(slug: string | null | undefined): string | null {
  if (typeof slug !== "string") return null;
  const owner = slug.split("/")[0]?.trim().toLowerCase();
  return owner ? owner : null;
}

/**
 * Is this repository's owner on the configured allow-list?
 *
 * The allow-list is a POLICY escape hatch, not evidence: it exists because
 * GitHub gives no way to ask "is Copilot code review enabled here?", and
 * waiting 20 minutes to find out is worse than being told. Matching is
 * case-insensitive because GitHub logins are.
 */
export function isCopilotOwnerAllowed(
  slug: string | null | undefined,
  owners: readonly string[],
): boolean {
  const owner = ownerOfSlug(slug);
  if (!owner) return false;
  return owners.some((o) => typeof o === "string" && o.trim().toLowerCase() === owner);
}

/**
 * Decide availability from the evidence gathered so far.
 *
 * Order matters: real reviews outrank the allow-list, and the allow-list
 * outranks silence. An unreadable history probe (`undefined`) is NOT evidence
 * of absence — it falls through to the allow-list exactly like a readable
 * empty history, so a flaky API call cannot flip a repo to UNKNOWN on its own
 * when policy already covers it.
 */
export function decideCopilotSupport(args: {
  /** A Copilot review or thread exists on THIS PR. */
  onPr?: boolean;
  /** Sticky evidence from an earlier cycle. */
  remembered?: boolean;
  /** Result of {@link parseCopilotHistoryProbe}. */
  history?: boolean;
  /** owner/name for this repository. */
  slug?: string | null;
  /** Configured owner allow-list. */
  owners?: readonly string[];
}): CopilotSupport {
  if (args.onPr === true || args.remembered === true || args.history === true) return "CONFIRMED";
  if (isCopilotOwnerAllowed(args.slug ?? null, args.owners ?? [])) return "ASSUMED";
  return "UNKNOWN";
}

/**
 * The one GraphQL query the extension runs for a Copilot check.
 *
 * Both comment ends are selected because they answer different questions: the
 * FIRST comment says who started the thread (only Copilot's threads are this
 * requirement's business) and carries the text the agent has to act on, the
 * LAST one says whether the ball is still in our court.
 */
export const COPILOT_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      headRefOid
      reviews(last:50){nodes{author{login} submittedAt state commit{oid}}}
      reviewThreads(first:100){nodes{
        id isResolved isOutdated path line
        firstComment: comments(first:1){nodes{author{login} createdAt body}}
        lastComment: comments(last:1){nodes{author{login} createdAt}}
      }}
    }
  }
}`;

export interface CopilotThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  /** Login that STARTED the thread (a Copilot thread is what we track). */
  author: string | null;
  /** Login of the most recent comment — "still Copilot" means our turn. */
  lastAuthor: string | null;
  /** Creation time of the first comment (ISO), for the freshness fallback. */
  createdAt: string | null;
  /** Short excerpt of the first comment, so the agent can act on the list. */
  excerpt: string;
}

export interface CopilotReviewSummary {
  author: string | null;
  submittedAt: string | null;
  /** Commit the review was submitted against — the clock-free anchor. */
  commit: string | null;
  state: string | null;
}

export interface CopilotPayload {
  head: string | null;
  reviews: CopilotReviewSummary[];
  threads: CopilotThread[];
}

function login(node: unknown): string | null {
  const author = asRecord(asRecord(node)?.author);
  const value = author?.login;
  return typeof value === "string" ? value : null;
}

function firstNode(container: unknown): Record<string, unknown> | undefined {
  const nodes = asRecord(container)?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  return asRecord(nodes[0]);
}

/**
 * Parse the GraphQL payload for one PR (reviews + review threads).
 * Returns undefined when the response carries no recognizable pull request —
 * which the caller must treat as "no evidence", not as "nothing to do".
 */
export function parseCopilotPayload(raw: string): CopilotPayload | undefined {
  const root = asRecord(parseJson(raw));
  const pr = asRecord(asRecord(asRecord(root?.data)?.repository)?.pullRequest);
  if (!pr) return undefined;

  const reviewNodes = asRecord(pr.reviews)?.nodes;
  const reviews: CopilotReviewSummary[] = Array.isArray(reviewNodes)
    ? reviewNodes.flatMap((node) => {
      const rec = asRecord(node);
      if (!rec) return [];
      return [{
        author: login(rec),
        submittedAt: typeof rec.submittedAt === "string" ? rec.submittedAt : null,
        commit: typeof asRecord(rec.commit)?.oid === "string" ? asRecord(rec.commit)!.oid as string : null,
        state: typeof rec.state === "string" ? rec.state : null,
      }];
    })
    : [];

  const threadNodes = asRecord(pr.reviewThreads)?.nodes;
  const threads: CopilotThread[] = Array.isArray(threadNodes)
    ? threadNodes.flatMap((node) => {
      const rec = asRecord(node);
      if (!rec || typeof rec.id !== "string") return [];
      const first = firstNode(rec.firstComment);
      const last = firstNode(rec.lastComment);
      const body = typeof first?.body === "string" ? first.body : "";
      return [{
        id: rec.id,
        isResolved: rec.isResolved === true,
        isOutdated: rec.isOutdated === true,
        path: typeof rec.path === "string" ? rec.path : null,
        line: typeof rec.line === "number" ? rec.line : null,
        author: first ? login({ author: first.author }) : null,
        lastAuthor: last ? login({ author: last.author }) : null,
        createdAt: typeof first?.createdAt === "string" ? first.createdAt : null,
        excerpt: body.replace(/\s+/g, " ").trim().slice(0, 200),
      }];
    })
    : [];

  return {
    head: typeof pr.headRefOid === "string" ? pr.headRefOid : null,
    reviews,
    threads,
  };
}

export interface CopilotAnalysis {
  /** Copilot has reviewed the code this cycle is about. */
  reviewed: boolean;
  /** Copilot threads that are unresolved AND waiting on us. */
  actionable: CopilotThread[];
  /** Unresolved Copilot threads we already replied to (accepted as explained). */
  answered: number;
  /** Resolved Copilot threads. */
  resolved: number;
  /** Current PR head, straight from the payload. */
  head: string | null;
  /**
   * Copilot has touched this PR at all (any review, any thread, any age).
   * Availability evidence — deliberately NOT tied to the current cycle.
   */
  present: boolean;
}

function parseTime(value: string | null | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Classify what Copilot has done for this cycle.
 *
 * "Reviewed" is anchored on the COMMIT first (a Copilot review submitted
 * against the current head proves it saw this code, with no clock involved),
 * and only falls back to timestamps — with a skew tolerance — when the payload
 * carries no commit. If the anchor time itself is unparseable, ONLY the
 * commit-anchored proof counts; guessing there would be the one direction that
 * can wave a cycle through unreviewed.
 *
 * "Actionable" is a thread Copilot started, that is unresolved, and whose most
 * recent comment is still Copilot's — i.e. the ball is in our court. A thread
 * we answered counts as handled even while unresolved (the user's rule: an
 * explanation is a valid outcome), and Copilot commenting again after our
 * reply flips it back to actionable, which is exactly right. `isOutdated` does
 * NOT excuse a thread: code moving is not the same as the concern being
 * addressed — it is surfaced to the agent as a hint instead.
 *
 * Note what "actionable" deliberately does NOT depend on: which commit the
 * review was submitted against, and whether `reviewed` is true for this cycle.
 * An unanswered Copilot finding stays the agent's business after a push —
 * GitHub does not re-review a new head by default, so the old thread is
 * frequently the ONLY feedback that exists, and scoping it to the current
 * head is precisely how findings used to be dropped on the floor.
 */
export function analyzeCopilot(
  payload: CopilotPayload,
  opts: { anchorAt: string | undefined },
): CopilotAnalysis {
  const anchorMs = parseTime(opts.anchorAt);
  const head = payload.head;

  const copilotReviews = payload.reviews.filter((r) => isCopilotAuthor(r.author));
  const copilotThreads = payload.threads.filter((t) => isCopilotAuthor(t.author));

  const commitAnchored = head !== null && copilotReviews.some((r) => r.commit === head);
  const timeAnchored = anchorMs !== undefined && (
    copilotReviews.some((r) => {
      const ms = parseTime(r.submittedAt);
      return ms !== undefined && ms >= anchorMs - COPILOT_CLOCK_SKEW_MS;
    }) ||
    copilotThreads.some((t) => {
      const ms = parseTime(t.createdAt);
      return ms !== undefined && ms >= anchorMs - COPILOT_CLOCK_SKEW_MS;
    })
  );

  const unresolved = copilotThreads.filter((t) => !t.isResolved);
  const actionable = unresolved.filter((t) => isCopilotAuthor(t.lastAuthor));

  return {
    reviewed: commitAnchored || timeAnchored,
    actionable,
    answered: unresolved.length - actionable.length,
    resolved: copilotThreads.length - unresolved.length,
    head,
    present: copilotReviews.length > 0 || copilotThreads.length > 0,
  };
}

/**
 * Advance the state machine from a fresh analysis.
 *
 * Terminal statuses come FIRST, because a released cycle is a decision that
 * has already been made and re-deciding it is how a finished requirement comes
 * back from the dead. `EXHAUSTED` (the budget is spent) and `UNSUPPORTED` (the
 * repo cannot do this at all) are never re-opened by *observation*: this
 * function will not move them, whatever the payload says. Re-opening is an
 * explicit act — a new PR-affecting ship calling {@link armCopilotReview}, or
 * the agent deliberately calling `request_copilot_review` again. Observed for
 * real: a released cycle was re-classified as ARMED by
 * the very next check, and `declare_done` was blocked by a requirement that
 * had already been let go.
 * `SATISFIED` keeps its safety net at THIS layer: it only survives while it
 * still describes the code that was reviewed, so a head that moved under it
 * re-arms. Note that the extension short-circuits every released status before
 * calling this, so that branch is currently defense in depth (a rule of the
 * state machine) rather than a path the tools can reach — in practice the
 * re-arm comes from the ship.
 *
 * Then, in order, the fail-safe priorities:
 *  1. threads waiting on us ⇒ OPEN — FIRST, ahead of head drift and ahead of
 *     the wait budget. An unanswered Copilot finding is work the agent can
 *     always do (reply or resolve; Copilot's participation is not required),
 *     so this can never deadlock, and putting it anywhere lower is what let a
 *     push bury real findings: the head moved, `reviewed` went false, and the
 *     thread stopped being counted at all;
 *  2. head drift — the PR moved and nothing is pending on us, so this cycle's
 *     evidence is stale and a new request is due (ARMED). There is no round
 *     cap on this: as long as Copilot keeps finding things, the loop keeps
 *     going;
 *  3. no review yet ⇒ AWAITING, unless availability is UNKNOWN (nothing has
 *     ever shown Copilot works here) in which case the requirement is
 *     released immediately as UNSUPPORTED rather than burning the wait
 *     budget, or the wait budget already ran out ⇒ EXHAUSTED;
 *  4. otherwise ⇒ SATISFIED, bound to the head it was verified against.
 */
export function evaluateCopilot(
  state: CopilotReviewState,
  analysis: CopilotAnalysis,
  opts: {
    nowIso: string;
    now: number;
    /**
     * What the availability evidence says (see {@link decideCopilotSupport}).
     * Defaults to CONFIRMED so a caller that cannot probe keeps the
     * "wait for the review" behaviour instead of releasing early.
     */
    support?: CopilotSupport;
  },
): CopilotReviewState {
  const headMoved = Boolean(state.head && analysis.head && state.head !== analysis.head);
  const support = opts.support ?? "CONFIRMED";

  if (state.status === "EXHAUSTED" || state.status === "UNSUPPORTED") return state;
  if (state.status === "SATISFIED" && !headMoved && analysis.actionable.length === 0) return state;

  if (analysis.actionable.length > 0) {
    return {
      ...state,
      status: "OPEN",
      at: opts.nowIso,
      openThreads: analysis.actionable.length,
      note: `${analysis.actionable.length} Copilot thread(s) waiting on a fix, a resolve, or a reply`,
    };
  }

  if (headMoved) {
    return {
      ...armCopilotReview(state, opts.nowIso),
      pr: state.pr,
      note: "the PR head moved since the review was requested — request a fresh Copilot review",
      openThreads: 0,
    };
  }

  // NOTE: no round cap here. Deleted deliberately — see the comment on
  // COPILOT_AWAIT_TIMEOUT_MS. "We have been round this loop N times" was
  // never a reason to stop handling what the reviewer said, and every round
  // costs only the agent's own work.

  if (!analysis.reviewed) {
    // Nothing has ever demonstrated that Copilot reviews here, and the owner
    // is not on the allow-list: waiting out the full budget would spend the
    // user's time to learn nothing. Release now and say what would change the
    // answer.
    if (support === "UNKNOWN") {
      return releaseCopilotReview(
        state,
        "UNSUPPORTED",
        "no Copilot review has ever appeared on this repository's recent PRs and its owner is not " +
        "on the Copilot owner allow-list — treating Copilot code review as unavailable instead of " +
        "waiting; add the owner to copilotReview.owners in .pi/review-gate.json if that is wrong",
        opts.nowIso,
        null,
        0,
      );
    }
    // Anchored on the FIRST request of this cycle (falling back to the last
    // one for sidecars written before that field existed): re-requesting must
    // never buy more waiting time.
    const requestedMs = parseTime(state.firstRequestedAt ?? state.requestedAt);
    if (requestedMs !== undefined && opts.now - requestedMs > COPILOT_AWAIT_TIMEOUT_MS) {
      return releaseCopilotReview(
        state,
        "EXHAUSTED",
        "Copilot did not answer the review request within the wait budget — the repository or " +
        "account may not have Copilot code review enabled; escalate to the user",
        opts.nowIso,
        null,
        0,
      );
    }
    return {
      ...state,
      status: state.requestedAt ? "AWAITING" : "ARMED",
      at: opts.nowIso,
      note: state.requestedAt
        ? "Copilot has not posted its review yet — wait and check again"
        : "no Copilot review found for this PR yet — request one",
      openThreads: 0,
    };
  }

  return {
    ...releaseCopilotReview(
      state,
      "SATISFIED",
      `every Copilot thread handled (${analysis.resolved} resolved, ${analysis.answered} answered)`,
      opts.nowIso,
      analysis.head,
      0,
    ),
    openThreads: 0,
  };
}

/**
 * Sidecar validation.
 *
 * Direction of failure is chosen per field, always toward "more work, not
 * less": an unrecognized status becomes ARMED (a cycle that must still be
 * proven) rather than SATISFIED, a missing round count becomes 0 only for the
 * counter — never for the status — and a payload that is not an object at all
 * disappears entirely (there is nothing to re-arm from; the next PR ship arms
 * a fresh cycle). Nothing here can reject the whole sidecar: this field must
 * never be able to brick the ship gate it deliberately stays out of.
 */
export function sanitizeCopilotState(raw: unknown): CopilotReviewState | undefined {
  const obj = asRecord(raw);
  if (!obj) return undefined;
  const status = typeof obj.status === "string" && COPILOT_STATUSES.has(obj.status)
    ? obj.status as CopilotStatus
    : "ARMED";
  const rounds = typeof obj.rounds === "number" && Number.isInteger(obj.rounds) && obj.rounds >= 0
    ? obj.rounds
    : 0;
  const out: CopilotReviewState = {
    status,
    pr: typeof obj.pr === "number" && Number.isInteger(obj.pr) && obj.pr > 0 ? obj.pr : null,
    armedAt: typeof obj.armedAt === "string" ? obj.armedAt : "",
    rounds,
  };
  if (typeof obj.requestedAt === "string") out.requestedAt = obj.requestedAt;
  if (typeof obj.firstRequestedAt === "string") out.firstRequestedAt = obj.firstRequestedAt;
  if (typeof obj.head === "string" && obj.head.length > 0) out.head = obj.head;
  if (typeof obj.at === "string") out.at = obj.at;
  if (typeof obj.note === "string") out.note = obj.note.slice(0, 500);
  if (typeof obj.openThreads === "number" && Number.isInteger(obj.openThreads) && obj.openThreads >= 0) {
    out.openThreads = obj.openThreads;
  }
  // Only `true` survives: a forged or garbled value must not be able to claim
  // evidence that was never gathered. Claiming CONFIRMED costs waiting time,
  // never correctness, but the field should still mean what it says.
  if (obj.supportConfirmed === true) out.supportConfirmed = true;
  return out;
}
