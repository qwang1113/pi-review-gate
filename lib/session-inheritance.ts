/**
 * WHAT A SUCCESSOR INHERITS — the environment the gate hands over, and the
 * first thing the successor reads.
 *
 * A session outlives its own context window, so "hand over to a fresh
 * session" is a supported move for every kind of session (2026-09-14, user
 * decision). The handover is the moment everything can be lost, so the whole
 * protocol is built on ONE asymmetry: **the predecessor does not close
 * itself, and the successor does not close it either** — the successor proves
 * it is alive by working, and the GATE closes the predecessor once it has
 * that proof (lib/session-handoff.ts owns what proof means). Nothing about
 * the closing is left to a session's memory.
 *
 * THREE THINGS TRAVEL, and each answers a different failure:
 *
 *  - the HANDOFF DOCUMENT plus, where there is one, the ORCHESTRATION ID —
 *    the peer's own account of where things stand, so every child keeps
 *    reaching the current holder with no restart (lib/orchestration-id.ts);
 *  - the predecessor's TRANSCRIPT path — the RAW record. The handoff document
 *    is a self-report and can omit or flatter; when the plan later goes wrong,
 *    the successor needs the primary source;
 *  - the predecessor's SESSION ID — the takeover proof. The successor runs in
 *    the SAME worktree (that is the point: one orchestration, one checkout),
 *    and the worktree-exclusivity guard refuses a second gate session while
 *    the holder's heartbeat is fresh (lib/session-exclusivity.ts). Carrying
 *    the id lets the successor say "I am that session's heir" and take the
 *    claim over as the handoff it is, even if the predecessor's release lost
 *    a race or its process died mid-handoff.
 *
 * WHAT USED TO BE HERE, AND WHY IT IS GONE (2026-09-14, philosophy three).
 * This module was `lib/orchestrator-relay.ts`, and it also owned the
 * handoff preconditions (a ≥200-character document, an approved plan), the
 * "only the successor may close the predecessor" authorization, and the brief
 * that told the successor to call `orchestrator_close`. All three moved or
 * died with the unified handover: the gate writes the document skeleton
 * itself so a length contract has nothing left to measure, and the closing is
 * the GATE's step now — leaving it to the successor was measured as the
 * failure it is (a successor that never learned it had to close anything left
 * two live sessions behind).
 *
 * Pure module: it decides and it builds an environment record. The extension
 * checks the filesystem and opens the pane.
 */

import { ORCHESTRATION_ID_ENV } from "./orchestration-id.ts";

/** Pane id of the session being replaced (injected into the successor). */
export const PREDECESSOR_PANE_ENV = "RG_HANDOFF_PREDECESSOR_PANE";
/** Path of the handoff document the successor must read first. */
export const HANDOFF_DOC_ENV = "RG_HANDOFF_DOC";
/** Path of the predecessor's transcript — the raw record, for digging. */
export const PREDECESSOR_TRANSCRIPT_ENV = "RG_HANDOFF_PREDECESSOR_TRANSCRIPT";
/** Session id of the session being replaced (the successor's takeover proof). */
export const PREDECESSOR_SESSION_ENV = "RG_HANDOFF_PREDECESSOR_SESSION";
/** Which kind of session handed over — decides the successor's first action. */
export const HANDOFF_KIND_ENV = "RG_HANDOFF_KIND";

/** The session kinds that can hand over. Mirrors lib/session-handoff.ts's union. */
export type InheritedKind = "loop" | "orchestrator" | "child" | "judge";

/** The environment a successor is started with. */
export function successorEnv(opts: {
  kind: InheritedKind;
  predecessorPane: string;
  handoffDoc: string;
  predecessorSessionId?: string;
  predecessorTranscript?: string;
  orchestrationId?: string;
  /** Every other variable the successor needs (mode, state variant, judge identity…). */
  extra?: Readonly<Record<string, string>>;
}): Record<string, string> {
  return {
    [HANDOFF_KIND_ENV]: opts.kind,
    [PREDECESSOR_PANE_ENV]: opts.predecessorPane,
    [HANDOFF_DOC_ENV]: opts.handoffDoc,
    ...(opts.predecessorTranscript ? { [PREDECESSOR_TRANSCRIPT_ENV]: opts.predecessorTranscript } : {}),
    ...(opts.predecessorSessionId ? { [PREDECESSOR_SESSION_ENV]: opts.predecessorSessionId } : {}),
    ...(opts.orchestrationId ? { [ORCHESTRATION_ID_ENV]: opts.orchestrationId } : {}),
    ...(opts.extra ?? {}),
  };
}

