/**
 * ONE gate session per worktree — who may arm the gate here, and why not.
 *
 * THE PROBLEM. Two pi sessions in one checkout share a single
 * `.pi/review-gate-state.json` and a single set of uncommitted changes. That
 * file is the only thing the git hooks can see, so the two sessions overwrite
 * each other's verdict, each one's edits re-arm the other's gate, and the
 * symptom a human actually meets is "the hook rejects what the gate just
 * approved". The gate used to only WARN about this (a sidecar written by
 * another session id within four hours), and the warning had to be worded
 * conditionally because it could not tell a live session from one that
 * finished an hour ago.
 *
 * THE RULE (2026-09-05, user decision). The second session that would claim
 * the SAME main sidecar is refused outright, fail-closed: it does not arm, and
 * its edits and ship commands are blocked, with a message naming the holder
 * and two concrete ways out. Refusing needs a real liveness signal, which is
 * what `.pi/session-presence.json` is: a heartbeat one live session rewrites.
 *
 * WHO IS EXEMPT, AND WHY IT IS NOT A LIST OF SPECIAL CASES. Exclusivity is
 * over the main sidecar, so the exemption follows from who writes one:
 *
 *  - a JUDGE pane (`RG_JUDGE_*`) writes no gate state at all (lib/judge-side.ts),
 *  - an ORCHESTRATION CHILD (`RG_STATE_VARIANT`) writes its own file,
 *
 * and both of them live in the very same worktree by design — a judge's cwd is
 * the repo it reviews, and a child's cwd is the repo its task declares.
 * Refusing them would kill every review and every orchestration, so the
 * question is never "which roles do we let through" but "does this session
 * claim the shared file".
 *
 * WHY THIS IS NOT THE SAME QUESTION THE OTHER LIVENESS CHECKS ASK
 * (2026-09-06, the "three liveness criteria" convergence review).
 *
 * Several checks in this repository read like "is that thing still alive", and
 * they were suspected of being one rule written several ways. They are not, and
 * this one is the odd one out in the direction that matters most:
 *
 *   - HERE: is a HEARTBEAT still fresh? A single POSITIVE fact decides, and
 *     everything else — a missing file, a corrupt record, a clock that went
 *     backwards, a stamp from the future — is fail-OPEN (`isFresh` and the
 *     block above it). That is the reverse of this project's usual direction
 *     and it is deliberate: being wrong here locks a human out of their own
 *     checkout, so only a heartbeat somebody just wrote may refuse them.
 *   - lib/blocked-marker.ts: is a RECORD ON DISK still somebody's? Fail-CLOSED
 *     in every unknown, because being wrong THERE ships unreviewed code. Its
 *     window is four hours to this module's sixty seconds — a factor of 240,
 *     because a session's lifetime and a 10s heartbeat's tolerance are not the
 *     same quantity.
 *   - lib/judge-pane.ts (`judgePaneAlive`): is a tmux PANE still listed? An
 *     unreadable pane list is missing information, never a dead judge.
 *
 * So the three differ in SUBJECT (a heartbeat, a disk record, a pane), in
 * FAILURE DIRECTION (open, closed, conservative) and in TIME SCALE, and each of
 * those three axes was argued from its own cost. Collapsing them into one rule
 * would have to sacrifice at least two of those arguments — which is why the
 * duplication here is not the kind philosophy three forbids. What philosophy
 * three DID catch was a fourth criterion (pid + process start time, "is that
 * pid still OUR judge"): it had lost its last production caller, and was
 * deleted on 2026-09-06.
 *
 * Pure module: no clock, no filesystem. The caller reads the file, supplies
 * `now`, and writes what `presenceFor` builds.
 */

import { STATE_VARIANT_ENV } from "./gate-state.ts";
import { readJudgeSideEnv } from "./judge-side.ts";

/**
 * One live session's claim on a worktree's gate state.
 *
 * `pid` and `host` are DIAGNOSTIC ONLY — they exist so the refusal can tell a
 * human WHICH session to close, and they take no part in the decision. This is
 * the same call lib/blocked-marker.ts makes, for the same two reasons: a pid is
 * meaningless once a repo is shared across hosts or containers, and pid reuse
 * would report a stranger's process as the holder. Adding `host` to the
 * decision would be worse than useless here — a fresh heartbeat means a
 * session IS live in this worktree, and on an NFS/container mount the one
 * written from another host is exactly the one that must still be refused.
 */
export interface PresenceRecord {
  /** The holder's pi session id. */
  sessionId: string;
  /** Diagnostic only (see above). */
  pid: number;
  /** Diagnostic only (see above). */
  host: string;
  /** ISO heartbeat — the ONLY input to the decision. */
  at: string;
}

/**
 * How long a heartbeat stays trustworthy.
 *
 * The holder rewrites it on a timer far shorter than this, so the window only
 * has to cover a scheduling hiccup, not a work pause. Sized DOWN deliberately:
 * this window is the price a human pays after a crash — the worktree is
 * refused until it lapses — and the cost of it being too long is a locked
 * checkout, while the cost of it being too short is two sessions sharing a
 * sidecar for a few seconds, which is the situation that already existed.
 */
export const PRESENCE_FRESH_MS = 60_000;

/** Heartbeat interval the holder refreshes at — comfortably inside the window. */
export const PRESENCE_HEARTBEAT_MS = 10_000;

/** File name under `.pi/`, beside the sidecar it protects. */
export const PRESENCE_FILENAME = "session-presence.json";

