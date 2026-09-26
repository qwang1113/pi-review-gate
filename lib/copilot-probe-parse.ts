/**
 * L7 — the pure parsers of what `gh` answers about a PR's Copilot review:
 * the GraphQL queries the gate sends, and the tolerant readers of their
 * payloads, of the REST timeline and of `gh pr view` / `gh repo view`.
 *
 * Split out of lib/copilot-review.ts, whose docblock still explains the
 * whole loop (and why availability is decided from positive evidence only);
 * the state machine lives in lib/copilot-review-state.ts. No IO, no clock,
 * no throwing: an unrecognized shape is "no data", never an exception.
 */

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

// ---------------------------------------------------------------------------
// Payload parsing (tolerant: a shape we do not recognize is "no data", never
// an exception and never an optimistic default).
// ---------------------------------------------------------------------------

/**
 * The LIGHT query: everything a background poll needs to notice that Copilot's
 * answer arrived, and nothing else.
 *
 * Deliberately NOT {@link COPILOT_THREADS_QUERY}: that one carries up to 100
 * threads with their comment bodies (measured: 125 KB, ~2s on a 10k-line PR),
 * which is the right price for the one call that has to READ the findings and
 * the wrong price for a poll that runs every ~25 seconds for fifteen minutes.
 * This one measured ~1 KB: the head, whether a review request is still pending
 * (the PR page's dot), and the last few reviews.
 */
export const COPILOT_PROBE_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      headRefOid
      reviewRequests(first:10){totalCount nodes{requestedReviewer{__typename ... on Bot{login} ... on User{login} ... on Team{name} ... on Mannequin{login}}}}
      reviews(last:5){nodes{author{login} submittedAt state commit{oid}}}
    }
  }
}`;

/** What {@link COPILOT_PROBE_QUERY} answers. */
export interface CopilotProbe {
  /** The PR head at probe time (null when the payload did not carry one). */
  head: string | null;
  /**
   * Copilot is listed as a PENDING reviewer — the dot on the PR page.
   * `null` when the field was missing/unreadable, which is NOT "no".
   */
  queued: boolean | null;
  /** Reviews the probe read — enough for `analyzeCopilot` to see a landing. */
  payload: CopilotPayload;
}

/**
 * Parse {@link COPILOT_PROBE_QUERY}. Returns undefined when the response
 * carries no recognizable pull request (the caller must act on "no evidence",
 * never on a guess).
 *
 * The returned `payload.threads` is always empty on purpose: this query does
 * not read threads. `analyzeCopilot` only needs the REVIEWS to answer "did
 * Copilot answer this cycle" — the only question the poll asks — and `reviewed`
 * is deliberately independent of the thread list (see its doc).
 */
export function parseCopilotProbe(raw: string): CopilotProbe | undefined {
  const root = asRecord(parseJson(raw));
  const pr = asRecord(asRecord(asRecord(root?.data)?.repository)?.pullRequest);
  if (!pr) return undefined;
  const reviewNodes = asRecord(pr.reviews)?.nodes;
  const reviews: CopilotReviewSummary[] = Array.isArray(reviewNodes)
    ? reviewNodes.flatMap((node) => {
      const rec = asRecord(node);
      if (!rec) return [];
      const commit = asRecord(rec.commit)?.oid;
      return [{
        author: login(rec),
        submittedAt: typeof rec.submittedAt === "string" ? rec.submittedAt : null,
        commit: typeof commit === "string" ? commit : null,
        state: typeof rec.state === "string" ? rec.state : null,
      }];
    })
    : [];
  const requestNodes = asRecord(pr.reviewRequests)?.nodes;
  const queued = Array.isArray(requestNodes)
    ? requestNodes.some((node) => isCopilotAuthor(directLogin(asRecord(node)?.requestedReviewer)))
    : null;
  const head = typeof pr.headRefOid === "string" ? pr.headRefOid : null;
  return { head, queued, payload: { head, reviews, threads: [] } };
}

/**
 * The Copilot events of one PR's REST timeline (`/issues/:n/events`), reduced
 * to the three facts the wait runs on. All optional: an absent event is
 * absent, and the caller must not read it as "did not happen".
 *
 * The event names are GitHub's own, and they are REST-only — the GraphQL
 * `PullRequestTimelineItemsItemType` enum has no Copilot member (checked
 * against the live schema, 2026-09-14), which is why this probe is a REST
 * call and why it is NOT part of the ~25s poll: it costs two round trips and
 * is only needed where the cheap query cannot tell the failure modes apart.
 */
export interface CopilotTimeline {
  /** Latest request for the Copilot reviewer. */
  requestedAt: string | null;
  /** Latest `copilot_work_started` — Copilot's run is underway. */
  workStartedAt: string | null;
  /** Latest `copilot_work_finished_failure` — the run broke, no review came. */
  workFailedAt: string | null;
}

/**
 * Parse `/repos/:owner/:repo/issues/:n/events`. `undefined` when the payload
 * is not an event list at all (unreadable), never a zeroed-out timeline.
 *
 * Only Copilot's own events count: a `review_requested` for someone else, and
 * `referenced`/`committed` noise, are not evidence about this requirement.
 * The endpoint is ascending, so the LAST event of each kind wins.
 */
export function parseCopilotTimeline(raw: string): CopilotTimeline | undefined {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return undefined;
  const out: CopilotTimeline = { requestedAt: null, workStartedAt: null, workFailedAt: null };
  for (const item of parsed) {
    const rec = asRecord(item);
    const at = typeof rec?.created_at === "string" ? rec.created_at : null;
    if (!at) continue;
    switch (rec?.event) {
      case "review_requested":
        if (isCopilotAuthor(directLogin(rec.requested_reviewer))) out.requestedAt = at;
        break;
      case "copilot_work_started":
        out.workStartedAt = at;
        break;
      case "copilot_work_finished_failure":
        out.workFailedAt = at;
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Split a `gh api --include` response into its headers and body.
 *
 * The header block is the part before the first blank line; gh writes CRLF
 * line endings, but a body containing "\n\n" must not be mistaken for the
 * boundary, so the CRLF form is preferred when it exists at all. Returns the
 * body alone when there is no header block at all (plain `gh api` output).
 */
export function splitHttpResponse(raw: string): { headers: Map<string, string>; body: string } {
  const crlf = raw.indexOf("\r\n\r\n");
  const boundary = crlf >= 0 ? crlf : raw.indexOf("\n\n");
  const headerLen = crlf >= 0 ? 4 : 2;
  const headers = new Map<string, string>();
  const head = boundary < 0 ? raw : raw.slice(0, boundary);
  // A body-only payload (no status line) is passed through untouched.
  if (boundary < 0 || !/^HTTP\//.test(head)) return { headers, body: raw };
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body: raw.slice(boundary + headerLen) };
}

/**
 * The page number of a paginated response's LAST page, from its `Link` header.
 * `null` when there is no such header (a single-page answer).
 */
export function lastPageFromLink(link: string | undefined): number | null {
  if (typeof link !== "string") return null;
  const m = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
  const page = m ? Number.parseInt(m[1], 10) : NaN;
  return Number.isFinite(page) && page > 0 ? page : null;
}

export interface PrSummary {
  number: number;
  head: string | null;
  url: string | null;
  state: string | null;
}

/** A plain object (not an array, not null), else undefined. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
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
        lastComment: comments(last:1){nodes{id author{login} createdAt body}}
      }}
    }
  }
}`;

