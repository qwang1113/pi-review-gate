/**
 * MY OWN TMUX SESSION — the name, the lazy creation, the ownership, the death.
 *
 * ── WHAT THIS IS (2026-09-25, user decision) ──
 *
 * Every session the gate runs in used to open its children by splitting its own
 * window, so a judge, a worker or a project manager's child landed as a pane
 * next to whatever the human was doing. Now the opener keeps its pane and the
 * children live as WINDOWS of one session that belongs to it alone:
 *
 *     rg-pi-review-gate-a270ed              ← created on the FIRST child, never before
 *     ├─ @0  reviewer@self    (a judge window)
 *     ├─ @1  probe@self       (a worker window)
 *     └─ @2  t3@pm            (a child session's window)
 *
 * The opener's own window is not touched at all: no split, no resize, no new
 * pane — nothing the gate does may move the user's screen.
 *
 * ── THE THREE THINGS THIS MODULE OWNS ──
 *
 * 1. THE NAME. `rg-<repo slug>-<id fragment>`, derived from the session's own
 *    identity and nothing a caller passes in. The fragment is the TAIL of the
 *    session id, not its head, and that is not cosmetic: pi's ids are UUIDv7,
 *    whose leading bits are a MILLISECOND TIMESTAMP — every session started
 *    within the same ~65 seconds shares its first eight characters (measured
 *    from the ids on this machine), so a head-based name would collide exactly
 *    among the sessions most likely to run at once. The tail is the random
 *    part.
 * 2. THE LAZY CREATION. Nothing is created until a child is actually needed
 *    (`openScopeWindow`), and the child's own command is the session's first
 *    window, so there is never a stray shell window to clean up. A round with
 *    no children creates no session at all.
 * 3. THE DEATH, `closeOwnSession`: the one session this process created, and
 *    only when the sidecar's record CONFIRMS it is ours (see below). There is no
 *    parameter to pass a name in.
 *
 * ── WHY "MINE" IS A FACT AND NOT A GUESS ──
 *
 * THE NAME IS ALWAYS DERIVED FROM THIS SESSION'S OWN IDENTITY (2026-09-25,
 * reviewer P1): `rg-<repo slug>-<session id tail>`. The sidecar record is a
 * FACT, never a source of names — it says "this session created that one" — and
 * it is acted on only when it matches the derivation field by field (the name
 * this session would derive, owned by this session's own id). Anything else is
 * inert: a hand-edited or foreign record can therefore neither widen the
 * executor's declaration nor aim a kill at another session, while a record the
 * gate itself wrote is honoured as before.
 *
 * AND THE NAME LOOKING LIKE OURS IS NOT ENOUGH EITHER: a leftover from a run
 * that died between creating the session and recording it, or two sessions
 * whose id tails collide, both wear a name this module would derive. So the
 * session itself carries a marker (`@rg_scope_owner`, a tmux session user
 * option) written once at creation, and every reuse AND the kill compare it with
 * the owner this process derives for itself. A mismatch is refused — never
 * inherited, never killed — and the refusal names both owners so a human can
 * settle it.
 *
 * Failure direction throughout: an unreadable tmux (`list-sessions` failed) is
 * "I do not know", and nothing is created or killed on an unknown.
 *
 * Pure-ish: tmux enters through {@link ScopeRunner} and the sidecar through
 * {@link TmuxScope}, so every branch runs with fakes.
 */

import {
  buildKillSessionArgv,
  buildListSessionEnvArgv,
  buildListSessionsArgv,
  buildNewSessionArgv,
  buildNewWindowArgv,
  buildReadSessionOwnerArgv,
  buildSetSessionOwnerArgv,
  buildUnsetSessionEnvArgv,
  isOwnSessionName,
  parseSessionNames,
  parseSpawnedWindow,
  SESSION_OWNER_OPTION,
  type SessionWindowCoords,
} from "./orchestrator-tmux.ts";

/** One tmux invocation through the injected runner. */
export interface ScopeRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run one tmux argv; never a shell string. */
export type ScopeRunner = (argv: readonly string[]) => ScopeRunResult;

/**
 * What the sidecar remembers about the session this process created.
 *
 * All three fields are needed to kill safely later: `name` is the target,
 * `owner` is what the marker must say, and `createdAt` is for the human reading
 * the sidecar.
 */
