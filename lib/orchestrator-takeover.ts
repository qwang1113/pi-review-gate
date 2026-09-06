/**
 * TAKING OVER AN ORCHESTRATION, OR PUTTING ONE DOWN — the two intents a
 * session has when it finds somebody else's plan in the repo.
 *
 * THE SITUATION THIS EXISTS FOR (measured three times, 2026-09-04/05). A
 * project manager's session ends — it crashed, the machine slept, the human
 * closed the window. `.pi/orchestrator-plan.json` stays where it is: it is
 * the user's approved task list, not a scratch file. The next session that
 * tries to become a project manager then found itself in front of a locked
 * door with no key: entering the role was refused *because* the plan was
 * there, and the tools that could have resolved it were only callable from
 * inside the role. The only move left was `rm` — deleting the gate's own
 * state file by hand, which is a straight violation of philosophy one and
 * which three different sessions (the supervisor included) ended up doing.
 *
 * There are exactly TWO honest intents in that moment, and this module is
 * what both of them run on:
 *
 *  - TAKE THE OLD ORCHESTRATION OVER. Its children may still be alive in
 *    their panes, addressed to an orchestration id the new session does not
 *    have. Adopting that id is the whole of "taking over": the channels are
 *    file paths named after it, so a session holding it reaches every child
 *    with nothing restarted. `orchestrator_attach` does this.
 *  - PUT IT DOWN AND START A NEW ONE. The old plan is history; the new
 *    manager wants a clean sheet. `orchestrator_plan({action:"archive"})`
 *    does this — and it ARCHIVES, never deletes.
 *
 * WHERE THE ID COMES FROM, AND WHY NOT FROM THE PLAN (user decision,
 * 2026-09-05). The obvious move — write the orchestration id into the plan
 * file — is refused: the runtime already records it in the gate sidecar, and
 * a second copy of one fact is a second thing that can be stale (philosophy
 * three). So the id is READ from what is already on disk:
 *
 *   1. the sidecar's own orchestration runtime (authoritative when present);
 *   2. failing that, the CHANNEL DIRECTORIES (`~/.pi/agent/rg-channels/`).
 *      This is not a second copy either: a channel directory IS the
 *      orchestration's address, and an id carries the hash of its repo in its
 *      own text, so "which orchestrations belong to this repo" is a question
 *      the ids answer about themselves.
 *
 * Discovery NAMES candidates; it never adopts one. Adoption always requires a
 * caller to pass the id explicitly and to survive {@link decideTakeover} —
 * which is what keeps "a forged id becomes this session's address" impossible
 * while still letting a real takeover happen.
 *
 * Pure module apart from two injected readers: no filesystem, no tmux, no
 * environment. The wiring supplies `channelDirNames` and the archive writer.
 */

import {
  ORCHESTRATION_ID_PREFIX,
  normalizeOrchestrationId,
  orchestrationRepoHash,
} from "./orchestration-id.ts";
import type { ChildSession } from "./orchestrator-registry.ts";
import type { OrchestratorPlan } from "./orchestrator-plan.ts";

/** What the disk says about orchestrations belonging to one repo. */
export interface OrchestrationCandidates {
  /** The id recorded in this repo's gate sidecar, when there is one. */
  recorded?: string;
  /**
   * Every id that belongs to this repo, newest first, the recorded one
   * included. "Newest" is read off the id itself: it ends in a base36 mint
   * timestamp, so ordering needs no file metadata (and no second copy of the
   * fact).
   */
  ids: string[];
}