/** What a successor session inherited, read back from its own environment. */
export interface Inheritance {
  kind?: InheritedKind;
  predecessorPane?: string;
  handoffDoc?: string;
  predecessorTranscript?: string;
  predecessorSession?: string;
}

function inheritedKind(raw: string): InheritedKind | undefined {
  return raw === "loop" || raw === "orchestrator" || raw === "child" || raw === "judge" ? raw : undefined;
}

export function readInheritance(env: NodeJS.ProcessEnv = process.env): Inheritance {
  const value = (key: string): string | undefined => {
    const raw = env[key]?.trim();
    return raw && raw.length > 0 ? raw : undefined;
  };
  return {
    ...(inheritedKind(value(HANDOFF_KIND_ENV) ?? "") === undefined
      ? {}
      : { kind: inheritedKind(value(HANDOFF_KIND_ENV) ?? "") }),
    ...(value(PREDECESSOR_PANE_ENV) === undefined ? {} : { predecessorPane: value(PREDECESSOR_PANE_ENV) }),
    ...(value(HANDOFF_DOC_ENV) === undefined ? {} : { handoffDoc: value(HANDOFF_DOC_ENV) }),
    ...(value(PREDECESSOR_TRANSCRIPT_ENV) === undefined
      ? {}
      : { predecessorTranscript: value(PREDECESSOR_TRANSCRIPT_ENV) }),
    ...(value(PREDECESSOR_SESSION_ENV) === undefined
      ? {}
      : { predecessorSession: value(PREDECESSOR_SESSION_ENV) }),
  };
}

/**
 * Is THIS process the handoff successor OF THE SESSION THE SIDECAR BELONGS TO?
 *
 * One question, two facts, because either one alone gives the wrong answer:
 *
 *  - the MARKER (`RG_HANDOFF_PREDECESSOR_SESSION`) says the gate opened this
 *    process to replace somebody. A takeover (`orchestrator_attach`) and an
 *    ordinary new session carry no marker, and their behaviour — everything
 *    the predecessor held is reset — stays exactly as it is.
 *  - the sidecar's OWN `sessionId` says WHOSE state is on disk. A marker alone
 *    would inherit whatever a THIRD session wrote into this repo's sidecar
 *    last, and the orchestration approval is permission the user gave to ONE
 *    session: handing it to a session that session never handed over to is
 *    the widening this whole gate exists to prevent.
 *
 * The two are checked HERE, together, so no caller can carry the marker and
 * forget the identity — the caller gets one boolean and nothing to sequence.
 */
export function isHandoffSuccessorOf(
  env: NodeJS.ProcessEnv,
  sidecarSessionId: string | null | undefined,
): boolean {
  const predecessor = readInheritance(env).predecessorSession;
  const owner = (sidecarSessionId ?? "").trim();
  return predecessor !== undefined && owner.length > 0 && predecessor === owner;
}

/**
 * WHOSE STATE IS THIS? — the ONE answer both readers of a repo's sidecar take
 * (quality round P1, 2026-09-16).
 *
 *  - `mine`      — written by THIS session: adopt it as it stands.
 *  - `inherited` — written by the predecessor this session's own handoff
 *                  continued. The user's contracts travel; the predecessor's
 *                  round standings do not.
 *  - `foreign`   — anybody else's: not evidence, and not permission.
 *
 * WHY THIS IS A FUNCTION AND NOT A COMPARISON AT EACH CALL SITE. Two readers
 * used to answer it differently: the repo-state loader adopted a sidecar only
 * for `mine` (and built an empty state otherwise), while the ENFORCEMENT reader
 * returned whatever its cache held — and that cache is filled by the loader for
 * ANY repo this session reads. So whether a repo counted as this session's own
 * depended on who looked first: a cold cache failed a never-recorded repo
 * closed ("no gate state"), a warm one passed it through `unmetRequirements`
 * with nothing unmet — the same repo, two answers, on the path that decides
 * whether work may ship.
 */