/**
 * How much of a comment is carried at all — a payload bound, not a dialog
 * bound. The dialog shows the body whole (the row budget that used to cut it
 * is gone, 2026-09-16); the full text the user reads is the transcript copy
 * `askFindings` writes before the box opens, because the point of that copy
 * was never the cut — it is that the user must be able to read what they are
 * approving. The cap exists for the TRANSCRIPT side: it bounds how much of one
 * comment is carried into the gate at all, and it is generous on purpose — a
 * cap smaller than what the user has to read would throw the text away.
 */
export const COPILOT_THREAD_BODY_CHARS = 1200;

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
  /**
   * The first comment in full (whitespace collapsed, capped at
   * {@link COPILOT_THREAD_BODY_CHARS}). `excerpt` is the one-line form for the
   * agent's list; this is what the USER is shown when they are asked to
   * approve the finding, and 200 characters are not always enough to decide.
   */
  body: string;
  /**
   * The LATEST comment's text (same treatment as {@link body}). Equal to
   * `body` while the thread has one comment; different once Copilot speaks
   * again — and Copilot speaking again is exactly what re-opens the question
   * (see {@link lastCommentId}), so the user must be shown THIS text, not the
   * one they already answered.
   */
  latestBody: string;
  /**
   * Id of the LAST comment. The triage key needs it: a decision is about a
   * piece of text, so Copilot commenting again on the same thread has to read
   * as a NEW finding (lib/copilot-triage.ts).
   */
  lastCommentId: string | null;
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

/**
 * A login carried DIRECTLY on the node (REST's `requested_reviewer`) rather
 * than nested under `author` (GraphQL's review/reviewer shapes). Two shapes,
 * two readers — using the wrong one silently answers "nobody", which is how a
 * queued Copilot request reads as "not queued".
 */
function directLogin(node: unknown): string | null {
  const value = asRecord(node)?.login;
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
      const raw = typeof first?.body === "string" ? first.body : "";
      const body = raw.replace(/\s+/g, " ").trim();
      const rawLast = typeof last?.body === "string" ? last.body : "";
      const latestBody = rawLast.replace(/\s+/g, " ").trim().slice(0, COPILOT_THREAD_BODY_CHARS);
      return [{
        id: rec.id,
        isResolved: rec.isResolved === true,
        isOutdated: rec.isOutdated === true,
        path: typeof rec.path === "string" ? rec.path : null,
        line: typeof rec.line === "number" ? rec.line : null,
        author: first ? login({ author: first.author }) : null,
        lastAuthor: last ? login({ author: last.author }) : null,
        createdAt: typeof first?.createdAt === "string" ? first.createdAt : null,
        excerpt: body.slice(0, 200),
        body: body.slice(0, COPILOT_THREAD_BODY_CHARS),
        latestBody: latestBody || body.slice(0, COPILOT_THREAD_BODY_CHARS),
        lastCommentId: typeof last?.id === "string" && last.id.length > 0 ? last.id : null,
      }];
    })
    : [];

  return {
    head: typeof pr.headRefOid === "string" ? pr.headRefOid : null,
    reviews,
    threads,
  };
}
