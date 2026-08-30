/**
 * FILE-BOUNDARY algebra — the one question "can these two tasks run at the
 * same time?" reduces to.
 *
 * WHY IT IS ITS OWN MODULE. Two orchestration constraints hang off this and
 * nothing else: every task must DECLARE the files it may touch (constraint 5),
 * and two tasks whose declarations overlap may never run in parallel
 * (constraint 6 — they are silently downgraded to serial rather than refused,
 * because the plan is still correct, just not parallelizable). A third caller
 * uses the same predicate for a different question: when the orchestrator
 * approves a child's loop goal on the user's behalf, that goal must stay
 * inside the task's declared boundary (constraint 8).
 *
 * The comparison is deliberately PATH-PREFIX, not glob matching:
 *
 *  - `lib/` covers `lib/a.ts`, and `lib/a.ts` is covered by `lib/` — either
 *    direction is an overlap, because either task could write the same byte;
 *  - `lib/` does NOT cover `library/x.ts`: the check is segment-aware, so a
 *    shared string prefix is not a shared directory;
 *  - a trailing `/**` or `/*` is stripped to its directory, so the boundaries
 *    people naturally write behave the way they read.
 *
 * Fail-closed everywhere: an unparseable or suspicious boundary (absolute
 * path, `..` escape, empty string) is REJECTED at declaration time rather
 * than silently normalized into something that covers less than it looks.
 * A boundary that cannot be understood must never be the reason two writers
 * were allowed into the same file.
 *
 * Pure string module: no filesystem, no git, no process.
 */

/** Why a boundary declaration was refused. */
export interface BoundaryProblem {
  boundary: string;
  reason: string;
}

/** The repo-root-relative, normalized form a boundary is compared in. */
export type NormalizedBoundary = string;

/**
 * Normalize ONE declared boundary, or explain why it cannot be used.
 *
 * Accepted: repo-relative paths and directory prefixes, with or without a
 * trailing slash, optionally ending in `/*` or `/**`.
 * Rejected: absolute paths, `..` segments, empty/whitespace, and any `*`
 * that is not the whole final segment (a mid-segment glob would make the
 * prefix comparison below unsound — `lib/*.ts` looks narrower than `lib/`
 * but our algebra cannot express that, so we refuse instead of pretending).
 */
export function normalizeBoundary(raw: string): { ok: true; value: NormalizedBoundary } | { ok: false; reason: string } {
  const trimmed = String(raw ?? "").trim();
  if (trimmed.length === 0) return { ok: false, reason: "空边界" };
  if (trimmed.startsWith("/")) return { ok: false, reason: "必须是仓库相对路径，不能以 / 开头" };
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return { ok: false, reason: "必须是仓库相对路径，不能是绝对路径" };

  // Unify separators, drop a leading "./", collapse repeated slashes.
  let value = trimmed.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  // A trailing whole-segment glob means "this directory": strip it.
  value = value.replace(/\/\*\*?$/, "");
  // Drop a trailing slash so `lib` and `lib/` compare equal.
  while (value.endsWith("/")) value = value.slice(0, -1);
  if (value.length === 0 || value === ".") {
    // The whole repo. Legal, but it must be explicit — an empty string is not.
    return { ok: true, value: "." };
  }

  const segments = value.split("/");
  if (segments.some((s) => s === "..")) return { ok: false, reason: "不能包含 .. 段" };
  if (segments.some((s) => s.length === 0)) return { ok: false, reason: "路径里有空段" };
  if (segments.some((s) => s.includes("*"))) {
    return {
      ok: false,
      reason: "只支持目录前缀边界（如 lib/ 或 lib/foo.ts）；段内通配（如 lib/*.ts）无法安全比对，请改写成目录",
    };
  }
  return { ok: true, value };
}

/** Normalize a whole declaration, collecting every problem rather than the first. */
export function normalizeBoundaries(raw: readonly string[]): {
  boundaries: NormalizedBoundary[];
  problems: BoundaryProblem[];
} {
  const boundaries: NormalizedBoundary[] = [];
  const problems: BoundaryProblem[] = [];
  for (const entry of raw) {
    const result = normalizeBoundary(entry);
    if (result.ok) {
      if (!boundaries.includes(result.value)) boundaries.push(result.value);
    } else {
      problems.push({ boundary: String(entry), reason: result.reason });
    }
  }
  return { boundaries, problems };
}

/**
 * Does `outer` cover `inner`? Segment-aware prefix containment, with "." as
 * the whole repo.
 */
export function boundaryCovers(outer: NormalizedBoundary, inner: NormalizedBoundary): boolean {
  if (outer === ".") return true;
  if (inner === ".") return false;
  if (outer === inner) return true;
  return inner.startsWith(outer + "/");
}

/**
 * Two boundaries CONFLICT when either covers the other — that is exactly the
 * condition under which two writers could reach the same file.
 */
export function boundariesConflict(a: NormalizedBoundary, b: NormalizedBoundary): boolean {
  return boundaryCovers(a, b) || boundaryCovers(b, a);
}

/** The concrete overlaps between two declarations (empty ⇒ safe to parallelize). */
export function overlappingBoundaries(
  a: readonly NormalizedBoundary[],
  b: readonly NormalizedBoundary[],
): Array<{ a: NormalizedBoundary; b: NormalizedBoundary }> {
  const hits: Array<{ a: NormalizedBoundary; b: NormalizedBoundary }> = [];
  for (const x of a) {
    for (const y of b) {
      if (boundariesConflict(x, y)) hits.push({ a: x, b: y });
    }
  }
  return hits;
}

/** Convenience predicate over whole declarations. */
export function declarationsOverlap(
  a: readonly NormalizedBoundary[],
  b: readonly NormalizedBoundary[],
): boolean {
  return overlappingBoundaries(a, b).length > 0;
}

/**
 * Is `path` inside the declared boundary? Used for constraint 8 — the goal
 * an orchestrator approves for a child must not name files outside the task
 * it was spawned for.
 */
export function pathWithinBoundaries(
  path: string,
  boundaries: readonly NormalizedBoundary[],
): boolean {
  const normalized = normalizeBoundary(path);
  if (!normalized.ok) return false;
  return boundaries.some((b) => boundaryCovers(b, normalized.value));
}

/** The paths that fall OUTSIDE the declaration (empty ⇒ the text stays in scope). */
export function pathsOutsideBoundaries(
  paths: readonly string[],
  boundaries: readonly NormalizedBoundary[],
): string[] {
  return paths.filter((p) => !pathWithinBoundaries(p, boundaries));
}
