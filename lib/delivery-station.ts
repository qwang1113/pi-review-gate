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
