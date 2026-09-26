/**
 * TRACKING EDITS — the `tool_result` half of an edit/write call: a landed edit
 * arms THAT file's repo (primary or other), records the path as this session's
 * own work and invalidates what it made stale; a failed one opens the
 * edit-discipline window. Moved out of `extensions/review-gate.ts` (t8, 2026-09-26, wave 4).
 * The dispatch that calls it is lib/tool-event-hooks.ts.
 */

import { dirname as pathDirname, join as pathJoin } from "node:path";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { coalesceToolPath, isCodeFile, isDocFile, isSensitiveFile } from "./constants.ts";
import { EDIT_FAILURE_NUDGE } from "./edit-discipline.ts";
import { classifyEditRepoScope } from "./edit-repo-scope.ts";
import { isGateOwnedPath } from "./fingerprint.ts";
import type { GateState } from "./gate-state.ts";
import { invalidateBindings } from "./gate-state-transitions.ts";
import { nearestExistingDir } from "./loop-goal-host.ts";
import { isSensitiveOutsideRepoPath } from "./out-of-repo-paths.ts";
import { evaluateReadonlyStall } from "./readonly-stall.ts";
import { gitRootOfDir } from "./repo-resolve.ts";
import { consumeGrant, normalizeSensitivePath } from "./sensitive-grant.ts";
import { armLoop, clearBypassToken, type SessionCells } from "./session-cells.ts";

/** What a tool_result handler may hand back to replace the result. */
export type ToolResultPatch = { content: ToolResultEvent["content"]; isError: boolean } | undefined;

export interface EditTrackingDeps {
  stateForRepo(root: string): GateState;
  persist(ctx?: ExtensionContext): void;
  persistRepo(ctx: ExtensionContext, root: string): void;
  repoRelative(p: string): string;
  log(text: string): void;
}

