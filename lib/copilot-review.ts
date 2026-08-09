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
 *   EXHAUSTED   the round or wait budget ran out — released, escalate to human
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

/** Default cap on Copilot review cycles per task (project-configurable). */
export const COPILOT_MAX_ROUNDS_DEFAULT = 3;
/** Hard bounds for the configurable cap — a forged huge value cannot make the loop endless. */
export const COPILOT_MIN_ROUNDS = 1;
export const COPILOT_MAX_ROUNDS = 10;

/**
 * How long a requested review may stay unanswered before the requirement is
 * released as EXHAUSTED. Copilot normally answers within a minute; a repo
 * where the feature is silently unavailable would otherwise wait forever.
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
  /** Copilot review cycles consumed since the requirement was first armed. */
  rounds: number;
  /** ISO time of the last transition. */
  at?: string;
  /** Human-readable explanation of the last transition. */
  note?: string;
  /** Threads still needing work at the last check (status OPEN). */
  openThreads?: number;
}

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
 * be bypassed by the normal way people work. `rounds` is cumulative on
 * purpose: re-arming must not hand out a fresh budget, or a fix→push→re-arm
 * cycle could never exhaust it.
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
    at: nowIso,
    note: "PR created or updated — a Copilot review round is due",
  };
}

/** The extension requested a review: stamp the authoritative time + head. */
export function recordCopilotRequest(
  prev: CopilotReviewState | undefined,
  args: { pr: number | null; head: string | null; nowIso: string; note?: string },
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
    at: args.nowIso,
    note: args.note ?? "Copilot review requested",
  };
}

