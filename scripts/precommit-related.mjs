/**
 * RELATED TESTS FOR `node --test` (2026-09-29, user decision).
 *
 * `node --test` has no dependency graph of its own (jest/vitest do), so the
 * fast lane used to run NO test for it. This derives the related set:
 *
 *   1. the reverse closure of the changed sources over two kinds of edge — a
 *      relative import / require / dynamic import, and a QUOTED basename
 *      (`join(DIR, "scan-test-labels.cjs")`, `readFileSync(join("lib", "x.ts"))`):
 *      the second is how hooks load scripts and how structural tests read
 *      source text instead of importing it;
 *   2. the test files that are IN that closure (a changed test file is);
 *   3. plus every TREE-SCANNING test — one that lists a repo directory
 *      (`readdirSync(join(ROOT, "lib"))`, a test dir): it counts modules or
 *      greps every source, so any source change can move it, and no single
 *      file names it (quality P2, 2026-09-29).
 *   `import type` is not an edge: it has no runtime effect, and typecheck (which
 *   the fast lane always runs) covers what it does affect.
 *   A basename shared by several files links to all of them — more tests, never fewer.
 *
 * It is a heuristic ON PURPOSE: the fast lane only keeps a reviewer from
 * judging a broken tree; the full suite still runs before anything ships. Any
 * change the graph cannot reason about (a config file, a lockfile, a hook) is
 * answered with FULL, never with a guess.
 */

import { existsSync, globSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const SOURCE_RE = /\.(?:[cm]?[jt]sx?)$/;
const DOC_RE = /\.(?:md|mdx)$/;
const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;
// `import type` / `export type … from`: no runtime edge (typecheck owns types).
const TYPE_ONLY_RE = /^\s*(?:import|export)\s+type\b[^;]*?from\s*["'][^"']+["'];?/gm;
const QUOTED_NAME_RE = /["'`]([\w.-]+\.[cm]?[jt]sx?)["'`]/g;
const TREE_SCAN_RE = /\b(?:readdirSync|globSync)\(\s*(?:join\(\s*)?(?:ROOT|root|REPO|LIB|lib|TEST_DIR|AGENTS)\b/;
const RESOLVE_SUFFIXES = ["", ".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"];

/** Every tracked + untracked (not ignored) source file, absolute. */
function repoSources(repoRoot) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
  });
  return out.split("\0").filter((f) => SOURCE_RE.test(f)).map((f) => resolve(repoRoot, f));
}

function resolveSpec(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Referrer sets keyed by the referenced file. */
export function reverseImportGraph(files, read = (f) => readFileSync(f, "utf8")) {
  const byName = new Map();
  for (const f of files) byName.set(basename(f), [...(byName.get(basename(f)) ?? []), f]);
  const referrers = new Map();
  const link = (target, from) => {
    if (target === from) return;
    const set = referrers.get(target) ?? new Set();
    set.add(from);
    referrers.set(target, set);
  };
  for (const file of files) {
    let text;
    try { text = read(file).replace(TYPE_ONLY_RE, ""); } catch { continue; }
    for (const m of text.matchAll(SPEC_RE)) {
      const target = resolveSpec(file, m[1]);
      if (target !== undefined) link(target, file);
    }
    for (const m of text.matchAll(QUOTED_NAME_RE)) {
      for (const target of byName.get(m[1]) ?? []) link(target, file);
    }
  }
  return referrers;
}

/**
 * @param {object} o
 * @param {string} o.repoRoot
 * @param {string} o.cwd              where the test command runs (globs resolve here)
 * @param {string[]} o.changedFiles   ABSOLUTE changed paths
 * @param {string[]} o.testGlobs      the script's own positional patterns
 * @returns {{ full: string } | { files: string[], reason: string }}
 *          `files` are cwd-relative; `full` says why only the full suite will do.
 */
export function relatedNodeTests({ repoRoot, cwd, changedFiles, testGlobs }) {
  if (testGlobs.length === 0) return { full: "the test script names no test files to narrow" };
  const unknown = changedFiles.find((f) => !SOURCE_RE.test(f) && !DOC_RE.test(f));
  if (unknown !== undefined) {
    return { full: `${relative(repoRoot, unknown)} is not a JS/TS source — its effect on the suite cannot be traced` };
  }
  const tests = new Set(testGlobs.flatMap((g) => globSync(g, { cwd })).map((f) => resolve(cwd, f)));
  const changedSources = changedFiles.filter((f) => SOURCE_RE.test(f));
  const referrers = reverseImportGraph(repoSources(repoRoot));

  const closure = new Set(changedSources);
  const queue = [...changedSources];
  while (queue.length > 0) {
    for (const from of referrers.get(queue.pop()) ?? []) {
      if (!closure.has(from)) { closure.add(from); queue.push(from); }
    }
  }
  const scansTree = (t) => { try { return TREE_SCAN_RE.test(readFileSync(t, "utf8")); } catch { return false; } };
  const related = [...tests].filter((t) => closure.has(t) || scansTree(t));
  return {
    files: related.map((f) => relative(cwd, f)).sort(),
    reason: `${related.length} related test file(s) over ${changedSources.length} changed source(s)`,
  };
}
