/**
 * WHERE THIS ROUND STOPS — the delivery station of a loop goal / a plan.
 *
 * ── THE MEASURED GAP (user ask, 2026-09-06) ──
 *
 * A session and its user never agreed on how far a round travels. "Done"
 * meant precommit to one side and an open PR to the other, and the gate had
 * no field to disagree about: `grep -r station lib/` found nothing. So the
 * station becomes a FIELD of the two contracts the gate already binds — the
 * loop goal and the orchestration plan — with three values and one default:
 *
 *   - `precommit` — the gate's checks pass; the USER commits.
 *   - `commit`    — the commit is made; the USER pushes.
 *   - `pr`        — the branch is pushed and the PR is open.
 *
 * ── WHY IT IS ITS OWN MODULE, AND WHY IT IS PURE ──
 *
 * Two callers need the same three values (the goal side and the plan side),
 * and a third — the ship gate's hook path, in the NEXT task — needs the
 * question "does this station allow this ship command?". A module with no
 * filesystem, no clock and no gate-state import can be called from every one
 * of them, including a git hook that runs in its own process.
 *
 * {@link shipKindAllowedAtStation} therefore ships HERE, in this round, even
 * though nothing in this round calls it: the alternative is the next task
 * writing its own copy of the same table inside the hook path, which is
 * exactly the "two implementations" philosophy three forbids. What it must
 * NOT do is invent a second vocabulary for ship commands — the gate already
 * has one, `ShipCommandKind` (lib/constants.ts), used by the ship detector,
 * the classifier and the arbiter — so this module classifies nothing and only
 * answers a question about the kinds that module already defines.
 *
 * The station is a CEILING, never a licence: `pr` says the round MAY reach a
 * PR, not that any other gate (review verdict, precommit, Copilot cycle) is
 * satisfied. Every existing requirement still has to be met on its own terms.
 */

import { SHIP_COMMAND_KINDS, type ShipCommandKind } from "./constants.ts";

/** The three stations, most conservative first. The order IS the strictness. */
export const DELIVERY_STATIONS = Object.freeze(["precommit", "commit", "pr"] as const);

/** Where a round is contracted to stop. */
export type DeliveryStation = (typeof DELIVERY_STATIONS)[number];

/**
 * What a MISSING or unreadable station means.
 *
 * `precommit` — the most conservative value, which allows no ship command at
 * all. A contract that forgot to say where it stops must not be read as
 * permission to publish, and the user chose this reading explicitly
 * (2026-09-06): a missing station blocks commit/push/PR, and nothing else. It
 * never withholds the EDIT surface — an un-stationed goal is still an
 * approved goal.
 */
export const DEFAULT_DELIVERY_STATION: DeliveryStation = "precommit";

/** Is this exact value one of the three stations? */
export function isDeliveryStation(raw: unknown): raw is DeliveryStation {
  return typeof raw === "string" && (DELIVERY_STATIONS as readonly string[]).includes(raw);
}

/**
 * Read a station off anything — a tool parameter, a parsed JSON plan, a
 * sidecar record.
 *
 * Never throws and never reports a problem: an absent, misspelled or
 * hand-edited value degrades to {@link DEFAULT_DELIVERY_STATION}. The
 * degradation is safe in one direction only, which is why it is allowed to be
 * silent — the strictest station is the one nobody can be harmed by getting.
 * Surrounding whitespace and case are tolerated (`" PR "` is `pr`); anything
 * else is not guessed at.
 */
export function parseDeliveryStation(raw: unknown): DeliveryStation {
  if (typeof raw !== "string") return DEFAULT_DELIVERY_STATION;
  const normalized = raw.trim().toLowerCase();
  return isDeliveryStation(normalized) ? normalized : DEFAULT_DELIVERY_STATION;
}

/** How strict a station is: 0 = strictest (`precommit`). */
export function deliveryStationRank(station: DeliveryStation): number {
  return DELIVERY_STATIONS.indexOf(station);
}

/**
 * Does moving from `previous` to `next` GRANT something new?
 *
 * The plan approval binds to content, and a station is content: raising
 * `precommit` to `pr` hands the orchestration the authority to publish, which
 * is the class of edit that must go back to the user. Lowering it takes
 * authority away and needs no dialog — the same asymmetry the plan-approval
 * module already applies to boundaries and parallelism.
 */
