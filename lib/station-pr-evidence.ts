/**
 * THE GATE'S OWN `pr` EVIDENCE — 「这一轮承诺的 PR,现在真的开着吗?」
 *
 * ── WHY THIS MODULE EXISTS (user report, 2026-09-16) ──
 *
 * The `pr` station's arrival check read two LOCAL facts (`GateState`):
 * a `gh pr create` the gate watched exit 0, and the PR number the Copilot
 * cycle resolved. Both are absent in the same ordinary situation — the PR
 * already exists and this round only appends commits to it:
 *
 *   - `gh` reports "a pull request for branch … already exists" as an ERROR
 *     (non-zero exit), so the watched-success evidence can never be recorded;
 *   - a repo with `copilotReview.enabled: false` never gets a resolved number,
 *     because `copilot_review` itself refuses there.
 *
 * The round was then judged "did not arrive" with no way out but closing the
 * open PR and opening a differently numbered one — which is what the report
 * said happened. The judge of a fact must not wait on a command it cannot
 * arrange: the gate asks GitHub itself.
 *
 * ── WHY IT IS ITS OWN MODULE ──
 *
 * `lib/delivery-station.ts` decides ARRIVAL and is deliberately pure (no fs,
 * no clock, no process) — its own test refuses a second import. RUNNING `gh`
 * and `git` is exactly what that module must not do, so the facts are gathered
 * here and handed to it as plain values (`StationArrivalFacts`), the same
 * split `dirty` already travels.
 *
 * Every probe here fails in ONE direction: an unreadable answer is `number:
 * null` / `unpushed: true`, which blocks the arrival rather than granting it.
 * A probe that cannot tell is never evidence.
 */

import { execFileSync } from "node:child_process";

import { resolveOpenPr } from "./copilot-gh.ts";
import type { PrSummary } from "./copilot-review.ts";

/**
 * What one probe learned about this repo.
 *
 * `number: null` means "no OPEN PR could be shown", NOT "there is none": gh
 * missing, unauthenticated, offline, a detached HEAD or an unreadable reply
 * all land here. The caller keeps its local evidence for exactly that reason.
 */
export interface OpenPrArrival {
  /** 当前分支上开着的 PR 号;查询没给出结果就是 null。 */
  number: number | null;
  url: string | null;
}

/** `gh` 探测的上限:收尾时的一次网络往返,不该拖住 declare_done。 */
const PR_PROBE_TIMEOUT_MS = 20000;

/** `git rev-list` 是纯本地读,慢成这样已经是异常。 */
const GIT_TIMEOUT_MS = 5000;

/** The `gh` question itself — a seam, so the decision below can be exercised without GitHub. */
export type OpenPrLookup = (
  dir: string,
  signal?: AbortSignal,
) => Promise<{ pr?: PrSummary }>;

export interface OpenPrProbeDeps {
  signal?: AbortSignal;
  /** 测试 seam;缺省是 `lib/copilot-gh.ts` 的 `resolveOpenPr`。 */
  lookup?: OpenPrLookup;
}

/**
 * Ask GitHub, once, whether the current branch has an open PR.
 *
 * `state === "OPEN"` is required, not merely "a PR was found": a CLOSED or
 * MERGED PR is a branch whose work is over, and `gh pr view` happily returns
 * one. An unreadable `state` is treated the same as no PR — this value only
 * ever GRANTS an arrival, so the strict reading is the safe one.
 *
 * It deliberately does NOT read whether the work was pushed: that is a LOCAL
 * `git` fact ( {@link hasUnpushedCommits} ), it is needed for every `pr`
 * evidence rather than just this one, and folding it in here made the two
 * impossible to state separately (round-1 quality P1, 2026-09-16).
 */
export async function probeOpenPr(
  dir: string,
  deps: OpenPrProbeDeps = {},
): Promise<OpenPrArrival> {
  const none: OpenPrArrival = { number: null, url: null };
  const lookup = deps.lookup ?? resolveOpenPr;
  const res = await lookup(dir, deps.signal ?? AbortSignal.timeout(PR_PROBE_TIMEOUT_MS));
  const pr = res.pr;
  if (!pr || pr.state !== "OPEN") return none;
  return { number: pr.number, url: pr.url };
}

/**
 * Is this branch fully pushed? — the local half of "the PR really carries
 * this work".
 *
 * `git rev-list --count @{upstream}..HEAD` answers it without touching the
 * network: a non-zero count is work that exists only here, and a missing
 * upstream (never pushed at all) throws into the same answer.
 *
 * It is asked of EVERY `pr` evidence, not next to one of them (round-1
 * quality P1, 2026-09-16): a watched `gh pr create` only proves a PR existed
 * at that moment — a checkpoint commit the gate itself lands afterwards sits
 * locally, and so does any commit made after the PR was opened.
 *
 * FAIL-CLOSED in every unreadable case — git absent, not a repository,
 * unparsable output — because the only consumer is an arrival check that this
 * reading can make STRICTER, never looser.
 */
export function hasUnpushedCommits(dir: string): boolean {
  try {
    const out = execFileSync("git", ["rev-list", "--count", "@{upstream}..HEAD"], {
      cwd: dir,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const ahead = Number.parseInt(out, 10);
    return !Number.isFinite(ahead) || ahead > 0;
  } catch {
    return true;
  }
}

/**
 * What the gate says after watching a `gh pr create` FAIL.
 *
 * gh's own stderr does name the existing PR, but it names it as an error next
 * to a non-zero exit — which reads as "I did something wrong" and invites the
 * guess that cost a user a closed PR and a renumbered review. This sentence is
 * the gate's answer to the question gh leaves open: the PR exists, so append
 * to it.
 *
 * `null` when the probe found nothing: then the failure is whatever gh said it
 * was, and the gate has no second opinion to add.
 */
export function existingPrNotice(probe: OpenPrArrival): string | null {
  if (probe.number === null) return null;
  const where = probe.url ? `（${probe.url}）` : "";
  return `门禁查过 GitHub:这个分支上的 PR #${probe.number} 是开着的${where} —— ` +
    "`gh pr create` 报错是因为它已经存在,不是这一步做错了。\n" +
    "  - 往**这个 PR** 追加提交即可:`git push` 之后新提交会自己出现在它上面,然后正常收尾。\n" +
    "  - 不要关掉它重开一个:PR 号会变,审查与讨论都得从头再来。";
}