/** Terminal transition (release the requirement) with an explanation. */
export function releaseCopilotReview(
  prev: CopilotReviewState | undefined,
  status: "SATISFIED" | "UNSUPPORTED" | "EXHAUSTED",
  note: string,
  nowIso: string,
  head?: string | null,
): CopilotReviewState {
  const boundHead = head ?? prev?.head ?? null;
  return {
    status,
    pr: prev?.pr ?? null,
    armedAt: prev?.armedAt ?? nowIso,
    ...(prev?.requestedAt ? { requestedAt: prev.requestedAt } : {}),
    ...(prev?.firstRequestedAt ? { firstRequestedAt: prev.firstRequestedAt } : {}),
    ...(boundHead ? { head: boundHead } : {}),
    rounds: prev?.rounds ?? 0,
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

/** Parse `gh pr view --json number,headRefOid,url,state`. */
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
 * Capability probe: can this repository do Copilot review at all?
 *
 * GitHub exposes no "is Copilot code review enabled" API — GraphQL's
 * `RepositorySuggestedActorFilter` only knows CAN_BE_ASSIGNED and
 * CAN_BE_AUTHOR — so the presence of a Copilot actor among the repo's
 * suggested actors is a HEURISTIC, never a proof. That is why a negative
 * probe does not release the requirement on its own: it only triggers the
 * landing check below, which is evidence rather than inference.
 */
export const COPILOT_ACTOR_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:100){nodes{login}}
  }
}`;

/**
 * Parse {@link COPILOT_ACTOR_QUERY}: `true`/`false` when the actor list was
 * readable, `undefined` when it was not — an unreadable answer is "no
 * evidence", never "Copilot is missing".
 */
export function parseCopilotActorProbe(raw: string): boolean | undefined {
  const repo = asRecord(asRecord(asRecord(parseJson(raw))?.data)?.repository);
  const nodes = asRecord(repo?.suggestedActors)?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  return nodes.some((node) => {
    const value = asRecord(node)?.login;
    return typeof value === "string" && isCopilotAuthor(value);
  });
}

/**
 * Did a review request actually LAND on the PR?
 *
 * `gh pr edit --add-reviewer @copilot` exits 0 and the REST review-request
 * endpoint answers 200 even on repositories where GitHub silently drops the
 * bot, so the exit code proves nothing. This reads back
 * `gh pr view --json reviewRequests,reviews` and looks for Copilot in either
 * place — still requested, or already reviewed (Copilot can answer and be
 * removed from the request list before we look).
 *
 * `undefined` = the payload was not readable, so the caller must NOT conclude
 * anything from it (releasing a gate requirement on a parse failure would be
 * the one direction that fails open).
 */
export function parseCopilotRequestLanded(raw: string): boolean | undefined {
  const obj = asRecord(parseJson(raw));
  if (!obj) return undefined;
  const requests = obj.reviewRequests;
  const reviews = obj.reviews;
  if (!Array.isArray(requests) && !Array.isArray(reviews)) return undefined;
  const requested = Array.isArray(requests) && requests.some((node) => {
    const rec = asRecord(node);
    const value = rec?.login;
    // gh renders a requested reviewer as {__typename, login}; a bot reviewer
    // has no `author` wrapper, hence the direct login read.
    return typeof value === "string" && isCopilotAuthor(value);
  });
  const reviewed = Array.isArray(reviews) && reviews.some((node) => isCopilotAuthor(login(node)));
  return requested || reviewed;
}

/**
 * Second opinion on "did it land", from a DIFFERENT API surface.
 *
 * Parses REST `GET /repos/{o}/{r}/pulls/{n}/requested_reviewers`
 * (`{"users":[{"login":…}],"teams":[…]}`). Two reasons this is not redundant
 * with {@link parseCopilotRequestLanded}: review requests are eventually
 * consistent, so one immediate read can miss a request that did land; and a
 * `gh` build older than the `... on Bot{login}` selection renders a bot
 * reviewer as an empty entry in the JSON export while REST still names it.
 * Same three-valued contract — an unreadable answer is `undefined`.
 */
export function parseRestReviewRequests(raw: string): boolean | undefined {
  const obj = asRecord(parseJson(raw));
  const users = obj?.users;
  if (!Array.isArray(users)) return undefined;
  return users.some((node) => {
    const value = asRecord(node)?.login;
    return typeof value === "string" && isCopilotAuthor(value);
  });
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
  };
}

/**
 * Advance the state machine from a fresh analysis.
 *
 * Order matters and encodes the fail-safe priorities:
 *  1. head drift — the PR moved under us, so this cycle's evidence is stale
 *     and a new request is due (ARMED);
 *  2. budget — rounds spent or the wait ran too long ⇒ EXHAUSTED (released,
 *     with an escalation note): a repo where Copilot never answers must never
 *     strand the task;
 *  3. no review yet ⇒ AWAITING;
 *  4. threads waiting on us ⇒ OPEN;
 *  5. otherwise ⇒ SATISFIED, bound to the head it was verified against.
 */
export function evaluateCopilot(
  state: CopilotReviewState,
  analysis: CopilotAnalysis,
  opts: { nowIso: string; now: number; maxRounds: number },
): CopilotReviewState {
  if (state.head && analysis.head && state.head !== analysis.head) {
    return {
      ...armCopilotReview(state, opts.nowIso),
      pr: state.pr,
      note: "the PR head moved since the review was requested — request a fresh Copilot review",
    };
  }

  if (state.rounds > opts.maxRounds) {
    return releaseCopilotReview(
      state,
      "EXHAUSTED",
      `Copilot review budget spent (${state.rounds}/${opts.maxRounds} rounds) — escalate to the user`,
      opts.nowIso,
    );
  }

  if (!analysis.reviewed) {
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

  if (analysis.actionable.length > 0) {
    return {
      ...state,
      status: "OPEN",
      at: opts.nowIso,
      openThreads: analysis.actionable.length,
      note: `${analysis.actionable.length} Copilot thread(s) waiting on a fix, a resolve, or a reply`,
    };
  }

  return {
    ...releaseCopilotReview(
      state,
      "SATISFIED",
      `every Copilot thread handled (${analysis.resolved} resolved, ${analysis.answered} answered)`,
      opts.nowIso,
      analysis.head,
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
  return out;
}