export function isStationWidening(previous: DeliveryStation, next: DeliveryStation): boolean {
  return deliveryStationRank(next) > deliveryStationRank(previous);
}

/**
 * Ship kinds each station may reach — the table the ship gate will consult.
 *
 * `pr` includes `commit` and `push` because a pull request cannot exist
 * without them: a station that allowed `pr-create` but not `push` would be a
 * contract nobody can satisfy. `pr-edit` travels with `pr-create` for the
 * same reason (a PR whose body cannot be corrected is not a deliverable).
 */
const ALLOWED_SHIP_KINDS: Readonly<Record<DeliveryStation, readonly ShipCommandKind[]>> = Object.freeze({
  precommit: Object.freeze([] as readonly ShipCommandKind[]),
  commit: Object.freeze(["commit"] as readonly ShipCommandKind[]),
  pr: Object.freeze([...SHIP_COMMAND_KINDS] as readonly ShipCommandKind[]),
});

/** Every ship kind this station may reach (strictly ordered as SHIP_COMMAND_KINDS). */
export function allowedShipKinds(station: DeliveryStation): readonly ShipCommandKind[] {
  return ALLOWED_SHIP_KINDS[station];
}

/**
 * THE question the ship gate will ask (next task): may this station run this
 * ship command?
 *
 * A pure lookup, deliberately with no notion of WHY a command is refused —
 * the caller owns the refusal text, because a station block and a review-gate
 * block are different problems with different next steps.
 */
export function shipKindAllowedAtStation(station: DeliveryStation, kind: ShipCommandKind): boolean {
  return ALLOWED_SHIP_KINDS[station].includes(kind);
}

/** One line, in the user's language, for the dialog and the transcript. */
export function describeDeliveryStation(station: DeliveryStation): string {
  switch (station) {
    case "precommit":
      return "precommit —— 门禁检查跑通即交付，由你自己 commit（不 commit、不 push、不开 PR）";
    case "commit":
      return "commit —— 提交完成即交付，由你自己 push（不 push、不开 PR）";
    case "pr":
      return "pr —— 一路做到 PR 开出来";
  }
}

/** The station line both consent surfaces print, so they can never diverge. */
export function deliveryStationLine(station: DeliveryStation): string {
  return "本轮交付站点：" + describeDeliveryStation(station);
}

/** The choices, spelled out for a tool description or a refusal text. */
export const DELIVERY_STATION_CHOICES = DELIVERY_STATIONS.join(" | ");

// ---------------------------------------------------------------------------
// the ship gate's side: what a station REFUSES, and how to get past it
// ---------------------------------------------------------------------------

/** How a ship kind is written in a refusal — the command, not the enum name. */
const SHIP_KIND_COMMANDS: Readonly<Record<ShipCommandKind, string>> = Object.freeze({
  commit: "git commit",
  push: "git push",
  "pr-create": "gh pr create",
  "pr-edit": "gh pr edit",
});

/** The commands a station may reach, or the fact that it may reach none. */
export function describeAllowedShipKinds(station: DeliveryStation): string {
  const kinds = allowedShipKinds(station);
  if (kinds.length === 0) return "无 —— 该站点不放行任何 ship 命令";
  return kinds.map((kind) => `\`${SHIP_KIND_COMMANDS[kind]}\``).join(" / ");
}

/**
 * ONE problem line for a ship command that travels further than the round is
 * contracted to.
 *
 * It names the blocked command and the station rather than saying "not
 * allowed": the reader has to be able to tell this apart from the quality
 * gates it arrives next to, because the two have completely different exits
 * (a quality gate is satisfied by working; a station is a contract only the
 * USER can move — see {@link STATION_SHIP_NEXT_STEPS}).
 */
export function stationShipProblem(station: DeliveryStation, kind: ShipCommandKind): string {
  return `\`${SHIP_KIND_COMMANDS[kind]}\` 超出本轮交付站点 ${station}（${describeDeliveryStation(station)}）——` +
    `该站点放行的 ship 命令：${describeAllowedShipKinds(station)}`;
}