/**
 * Does this session claim the worktree's MAIN gate sidecar?
 *
 * `false` for the two session kinds that share the worktree by design and
 * write elsewhere (a judge writes nothing, an orchestration child writes its
 * own variant file). Everything else — an ordinary loop session, an explore
 * session, a project manager — claims it.
 */
export function claimsMainSidecar(env: NodeJS.ProcessEnv): boolean {
  // Both questions are asked through the modules that OWN them, so "is this a
  // judge" cannot drift from the judge side's own answer, and the variant name
  // is not spelled a second time.
  if (readJudgeSideEnv(env) !== undefined) return false;
  if ((env[STATE_VARIANT_ENV] ?? "").trim()) return false;
  return true;
}

export type ExclusivityVerdict =
  /** Arm normally: not a claimant, no holder, our own claim, or a lapsed one. */
  | { ok: true }
  /** Another session holds this worktree — refuse, fail-closed. */
  | { ok: false; holder: PresenceRecord; reason: string };

export interface ExclusivityInput {
  /** This process's environment — decides whether the session claims the sidecar. */
  env: NodeJS.ProcessEnv;
  /** This session's own id, when it has one. */
  sessionId: string | null | undefined;
  /** The presence record on disk, or undefined when absent/unreadable. */
  existing: PresenceRecord | undefined;
  /** Absolute repo root, for the escape hatch the refusal prints. */
  repoRoot: string;
  now: number;
}

/**
 * May this session arm the gate in this worktree?
 *
 * Every "no answer" leads to `ok: true`. That is the opposite of this
 * project's usual direction and it is deliberate: the thing being decided is
 * whether to REFUSE A SESSION, so an unreadable file, a corrupt record, a
 * missing heartbeat or a clock that makes no sense must never be enough to
 * lock a human out of their own checkout. The one thing that refuses is a
 * positive fact — a heartbeat written moments ago by somebody else.
 */
export function checkSessionExclusivity(input: ExclusivityInput): ExclusivityVerdict {
  if (!claimsMainSidecar(input.env)) return { ok: true };
  const holder = input.existing;
  if (!holder) return { ok: true };
  const self = (input.sessionId ?? "").trim();
  // Our own record, from this session or a same-id restart: taking over our
  // own claim is what a resume IS.
  if (self && holder.sessionId === self) return { ok: true };
  if (!isFresh(holder.at, input.now)) return { ok: true };
  return { ok: false, holder, reason: refusalText(holder, input.repoRoot) };
}

/**
 * Is this heartbeat recent enough to mean "somebody is here"?
 *
 * A timestamp in the FUTURE is a clock anomaly (a skewed container, an NFS
 * mount, a hand-edited file), not evidence of life — and since the only thing
 * this decides is whether to refuse, an anomaly must let the session through.
 * Same for an unparseable value.
 */
function isFresh(at: string, now: number): boolean {
  const t = Date.parse(at ?? "");
  if (!Number.isFinite(t)) return false;
  if (t > now) return false;
  return now - t < PRESENCE_FRESH_MS;
}

/** The refusal: who holds it, and the two ways out. */
function refusalText(holder: PresenceRecord, repoRoot: string): string {
  const name = basename(repoRoot);
  return [
    `review-gate: 这个 worktree 已被另一个会话占用，本会话不启动门禁。`,
    `占用者：session ${holder.sessionId}（pid ${holder.pid} @ ${holder.host}，最后心跳 ${holder.at}）。`,
    `两个会话共用同一份 .pi/review-gate-state.json 与同一份未提交改动——那是 git 钩子唯一能看到的东西，` +
    `互相覆盖的结果就是「钩子拒绝了门禁刚刚批准的东西」。`,
    `出路二选一：`,
    `  1. 各自一个 worktree：git -C ${repoRoot} worktree add ../${name}-2 -b <新分支名>，然后在 ../${name}-2 里开这个会话；`,
    `  2. 关掉占用的那个会话（上面那个 session），本会话在它的心跳超过 ${Math.round(PRESENCE_FRESH_MS / 1000)} 秒未更新后即可正常启动——不需要手工删任何文件。`,
  ].join("\n");
}

/** Last path segment, without pulling node:path into a pure module. */
function basename(p: string): string {
  const parts = (p ?? "").split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : "repo";
}

/** The record a holding session writes on every heartbeat (overwrite, never append). */
export function presenceFor(
  sessionId: string,
  pid: number,
  host: string,
  now: number,
): PresenceRecord {
  return { sessionId, pid, host, at: new Date(now).toISOString() };
}

/**
 * Parse a presence file, fail-open by design (see `checkSessionExclusivity`):
 * anything malformed yields `undefined`, which reads as "no holder".
 */
export function parsePresence(raw: string | undefined): PresenceRecord | undefined {
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== "object" || v === null) return undefined;
    if (typeof v.sessionId !== "string" || v.sessionId.length === 0) return undefined;
    if (typeof v.at !== "string" || v.at.length === 0) return undefined;
    return {
      sessionId: v.sessionId,
      at: v.at,
      pid: typeof v.pid === "number" && Number.isFinite(v.pid) ? v.pid : -1,
      host: typeof v.host === "string" && v.host.length > 0 ? v.host : "unknown",
    };
  } catch {
    return undefined;
  }
}

/**
 * Should the holder's record be cleared on shutdown?
 *
 * Only when it is OURS. A session that was refused never wrote one, and
 * deleting the live holder's record on the way out would hand the worktree to
 * a second session while the first is still working.
 */
export function presenceIsOurs(existing: PresenceRecord | undefined, sessionId: string | null | undefined): boolean {
  const self = (sessionId ?? "").trim();
  return !!existing && !!self && existing.sessionId === self;
}