export interface TmuxScopeRecord {
  name: string;
  owner: string;
  createdAt: string;
}

/**
 * Everything this module needs from the running session — the identity it
 * derives a name from, and the sidecar it records into.
 *
 * The extension builds one of these from its own state; nothing here reads
 * `process.env` or a file, which is what lets the whole flow run against a
 * throwaway tmux server in a test.
 */
export interface TmuxScope {
  /** This session's own pi session id — absent ⇒ no name can be derived. */
  sessionId(): string | undefined;
  /** The directory the name's repo slug comes from (the session's own repo). */
  repoRoot(): string;
  /** The record persisted for THIS session, parsed fail-closed. */
  read(): TmuxScopeRecord | undefined;
  /** Persist it — called only when the session was really created. */
  write(record: TmuxScopeRecord): void;
  /** One timestamp, so the record's shape is testable. */
  now(): string;
}

/**
 * `rg-<repo slug>-<session id tail>`, or undefined when the id carries too
 * little entropy to name anything after.
 *
 * The slug is the repo directory's basename, lowercased and stripped to
 * `[a-z0-9-]`: tmux session names may not contain `:` or `.` (the two
 * characters tmux itself uses to address windows and panes — a name carrying
 * one would make every later target ambiguous), and the rest of the class is
 * what {@link isOwnSessionName} validates before any argv is built.
 */
export function deriveSessionName(dir: string, sessionId: string): string | undefined {
  const slug = String(dir ?? "")
    .replace(/\/+$/, "")
    .split("/")
    .pop() ?? "";
  const clean = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  const frag = String(sessionId ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(-10);
  // Ten characters of the id's random end: enough that two sessions in one
  // repo cannot land on the same name, short enough to read in `tmux ls`.
  if (frag.length < 6) return undefined;
  return `rg-${clean || "repo"}-${frag}`;
}

/** The record as it must be before it is trusted: fail-closed on any doubt. */
export function sanitizeScopeRecord(raw: unknown): TmuxScopeRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name : "";
  const owner = typeof value.owner === "string" ? value.owner.trim() : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt.trim() : "";
  if (!isOwnSessionName(name) || owner.length === 0 || createdAt.length === 0) return undefined;
  return { name, owner, createdAt };
}

/** Every session on the server, or undefined when tmux could not be read. */
function listSessions(run: ScopeRunner): string[] | undefined {
  try {
    const result = run(buildListSessionsArgv());
    if (!result.ok) return undefined;
    return parseSessionNames(result.stdout);
  } catch {
    return undefined;
  }
}

/**
 * What the marker on a session says. An unset option prints nothing and exits
 * 0, so an empty reading is a real answer ("nobody claimed it") while a failed
 * call is not.
 */