/** The mint timestamp encoded in an id, or 0 when it cannot be read. */
export function orchestrationStamp(id: string): number {
  const normalized = normalizeOrchestrationId(id);
  if (!normalized) return 0;
  const stamp = normalized.slice(ORCHESTRATION_ID_PREFIX.length).split("-")[1] ?? "";
  const parsed = Number.parseInt(stamp, 36);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Does this id name an orchestration of THIS repo? */
export function belongsToRepo(id: string, repoRoot: string): boolean {
  const normalized = normalizeOrchestrationId(id);
  if (!normalized) return false;
  const hash = normalized.slice(ORCHESTRATION_ID_PREFIX.length).split("-")[0];
  return hash === orchestrationRepoHash(repoRoot);
}

/**
 * Which orchestrations of this repo exist on disk.
 *
 * `channelDirNames` is injected and allowed to throw — an unreadable channel
 * root simply means "nothing discovered", never a failure: discovery informs
 * a refusal message, and a refusal that cannot be printed is worse than a
 * shorter one.
 */
export function discoverOrchestrations(opts: {
  repoRoot: string;
  recorded?: string;
  channelDirNames: () => string[];
}): OrchestrationCandidates {
  const recorded = normalizeOrchestrationId(opts.recorded);
  let names: string[] = [];
  try {
    names = opts.channelDirNames();
  } catch {
    names = [];
  }
  const ids = new Set<string>();
  if (recorded && belongsToRepo(recorded, opts.repoRoot)) ids.add(recorded);
  for (const name of names) {
    const id = normalizeOrchestrationId(name);
    if (id && belongsToRepo(id, opts.repoRoot)) ids.add(id);
  }
  return {
    ...(recorded ? { recorded } : {}),
    ids: [...ids].sort((a, b) => orchestrationStamp(b) - orchestrationStamp(a)),
  };
}

/** Why a takeover was refused, or the id it may adopt. */
export type TakeoverDecision =
  | { ok: true; id: string; source: "recorded" | "channel" }
  | { ok: false; reason: string };

/**
 * May this session adopt `wanted` as its orchestration identity?
 *
 * Four conditions, and each of them exists because of a different accident:
 *
 *  - the id must PARSE — an arbitrary string from a tool argument becomes a
 *    channel directory name, so only something the gate could have minted is
 *    accepted;
 *  - it must belong to THIS repo — adopting another repo's orchestration
 *    would put this session's children on somebody else's channels;
 *  - it must be DISCOVERABLE on disk — the caller naming an id is not
 *    evidence that it exists; without this, a typo would mint a private
 *    address that no child is listening on and every wait would hang;
 *  - this session must not already have children of its OWN. Changing
 *    identity mid-flight is the one thing the old `orchestrator_attach`
 *    refusal was right about: the children registered under the current id
 *    would instantly lose their supervisor.
 */
export function decideTakeover(opts: {
  wanted: unknown;
  repoRoot: string;
  candidates: OrchestrationCandidates;
  /** Children registered under the id this session currently holds. */
  ownChildren: readonly ChildSession[];
  /** The id this session currently holds (for the refusal wording). */
  currentId: string;
}): TakeoverDecision {
  const wanted = normalizeOrchestrationId(opts.wanted);
  if (!wanted) {
    return {
      ok: false,
      reason:
        "orchestrationId 不像一个门禁铸造的编排 id（形如 `orch-<repoHash>-<stamp>`）。" +
        "它写在上一任项目经理的交接文档里，也在每个子会话的 RG_ORCHESTRATION_ID 环境变量里；" +
        "本仓库盘上还有哪些编排，见下面的候选清单。",
    };
  }
  if (!belongsToRepo(wanted, opts.repoRoot)) {
    return {
      ok: false,
      reason:
        `${wanted} 不是本仓库（${opts.repoRoot}）的编排 —— id 里带的 repo 哈希对不上。` +
        "接管别的仓库的编排会把本会话的子会话挂到别人的通道上。",
    };
  }
  const open = opts.ownChildren.filter((child) => !child.closedAt);
  if (open.length > 0) {
    return {
      ok: false,
      reason:
        `本会话已经以 ${opts.currentId} 的身份登记了 ${open.length} 个子会话` +
        `（${open.map((c) => c.id).join("、")}）—— 不能在运行中改换编排身份：` +
        "它们会瞬间失去归属。要接管旧编排，请用一个还没派过活的会话。",
    };
  }
  if (!opts.candidates.ids.includes(wanted)) {
    return {
      ok: false,
      reason:
        `盘上没有 ${wanted} 的任何记录（既不在本仓库的门禁 sidecar 里，也没有对应的通道目录）——` +
        "拒绝凭空采用一个地址：没有子会话在那条通道上听，之后每一次等待都会空等。",
    };
  }
  return { ok: true, id: wanted, source: opts.candidates.recorded === wanted ? "recorded" : "channel" };
}

/**
 * The ROUTE a session gets when it holds no orchestration identity and the
 * repo already has somebody else's plan.
 *
 * This text is the entire fix for "there was no tool for it": the gate does
 * the disk lookup itself and hands back two commands that can be copied as
 * they are. Naming the candidates matters more than it looks — the id lives
 * in a handoff document nobody may still have, and a project manager that
 * cannot name it has, once again, only `rm` left.
 */
export function buildTakeoverRoute(opts: {
  candidates: OrchestrationCandidates;
  /** What the caller was trying to do, named in the first line. */
  attempting: string;
}): string {
  const lines = [
    // STATES NOTHING IT CANNOT KNOW (reviewer P2, 2026-09-06). This line used
    // to assert two facts — "this session inherited no orchestration id" and
    // "this repo already holds somebody else's plan" — that are true of the
    // situation the module was written for and false at several of its call
    // sites (a relay successor that DID inherit one, a repo with no plan at
    // all, a caller who simply mistyped an id). Every caller prints its own
    // specific reason immediately above this text; the route's job is only to
    // say what can be DONE, and the two options below are true regardless.
    `review-gate: ${opts.attempting}需要先把「这一轮编排的身份」定下来。` +
    "下面两条路都由门禁替你做完，**不要手动删 plan 文件**：",
  ];
  if (opts.candidates.ids.length > 0) {
    lines.push("");
    lines.push("A. 接管旧编排（它的子会话可能还活着，接管后仍能寻址）：");
    for (const id of opts.candidates.ids.slice(0, MAX_LISTED_CANDIDATES)) {
      lines.push(`   \`orchestrator_attach({ orchestrationId: "${id}" })\``);
    }
    if (opts.candidates.ids.length > MAX_LISTED_CANDIDATES) {
      lines.push(`   （盘上还有 ${opts.candidates.ids.length - MAX_LISTED_CANDIDATES} 个更早的，已略去）`);
    }
  } else {
    lines.push("");
    lines.push(
      "A. 接管旧编排：**做不到** —— 盘上找不到本仓库任何编排的记录" +
      "（sidecar 里没有，通道目录里也没有），也就没有 id 可以接管。",
    );
  }
  lines.push("");
  lines.push(
    "B. 放弃旧编排、另起一轮：`orchestrator_plan({ action: \"archive\" })` —— " +
    "门禁把 plan 连同编排登记表归档成一个带时间戳的文件（绝不删除），并在动手前问用户一句。",
  );
  return lines.join("\n");
}

/** How many candidate ids a route lists before it stops (the rest are older). */
export const MAX_LISTED_CANDIDATES = 5;

/**
 * The archive file's name.
 *
 * Beside the plan, inside `.pi/` (so it is ignored by git and invisible to
 * the fingerprint), and stamped so two archives never collide. The colons of
 * an ISO timestamp are dropped because this is a file name on disk, not a
 * timestamp anybody parses back.
 */
export function planArchiveRelPath(at: string): string {
  const stamp = at.replace(/[:.]/g, "-").replace(/Z$/, "");
  return `.pi/orchestrator-plan.archived-${stamp}.json`;
}

/**
 * WHAT gets archived: the plan AND the orchestration runtime beside it.
 *
 * Archiving only the plan would leave the runtime in the sidecar, and the
 * next `orchestrator_spawn` would be refused by `runtimeConflict` forever —
 * the session would have "cleaned up" into a state it cannot leave. So both
 * halves move into the archive together, and the caller clears the runtime.
 *
 * BOTH ARE OPTIONAL, and that is not defensive coding: the two halves die
 * separately. A repo can hold a plan whose runtime was never written, and —
 * more commonly — a runtime whose plan was already removed by hand back when
 * `rm` was the only available move. Refusing to archive the surviving half
 * would leave that repo in exactly the dead end this action exists to open.
 */
export function buildPlanArchive(opts: {
  plan?: OrchestratorPlan;
  runtime?: { orchestrationId: string; children: readonly ChildSession[] };
  at: string;
  by: string;
}): string {
  return JSON.stringify(
    {
      archivedAt: opts.at,
      archivedBy: opts.by,
      reason: "放弃旧编排、另起一轮（orchestrator_plan action:archive）",
      ...(opts.runtime
        ? {
            orchestration: {
              orchestrationId: opts.runtime.orchestrationId,
              children: opts.runtime.children,
            },
          }
        : {}),
      ...(opts.plan ? { plan: opts.plan } : {}),
    },
    null,
    2,
  ) + "\n";
}

/** The dialog title the user sees before an archive happens. */
export const ARCHIVE_CONFIRM_TITLE = "review-gate: 归档上一轮编排的 plan？";

/**
 * The dialog body.
 *
 * It has to say the two things a human needs to decide with: what is being
 * put away (the plan they once approved), and that nothing is destroyed.
 */
export function buildArchiveConfirmMessage(opts: {
  plan?: OrchestratorPlan;
  archivePath: string;
  liveChildren: number;
}): string {
  const unfinished = (opts.plan?.tasks ?? []).filter((task) => (task.status ?? "pending") !== "done");
  return [
    opts.plan
      ? `本仓库里有一份 plan：《${opts.plan.title}》，共 ${opts.plan.tasks.length} 个任务，` +
        `其中 ${unfinished.length} 个还没有 done。`
      : "本仓库里没有 plan 文件了，但门禁的记录里还留着上一轮编排的登记表。",
    "",
    "有会话想放弃这一轮编排、另起一轮。门禁会把它连同编排登记表移到：",
    `  ${opts.archivePath}`,
    "**不是删除** —— 文件仍在 `.pi/` 下，随时可以看回来。",
    "",
    opts.liveChildren > 0
      ? `注意：登记表里还有 ${opts.liveChildren} 个子会话没有关闭。`
      : "登记表里没有还开着的子会话。",
    "",
    "要归档吗？（不确定就选否：接管旧编排的路子还在。）",
  ].join("\n");
}