export type StateOwnership = "mine" | "inherited" | "foreign";

export function stateOwnership(
  env: NodeJS.ProcessEnv,
  ownSessionId: string | null | undefined,
  sidecarSessionId: string | null | undefined,
): StateOwnership {
  const own = (ownSessionId ?? "").trim();
  const theirs = (sidecarSessionId ?? "").trim();
  if (theirs.length > 0 && theirs === own) return "mine";
  return isHandoffSuccessorOf(env, theirs) ? "inherited" : "foreign";
}

/** The successor's first action, per kind — one sentence, no tool sequencing to remember. */
const FIRST_ACTION: Record<InheritedKind, string> = {
  orchestrator:
    "读完交接文档后立刻 `orchestrator_attach({orchestrationId})` 拿回现场（plan、子会话、待答请求），再继续推进。",
  loop: "读完交接文档后接着它「未完成的工作」继续做，不要重新摸索已经做过的事。",
  child: "读完交接文档后接着它「未完成的工作」继续做，任务边界以交接文档里的任务书为准。",
  judge: "读完交接文档后接着这一轮审查继续做，未定论的部分以文档里写明的进度为准。",
};

/**
 * The first thing a successor should be told, rendered from its inheritance.
 *
 * It says WHO closes the predecessor, because the old brief said the opposite
 * ("由你调 orchestrator_close 关掉它") and that instruction is what produced
 * two live sessions staring at each other: a successor that had no reason to
 * know it was expected to close anything, and a predecessor waiting for a
 * close that was never coming. The gate does it now, and saying so is what
 * frees the successor to spend its first turn on the work.
 */
export function formatInheritanceBrief(inherited: Inheritance, orchestrationId?: string): string {
  if (!inherited.predecessorPane && !inherited.handoffDoc) return "";
  const kind = inherited.kind ?? "loop";
  const lines = [
    "## 你是接任者（门禁完成的会话交接）",
    inherited.handoffDoc ? `- 交接文档：\`${inherited.handoffDoc}\`（**第一件事就是读它**）` : "",
    `- ${FIRST_ACTION[kind]}`,
    orchestrationId ? `- orchestration id：\`${orchestrationId}\`（子会话的通知会直接流向你，无需重启它们）` : "",
    inherited.predecessorTranscript
      ? `- 前任 transcript（原始记录，交接文档是自述、可能有遗漏）：\`${inherited.predecessorTranscript}\`——有疑点时自己去 grep`
      : "",
    inherited.predecessorPane
      ? `- 前任 pane：\`${inherited.predecessorPane}\`。**门禁会在确认你接手后自动关掉它**，你不需要做任何事。`
      : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * The id a successor session runs under: derived from the predecessor, so a
 * chain of handovers is one readable line (`…-h1` → `…-h2` → …).
 *
 * Derived rather than random on purpose. A random id would make the successor
 * unaddressable until it registered itself somewhere, and the one thing a
 * half-finished handover must leave behind is a way to find the session that
 * took over. The `-hN` suffix also keeps a predecessor and its successors
 * distinguishable in a session list, which is what a human debugging a wedged
 * handover needs first.
 *
 * pi accepts arbitrary ids; the cap below keeps the derived id inside the same
 * sane length the judge ids use.
 */
export const MAX_DERIVED_SESSION_ID = 80;

export function successorSessionId(predecessorId: string, generation: number): string {
  const base = (predecessorId ?? "").trim() || "session";
  const stripped = base.replace(/-h\d+$/, "");
  const next = Number.isFinite(generation) && generation > 0 ? Math.floor(generation) : 1;
  const suffix = `-h${next}`;
  return (stripped.slice(0, MAX_DERIVED_SESSION_ID - suffix.length) + suffix).trim();
}

/**
 * How many handovers a session id is already into its chain (0 for a session
 * that has never handed over). Read back from the id itself, so the fact
 * survives a restart with no bookkeeping.
 */
export function handoffGeneration(sessionId: string): number {
  const match = /-h(\d+)$/.exec((sessionId ?? "").trim());
  return match ? Number(match[1]) : 0;
}