function readOwner(run: ScopeRunner, session: string): { ok: true; owner: string } | { ok: false; error: string } {
  try {
    const result = run(buildReadSessionOwnerArgv(session));
    if (!result.ok) return { ok: false, error: result.stderr || `tmux show-options ${SESSION_OWNER_OPTION} 失败` };
    return { ok: true, owner: result.stdout.trim() };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * THE GATE'S OWN VARIABLES DO NOT SURVIVE IN A SESSION'S ENVIRONMENT.
 *
 * WHY THIS EXISTS AT ALL (quality round P1, 2026-09-25): passing a child's
 * environment THROUGH tmux (`-e`) let the FIRST child write its identity into
 * the session's own environment, and every window opened later in that session
 * inherited it — a judge opened after a worker came up wearing `RG_WORKER_ID`
 * and reported its state into the WORKER's channel, so its opener's boot
 * verification timed out and the round could never complete.
 *
 * `lib/orchestrator-tmux.ts` no longer uses `-e` at all (`envCommand`), but a
 * session created by the OLD build still carries those variables, and a session
 * lives until its last window closes. So a session that is about to be REUSED is
 * cleaned first: every `RG_`-prefixed variable in its environment is removed —
 * that is the gate's own namespace, and the cleaning only ever touches the
 * session this process created.
 *
 * FAIL CLOSED, and that is the other half of the P1: a child that would inherit
 * somebody else's identity is worse than a refused spawn — it reports into the
 * wrong channel and the opener waits for a round that can never arrive. So a
 * removal tmux refuses REFUSES the spawn, naming what could not be cleared.
 * Nothing to clear is the common case and costs one read.
 */
export function healSessionEnv(
  run: ScopeRunner,
  session: string,
): { ok: true; cleared: string[] } | { ok: false; error: string } {
  let listed: ScopeRunResult;
  try {
    listed = run(buildListSessionEnvArgv(session));
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (!listed.ok) {
    return { ok: false, error: `读不到 ${session} 的 session 环境：${listed.stderr || "tmux 拒绝"}` };
  }
  const stale = listed.stdout
    .split("\n")
    .map((line) => {
      const at = line.indexOf("=");
      return (at < 0 ? line : line.slice(0, at)).trim();
    })
    .filter((key) => key.startsWith("RG_"));
  const cleared: string[] = [];
  for (const key of stale) {
    let unset: ScopeRunResult;
    try {
      unset = run(buildUnsetSessionEnvArgv(session, key));
    } catch (error) {
      return { ok: false, error: `${session} 的 session 环境里有 ${key}（旧版门禁留下的），清除失败：${(error as Error).message}` };
    }
    if (!unset.ok) {
      return {
        ok: false,
        error: `${session} 的 session 环境里有 ${key}（旧版门禁留下的），tmux 拒绝清除：${unset.stderr || "未知原因"}`,
      };
    }
    cleared.push(key);
  }
  return { ok: true, cleared };
}

/** Which session a call is about, and who owns it. */
type ResolvedScope =
  | { ok: true; name: string; owner: string }
  | { ok: false; error: string };

/**
 * Resolve the session this process owns — and BIND it to this process's own
 * identity (2026-09-25, reviewer P1).
 *
 * A record in the sidecar is NOT permission. Its only job is to remember the name
 * this session created, and that name is DERIVED from the session's own id and
 * its repo — so a record is honoured only when it says exactly what this session
 * would derive for itself, with this session as its owner. Anything else is
 * ignored, and the name is re-derived from our own identity instead.
 *
 * WHAT THAT CLOSES: the first version returned the record as-is, so a sidecar
 * naming ANOTHER gate session (paired with that session's marker) made
 * `closeOwnSession` kill it and put its name into `addressableSessions` — a
 * writable file could authorise a kill. A record can no longer widen anything: at
 * most it can confirm the name this process already had.
 *
 * An unusable record is NOT an error: naming our own session needs no record, and
 * a leftover from another session is simply not ours to use.
 */
function resolveScope(scope: TmuxScope): ResolvedScope {
  const sessionId = scope.sessionId()?.trim();
  if (sessionId === undefined || sessionId.length === 0) {
    return { ok: false, error: "本会话没有 session id（pi 没给出），无法派生专属 tmux session 名" };
  }
  const own = deriveSessionName(scope.repoRoot(), sessionId);
  if (own === undefined) {
    return { ok: false, error: `无法从 session id 派生专属 tmux session 名：${sessionId}` };
  }
  // THE NAME IS DERIVED, ALWAYS (2026-09-25, reviewer P1): the record is not a
  // source of names, so no file can point this process at a session it did not
  // create. What a record CAN do is confirm what we would have derived anyway —
  // and that is exactly what {@link recordedSession} checks before anything acts
  // on it.
  return { ok: true, name: own, owner: sessionId };
}

/**
 * The sidecar record, but ONLY when it is bound to this process's identity:
 * the name this session derives for itself, owned by this session's own id.
 *
 * Anything else is not ours to act on — a hand-edited sidecar naming another
 * gate session (with that session's marker written to match) is the shape a
 * kill would otherwise be aimed by, and a file is not permission. It is not an
 * error either: this session simply has no created session to speak of.
 */
function recordedSession(
  scope: TmuxScope,
  identity: { ok: true; name: string; owner: string },
): TmuxScopeRecord | undefined {
  const recorded = sanitizeScopeRecord(scope.read());
  if (!recorded) return undefined;
  return recorded.name === identity.name && recorded.owner === identity.owner ? recorded : undefined;
}

/**
 * The tmux session name this scope IS — the one derivation, exposed so the
 * EXECUTOR can hold the same line the builders do.
 *
 * The builders pass the name they were given (`ownSession` in
 * {@link ./orchestrator-tmux.ts assertSafeTmuxArgv}), but the runner that
 * actually spawns tmux knows no name of its own: without this, the gate's own
 * `new-session` / `kill-window` could only be checked by their SHAPE there, and
 * "only my own session" would be true of the builders and merely
 * plausible of the executor. With it, the same declaration rides every call.
 *
 * `undefined` when this session has no id to derive a name from — in which case
 * the caller passes no declaration, and the executor refuses the four session
 * commands outright (which is what the gate wants: it cannot own a session it
 * cannot name).
 */
export function ownSessionName(scope: TmuxScope): string | undefined {
  const resolved = resolveScope(scope);
  return resolved.ok ? resolved.name : undefined;
}

/**
 * THE SESSIONS THIS PROCESS MAY ADDRESS — its own, plus every session it holds
 * coordinates for AND CAN PROVE.
 *
 * WHY IT IS NOT JUST "MY OWN NAME" (2026-09-25, quality round P1). A RELAY
 * SUCCESSOR owns the previous seat's work: `callerIdentities()` counts the
 * predecessor's judges as its own, so the successor closes their windows — and
 * those windows live in the PREDECESSOR's session. A declaration of one name
 * made every one of those closes impossible, which is a P1 because those
 * windows are exactly what the successor exists to reclaim (a takeover after a
 * crash has the same shape: the adopted registry's rows carry the previous
 * holder's session).
 *
 * `held` is whatever recorded session names the caller's registries carry
 * (`TmuxSession` in a judge entry, a child row, a worker row) — and A RECORD IS
 * NOT PROOF (2026-09-25, t4 whole-branch review P1). The first version of this
 * function answered with a SHAPE test alone, so any writable registry that
 * mentioned a string shaped like `rg-…` widened the executor's declaration and
 * a `kill-window` could be aimed at another session's window: exactly the
 * "a file is not permission" property `closeOwnSession` had been fixed for,
 * lost one layer up. Membership in a record now only SELECTS a candidate; the
 * tmux session itself has to confirm it. So `verify` reads the
 * `@rg_scope_owner` marker and demands the name be the one THAT owner derives
 * (see {@link createOwnershipProbe}) — an id no file can invent, because the
 * marker lives in tmux and only this gate writes it.
 *
 * `proven` is the one exception, and it is not a loosening: the orphan sweep
 * reads a DEAD session's marker and compares it with that session's own id
 * before it gets here, so those names arrive already verified (see
 * lib/session-orphan-sweep.ts). Membership in a registry is not proof of
 * anything; a marker read is.
 *
 * THE OWN NAME NEEDS NO MARKER: it is DERIVED from this process's own identity,
 * so no file can name it, and `new-session` has to be able to declare the
 * session it is about to create (there is no marker to read yet —
 * {@link openScopeWindow} writes it right after).
 *
 * WHAT THIS STILL ALLOWS, SAID PLAINLY: a tampered record can point at a session
 * that is REAL — another live gate session's `rg-…` name passes, because the
 * name and its marker agree about who built it. Closing that last gap would
 * need a whitelist of session IDS, and the honest ones are not available: after
 * an `orchestrator_attach` the previous holder's full id is gone
 * (`runtime.ownerSessionId` is overwritten by the adopter while only the 10-char
 * name tail survives in the rows), and a whitelist would leave a successor
 * unable to close precisely the windows it exists to reclaim. The record side
 * carries the other half of the answer: `ownJudges()` filters by opener and the
 * worker rows are filtered the same way, so another session's names have to be
 * tampered INTO a file before they can even become candidates.
 */
export function addressableSessions(
  scope: TmuxScope,
  held: Iterable<string | undefined>,
  verify: (name: string) => boolean,
  proven: Iterable<string | undefined> = [],
): string[] {
  const names = new Set<string>();
  const own = ownSessionName(scope);
  if (own !== undefined) names.add(own);
  for (const name of proven) {
    if (isOwnSessionName(name)) names.add(name);
  }
  for (const name of held) {
    if (!isOwnSessionName(name) || names.has(name)) continue;
    if (verify(name)) names.add(name);
  }
  return [...names];
}

/**
 * THE MARKER READER — "is this session really the one its NAME says it is?".
 *
 * The question a registry cannot answer and tmux can. A name is
 * `rg-<slug>-<id tail>`, so a session whose `@rg_scope_owner` marker carries an
 * id that derives THAT name was created by the session the name is about; one
 * whose marker says something else (or says nothing) is somebody else's, and no
 * string in a file can change either fact.
 *
 * WHY THE OWNER IS NOT CHECKED AGAINST "MY LINE" HERE: see
 * {@link addressableSessions} — the full id of a predecessor is not always
 * available, and demanding it would refuse the closes a successor exists to
 * perform. What this DOES close is the P1: the name must have been minted by a
 * real gate session, so a record can no longer invent one.
 *
 * ONE READ PER NAME PER PROCESS: a session's marker is written once, at
 * creation, and never re-pointed (a second session deriving the same name is
 * refused by {@link openScopeWindow}), so the answer cannot change under a
 * running process. A FAILED read is NOT cached — the session may simply not
 * exist yet, and a `new-session` a moment later must still be declarable.
 */
export function createOwnershipProbe(scope: TmuxScope, run: ScopeRunner): (name: string) => boolean {
  const cache = new Map<string, boolean>();
  return (name: string): boolean => {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const marker = readOwner(run, name);
    if (!marker.ok) return false;
    const owner = marker.owner.trim();
    if (owner.length === 0) return false;
    const verdict = deriveSessionName(scope.repoRoot(), owner) === name;
    cache.set(name, verdict);
    return verdict;
  };
}

/** What a child window needs from its opener. */
export interface OpenScopeWindowOptions {
  /** Working directory for the new window (the child's repo or worktree). */
  cwd: string;
  env?: Readonly<Record<string, string>>;
  command?: readonly string[];
  /** Window name — the gate's label, so `tmux ls` says who is who. */
  windowName?: string;
}

export type OpenScopeWindowResult =
  | ({ ok: true; sessionName: string; created: boolean } & SessionWindowCoords)
  | { ok: false; error: string };

/**
 * Open ONE window for a child: the first one creates the session, every later
 * one joins it.
 *
 * The session is created with the child's own command rather than empty and
 * filled afterwards, so the lazy creation costs exactly what the eager one did
 * and leaves nothing behind.
 */
export function openScopeWindow(
  run: ScopeRunner,
  scope: TmuxScope,
  opts: OpenScopeWindowOptions,
): OpenScopeWindowResult {
  const resolved = resolveScope(scope);
  if (!resolved.ok) return resolved;
  const { name, owner } = resolved;
  const sessions = listSessions(run);
  if (sessions === undefined) {
    return { ok: false, error: "读不到 tmux server（list-sessions 失败）——不在此刻建 session" };
  }
  const exists = sessions.includes(name);
  if (exists) {
    const marker = readOwner(run, name);
    if (!marker.ok) {
      return { ok: false, error: `${name} 已存在，但读不到它的归属标记：${marker.error}` };
    }
    if (marker.owner !== owner) {
      return {
        ok: false,
        error:
          `${name} 已存在，但归属标记是 ${marker.owner || "(空)"}，不是本会话（${owner}）建的 —— ` +
          "拒绝复用、拒绝改它；确认它的归属后人工处理（`tmux kill-session -t " + name + "`）",
      };
    }
  }
  // A SESSION ABOUT TO BE REUSED IS CLEANED FIRST (healSessionEnv): a session
  // an earlier build polluted carries its first child's identity in its own
  // environment, and THIS child would inherit it — reporting into somebody
  // else's channel while its own stays empty.
  if (exists) {
    const healed = healSessionEnv(run, name);
    if (!healed.ok) return { ok: false, error: healed.error };
  }
  const spec = {
    ownSession: name,
    cwd: opts.cwd,
    ...(opts.env === undefined ? {} : { env: opts.env }),
    ...(opts.command === undefined ? {} : { command: opts.command }),
    ...(opts.windowName === undefined ? {} : { windowName: opts.windowName }),
  };
  const argv = exists ? buildNewWindowArgv(spec) : buildNewSessionArgv(spec);
  let result: ScopeRunResult;
  try {
    result = run(argv);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (!result.ok) {
    return { ok: false, error: result.stderr || `tmux ${exists ? "new-window" : "new-session"} 失败` };
  }
  const coords = parseSpawnedWindow(result.stdout);
  if (!coords) {
    return { ok: false, error: "tmux 没有返回新 window/pane id" };
  }
  if (!exists) {
    // THE MARKER IS WRITTEN BEFORE THE RECORD, and a failure to write it UNDOES
    // the creation (2026-09-25, quality round P2). A session without the marker
    // can neither be reused (the next spawn reads an empty owner and refuses)
    // nor killed (`closeOwnSession` refuses a marker that is not ours) — one
    // failed `set` would leave a session that blocks every future child of this
    // session. It is safe to clean up right here because the session is
    // UNAMBIGUOUSLY ours: this call created it a moment ago.
    const marked = ((): ScopeRunResult | { ok: false; stderr: string } => {
      try { return run(buildSetSessionOwnerArgv(name, owner)); } catch (error) { return { ok: false, stderr: (error as Error).message }; }
    })();
    if (!marked.ok) {
      try { run(buildKillSessionArgv(name)); } catch { /* best effort: nothing else can be done about it here */ }
      return {
        ok: false,
        error: `新建的 session ${name} 写归属标记失败（${marked.stderr || "tmux 拒绝"}）—— 已就地回收，未留下无法复用也无法关闭的 session`,
      };
    }
    // The RECORD is best effort: the marker is what makes the name ours, and a
    // record that did not land only costs a re-derivation (same name, same
    // owner, marker matches ⇒ reuse works).
    try { scope.write({ name, owner, createdAt: scope.now() }); } catch { /* see above */ }
  }
  return { ok: true, sessionName: name, created: !exists, ...coords };
}

export type CloseOwnSessionResult =
  | { ok: true; killed: boolean; note: string }
  | { ok: false; error: string };

/**
 * Close the ONE session this process created, with every window still in it.
 *
 * Idempotent and silent when there is nothing to do: never having opened a
 * child means never having created a session, and a session whose last window
 * was closed has already been reclaimed by tmux itself (`kill-window` on the
 * last one destroys the session — measured). Both are normal ends, not errors.
 *
 * The name comes from the SIDECAR
 * ({@link TmuxScope.read}), never from a parameter, and the session is only
 * killed after its marker matched the recorded owner — so a collision or a
 * stranger's session wearing our name is left completely alone.
 */
export function closeOwnSession(run: ScopeRunner, scope: TmuxScope): CloseOwnSessionResult {
  const identity = resolveScope(scope);
  if (!identity.ok) {
    // No identity ⇒ nothing could ever have been created, so there is nothing
    // to close: a no-op, not a failure (closeOwnSession is idempotent by
    // contract, and an unnameable session is indistinguishable from none).
    return { ok: true, killed: false, note: `本会话没有可关的专属 tmux session（${identity.error}）` };
  }
  // ONLY a record bound to this identity is acted on: a name in a file is not a
  // licence to kill a session (reviewer P1, 2026-09-25).
  const record = recordedSession(scope, identity);
  if (!record) {
    return { ok: true, killed: false, note: "本会话没有专属 tmux session（从未派过子会话，或 sidecar 里的记录不属于本会话）" };
  }
  const sessions = listSessions(run);
  if (sessions === undefined) {
    return { ok: false, error: `读不到 tmux server，未能确认专属 session ${record.name} 是否还在` };
  }
  if (!sessions.includes(record.name)) {
    return { ok: true, killed: false, note: `专属 session ${record.name} 已不在（tmux 在它的最后一个 window 关掉时自己回收了）` };
  }
  const marker = readOwner(run, record.name);
  if (!marker.ok) {
    return { ok: false, error: `读不到 ${record.name} 的归属标记：${marker.error}` };
  }
  if (marker.owner !== record.owner) {
    return {
      ok: false,
      error: `${record.name} 的归属标记是 ${marker.owner || "(空)"}，不是本会话（${record.owner}）的 —— 拒绝 kill`,
    };
  }
  try {
    const result = run(buildKillSessionArgv(record.name));
    if (!result.ok) return { ok: false, error: result.stderr || "tmux kill-session 失败" };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  return { ok: true, killed: true, note: `已关掉专属 session ${record.name}` };
}
