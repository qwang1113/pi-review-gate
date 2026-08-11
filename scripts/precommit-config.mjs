// precommit-config.mjs — project-level precommit step configuration for the
// precommit runner.
//
// Reads `.pi/review-gate.json` (the SAME file lib/project-config.ts parses for
// the extension) and normalizes its `precommit` section for the runner.
// Semantics mirror lib/project-config.ts `parsePrecommitStep` / 
// `parsePrecommitConfig` — keep both sides in sync (tests cover the shared
// shapes; see test/precommit-config.test.ts and test/project-config.test.ts).
//
// Each step normalizes to:
//   undefined                     → default detection (package.json priority table)
//   null                          → explicitly skipped
//   { skip: true }                → explicitly skipped
//   { script: "name" }            → run `<pm> name` (must exist in package.json)
//   { command: "..." }            → raw shell command (works without package.json)
//   { script|command, narrow }    → narrow only meaningful on the fast test lane
//
// Fail-safe: a missing file, unparseable JSON, or an invalid `precommit`
// section NEVER changes the runner's behavior — it falls back to the default
// detection with `source: "default"` and reports `invalid` (diagnostics only).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function parseStep(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") {
    const s = value.trim();
    return s ? { script: s } : undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.skip === true) return { skip: true }; // skip wins over any command
  const out = {};
  if (typeof value.command === "string" && value.command.trim()) out.command = value.command;
  else if (typeof value.script === "string" && value.script.trim()) out.script = value.script;
  if (typeof value.narrow === "boolean") out.narrow = value.narrow;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Load the project's precommit configuration for `repoRoot`.
 *
 * @returns {{ source: "project"|"default", path: string|null, invalid: string|null, steps: object }}
 *   `steps` holds the normalized per-step values (lint/typecheck/build plus a
 *   `test` that is either a step or `{ fast, full }`), keyed only when the
 *   config actually specifies them.
 */
export function readPrecommitConfig(repoRoot) {
  const path = join(repoRoot, ".pi", "review-gate.json");
  if (!existsSync(path)) {
    return { source: "default", path: null, invalid: null, steps: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { source: "default", path, invalid: `unparseable JSON: ${e.message}`, steps: {} };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { source: "default", path, invalid: "config root is not an object", steps: {} };
  }
  const pre = parsed.precommit;
  if (pre === undefined || pre === null) {
    return { source: "default", path, invalid: null, steps: {} };
  }
  if (typeof pre !== "object" || Array.isArray(pre)) {
    return { source: "default", path, invalid: "precommit section is not an object", steps: {} };
  }
  const steps = {};
  for (const key of ["lint", "typecheck", "build"]) {
    const s = parseStep(pre[key]);
    if (s !== undefined) steps[key] = s;
  }
  const test = pre.test;
  if (test !== undefined) {
    const isLanes =
      typeof test === "object" && test !== null && !Array.isArray(test) &&
      (test.fast !== undefined || test.full !== undefined);
    if (isLanes) {
      const lanes = {};
      const fast = parseStep(test.fast);
      const full = parseStep(test.full);
      if (fast !== undefined) lanes.fast = fast;
      if (full !== undefined) lanes.full = full;
      if (Object.keys(lanes).length > 0) steps.test = lanes;
    } else {
      const s = parseStep(test);
      if (s !== undefined) steps.test = s;
    }
  }
  if (Object.keys(steps).length === 0) {
    return { source: "default", path, invalid: "precommit section has no usable steps", steps: {} };
  }
  return { source: "project", path, invalid: null, steps };
}