/**
 * The self-rescuing tail a station block carries.
 *
 * The ship gate's usual next step ("run the review loop") is WRONG here and
 * would send the reader in circles: a station is not unmet quality, it is the
 * agreed end of the round. So this states the only two legitimate ways the
 * round can be allowed to travel further, both of which end at the user.
 *
 * It deliberately offers NO appeal route: the gate's arbiter only hears a
 * lone `gh pr edit` (lib/arbitration.ts), so pointing a blocked
 * commit/push/pr-create at it would be a dead end that also burns one of the
 * session's three appeals.
 */
export const STATION_SHIP_NEXT_STEPS =
  "交付站点是本轮的**契约**，不是没跑完的质量门禁 —— 再跑一轮审查不会解开它。要走得更远，只有两条合法路径：\n" +
  "  - loop 会话：请用户重新 `propose_restatement`（选一个更远的站点），再据此重谈 `propose_loop_goal`；\n" +
  "  - 编排：项目经理把 plan 的 `deliveryStation` 提到该站点，请用户重新批准，子会话再重谈自己的 goal。";

// ---------------------------------------------------------------------------
// declare_done's side: did this round actually ARRIVE at its station?
// ---------------------------------------------------------------------------

/**
 * The local, gate-observed facts ONE REPO's arrival is judged on.
 *
 * Per repo, because a station is per contract and a session may hold an
 * approved goal in more than one repo. The caller owns the labelling — a
 * multi-repo `declare_done` prefixes the lines it gets back, and printing the
 * repo twice was the round-2 Nit that made this shape explicit.
 */
export interface StationArrivalFacts {
  /**
   * Does this repo still hold uncommitted work? A worktree that could not be
   * READ counts as dirty — unverifiable is not clean.
   */
  dirty: boolean;
  /**
   * Did the gate WATCH a `gh pr create` succeed in this repo?
   *
   * This is the evidence a `pr` round arrived, and it is the gate's OWN
   * observation: the ship kind is read off a bash `tool_result` that did not
   * fail (`GateState.shippedKinds`), never off a parameter the agent could
   * set. Local, so a completion never fails because GitHub was slow.
   */
  observedPrCreate?: boolean;
  /**
   * The PR number the Copilot cycle resolved (`state.copilot.pr`), when there
   * is one — a SECOND, independent way to prove the same fact, for a PR that
   * was opened outside this session (in the browser, or by an earlier one).
   *
   * It cannot be the only evidence: that number is filled in by
   * `request_copilot_review` / `check_copilot_review` alone, so a repo with no
   * `gh` — or one where `copilotReview.enabled` is false — opens a real PR and
   * would never be able to satisfy an arrival gate that insisted on it
   * (round-1 reviewer P1, 2026-09-06).
   */
  recordedPr?: number | null;
}

/**
 * What still stands between this repo and the station this round promised to
 * reach.
 *
 * Only the two stations that promise something beyond the gate's own checks
 * can produce a problem: `precommit` IS "the checks pass", which
 * `declare_done` already verified before it gets here.
 */
export function stationArrivalProblems(
  station: DeliveryStation,
  facts: StationArrivalFacts,
): string[] {
  if (station === "precommit") return [];
  const problems: string[] = [];
  if (facts.dirty) {
    problems.push(
      `本轮交付站点是 ${station}，但还有未提交的改动 —— ` +
      "提交完再收尾（站点 commit 的承诺就是「提交已经做完」）。",
    );
  }
  const prProven = facts.observedPrCreate === true ||
    (facts.recordedPr !== undefined && facts.recordedPr !== null);
  if (station === "pr" && !prProven) {
    problems.push(
      "本轮交付站点是 pr，但门禁没有看到 PR 被开出来 —— 它认的是**它自己观察到的事实**：" +
      "一条成功跑完的 `gh pr create`（推分支还不算），或者 Copilot 周期已经解析出的 PR 号。\n" +
      "  - 还没开 PR：`git push` 之后跑 `gh pr create`，再收尾。\n" +
      "  - PR 是在别处开的（网页、上一轮会话）：跑一次 `request_copilot_review` 让门禁解析并记下 PR 号；" +
      "项目关掉了 `copilotReview` 时这条走不通，那就重跑一次 `gh pr create`（已存在会直接告诉你），" +
      "或者让用户把本轮站点改回 `commit`。",
    );
  }


  return problems;
}