export function createEditTracking(cells: SessionCells, deps: EditTrackingDeps) {
  return function onEditResult(event: ToolResultEvent, ctx: ExtensionContext): ToolResultPatch {
    const state = cells.state;
    const cwd = cells.cwd;
    const primaryRepoRoot = cells.primaryRepoRoot;
    if (event.isError) {
      // Edit-discipline nudge (prompt-only, non-blocking): a failed edit is
      // the classic trigger for the "shell edits the file instead"
      // workaround. Append guidance to THIS result and arm the bash window;
      // it closes only on a successful edit or after one nudge (2026-09-08,
      // cross-turn persistence). Failure semantics stay untouched.
      // Skipped in normal mode: the step-aside must not add extension text.
      if (state.taskMode === "normal") return undefined;
      cells.editFailurePending = true;
      return {
        content: [...(event.content ?? []), { type: "text", text: EDIT_FAILURE_NUDGE }],
        isError: true,
      };
    }
    cells.editFailurePending = false;
    // A landed edit IS production: the drill counter starts over (the guard
    // exists to catch sessions that read but never write).
    cells.readonlyStallState = evaluateReadonlyStall({
      previous: cells.readonlyStallState,
      produced: true,
      read: false,
    }).state;
    const path = coalesceToolPath(event.input as Record<string, unknown>);
    if (!path) return undefined;

    // The edit LANDED, so burn any one-shot sensitive-file authorization for
    // this path. Consuming here rather than at tool_call is what makes a
    // failed edit retryable without a second dialog. Normalized on both sides,
    // exactly like the tool_call guard.
    const sensitiveAbs = normalizeSensitivePath(path, cwd);
    if (isSensitiveFile(sensitiveAbs)) {
      const { consumed, remaining } = consumeGrant(
        cells.sensitiveGrants,
        sensitiveAbs,
        Date.now(),
      );
      cells.sensitiveGrants = remaining;
      if (consumed) deps.log(`sensitive-grant consumed for ${consumed.path}`);
    }

    // Normal mode: the extension steps aside completely, and that has to
    // include ARMING — an armed sidecar would still be read by the L3 git
    // hooks, blocking the very commits normal mode promises to let through.
    // The sensitive-file guard above stays: it is a security floor.
    if (state.taskMode === "normal") return undefined;

    // P-multi: an edit OUTSIDE the session repo arms THAT repo's own gate.
    // ANY file's repo joins the set (review round 2 P1, drill F3): since the
    // checkpoint commits this session's OWN new files, a repo holding one of
    // them is a repo the session worked in.
    const absEditPath = path.startsWith("/") ? path : pathJoin(cwd, path);
    // Attribution climbs to the nearest EXISTING ancestor first: `git
    // rev-parse` fails on a directory that does not exist (round-2 reviewer
    // P1). It is also the resolution the L8 goal gate uses, so the two agree.
    const editRepoDir = nearestExistingDir(pathDirname(absEditPath));
    const editRepo = gitRootOfDir(editRepoDir);

    // Gate-owned paths (.pi/, .pi-subagents/) are excluded from the
    // fingerprint AND from changedFiles(), so tracking such an edit would
    // demote READY→PENDING over a file with nothing to review.
    if (isGateOwnedPath(absEditPath, editRepo ?? primaryRepoRoot)) return undefined;
    // WHICH repo this edit belongs to — or none at all. A file outside every
    // repository (the `/tmp/report.md` a child writes its report to) used to
    // fall through to the PRIMARY branch and demote a READY it could not
    // possibly invalidate. lib/edit-repo-scope.ts owns the judgement,
    // including its fail-closed side: only a path resolved CONFIDENTLY outside
    // the root skips tracking.
    const editScope = classifyEditRepoScope({
      absPath: absEditPath,
      primaryRepoRoot,
      editRepo,
      // Where a RESOLVED path really lives, for the one case git could not
      // attribute: a symlink whose own directory is in no repository but
      // whose target is inside one.
      resolveRepoRoot: (file) => gitRootOfDir(nearestExistingDir(pathDirname(file))),
    });
    if (editScope.scope === "outside") {
      // ONE exception: a SENSITIVE path outside the repo stays VISIBLE —
      // `sessionEditedFiles` is the only input lib/out-of-repo-paths.ts has for
      // "did this child write somewhere it had no business writing?" (round-1
      // reviewer P1). Recording is NOT arming.
      if (isSensitiveOutsideRepoPath(absEditPath)) {
        if (!state.sessionEditedFiles) state.sessionEditedFiles = [];
        if (!state.sessionEditedFiles.includes(absEditPath)) {
          state.sessionEditedFiles.push(absEditPath);
          cells.sessionEditedPaths.add(absEditPath);
          deps.persist(ctx);
        }
      }
      return undefined;
    }
    if (editScope.scope === "other-repo") {
      trackOtherRepoEdit(editScope.root, path, absEditPath, ctx);
      return undefined;
    }

    let dirty = false;
    // P-multi: an edit in the PRIMARY repo makes it the active repo again —
    // unconditionally, since an outside path and another repo both returned
    // above (round-1 reviewer P2).
    cells.activeRepoRoot.current = primaryRepoRoot;
    if (isCodeFile(path) && !state.hasCodeChange) { state.hasCodeChange = true; dirty = true; }
    if (isDocFile(path) && !state.hasDocChange) { state.hasDocChange = true; dirty = true; }
    // EVERY PATH THIS SESSION WROTE IS RECORDED, code/doc or not (drill F3,
    // 2026-09-20): the checkpoint commits this session's OWN new files and
    // nothing else, and this list is how it knows which are its own. The
    // ARMING below stays code/doc-only.
    const rel = deps.repoRelative(path);
    cells.sessionEditedPaths.add(rel);
    if (!state.sessionEditedFiles) state.sessionEditedFiles = [];
    if (!state.sessionEditedFiles.includes(rel)) { state.sessionEditedFiles.push(rel); dirty = true; }
    // ANY file of this repo's own project un-finishes the task (2026-09-22).
    if (state.completion) { delete state.completion; dirty = true; }
    if (isCodeFile(path) || isDocFile(path)) {
      // Scope tracking: this file is part of THIS session's own work — it is
      // always IN scope, even under a user-granted scope limit.
      if (state.scopeLimit) {
        if (!state.scopeLimit.sessionFiles.includes(rel)) {
          state.scopeLimit.sessionFiles.push(rel);
        }
        // P1 fix: a session edit RECLAIMS an exempt file — it is now this
        // session's own work, so it must arm the gate again at EVERY
        // exempt-filter site. Without this, a session that edits ONLY
        // pre-existing dirty files would ship its own edits unreviewed.
        const idx = state.scopeLimit.preexistingFiles.indexOf(rel);
        if (idx >= 0) state.scopeLimit.preexistingFiles.splice(idx, 1);
      }
      invalidateBindings(state);
      armLoop(cells);
      // The agent resumed working on its own — a standing question pause
      // (ask_user) is moot; clear it so the loop enforces again.
      if (state.pausedQuestion) delete state.pausedQuestion;
      dirty = true;
      clearBypassToken(cells); // any edit invalidates a standing arbiter bypass
    }
    if (dirty) deps.persist(ctx);
    return undefined;
  };

  function trackOtherRepoEdit(otherRepo: string, path: string, absEditPath: string, ctx: ExtensionContext): void {
    const state = cells.state;
    const isProjectFile = isCodeFile(path) || isDocFile(path);
    const isNewRepo = !cells.sessionRepos.has(otherRepo);
    // THE REPO SET FOLLOWS THE RECORDING (review round 2 P1). The ACTIVE repo
    // still follows PROJECT files alone — a scratch path must not retarget
    // verdict recording.
    cells.sessionRepos.add(otherRepo);
    if (isProjectFile) {
      cells.activeRepoRoot.current = otherRepo;
    }
    const s = deps.stateForRepo(otherRepo);
    let dirty = false;
    if (isCodeFile(path) && !s.hasCodeChange) { s.hasCodeChange = true; dirty = true; }
    if (isDocFile(path) && !s.hasDocChange) { s.hasDocChange = true; dirty = true; }
    // EVERY path this session wrote is recorded, code/doc or not (review
    // round 1 P1, drill F3) — root-relative, the form git answers in.
    const rel = absEditPath.startsWith(otherRepo + "/")
      ? absEditPath.slice(otherRepo.length + 1)
      : absEditPath;
    if (!s.sessionEditedFiles) s.sessionEditedFiles = [];
    if (!s.sessionEditedFiles.includes(rel)) { s.sessionEditedFiles.push(rel); dirty = true; }
    // A NEW EDIT UN-FINISHES THE TASK — for EVERY file (2026-09-22) — and the
    // SESSION'S RECORD LIVES ON THE PRIMARY STATE (quality round P1): clearing
    // a per-repo record instead left the SESSION looking finished while this
    // repo's bindings had just been invalidated.
    let sessionUnfinished = false;
    if (state.completion) { delete state.completion; sessionUnfinished = true; }
    if (isProjectFile) {
      invalidateBindings(s);
      armLoop(cells);
      if (s.pausedQuestion) delete s.pausedQuestion;
      dirty = true;
      clearBypassToken(cells); // any edit invalidates a standing arbiter bypass
    }
    if (dirty) {
      deps.persistRepo(ctx, otherRepo);
      // P-multi (round-2 P2): the FIRST cross-repo edit grows the repo set —
      // record it in the PRIMARY sidecar NOW so a crash before the next
      // primary persist cannot drop this repo from the resumed declare_done set.
      if (isNewRepo) deps.persist(ctx);
    }
    // The session's own completion lived on the PRIMARY state, so its deletion
    // has to reach that sidecar even when this repo's own state was clean.
    if (sessionUnfinished) deps.persist(ctx);
  }
}
