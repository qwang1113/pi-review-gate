import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "extensions", "review-gate.ts"), "utf8");

test("extension imports from local lib/ (single source of truth)", () => {
  assert.ok(SRC.includes('./lib/constants.ts'), "should import from ./lib/constants.ts");
  assert.match(SRC, /\bisCodeFile\b/);
  assert.match(SRC, /\bisDocFile\b/);
  assert.match(SRC, /\bcoalesceToolPath\b/);
});

test("extension declares no inline extension alternation", () => {
  for (const line of SRC.split("\n")) {
    const hits = ["tsx", "ipynb", "pyw", "kts", "hpp"].filter((t) => line.includes('"' + t + '"') || line.includes("|" + t + "|")).length;
    assert.ok(hits < 3, `inline extension list suspected:\n${line.trim()}`);
  }
});

test("NotebookEdit is in the edit-tool set", () => {
  assert.match(SRC, /EDIT_TOOL_NAMES.*NotebookEdit/);
});

test("L1: tool_call handler exists and can block", () => {
  assert.match(SRC, /pi\.on\(["']tool_call["']/);
  assert.match(SRC, /block:\s*true/);
  assert.match(SRC, /detectShipCommands/);
});

test("L2: agent_settled auto-continuation with recursion guard", () => {
  assert.match(SRC, /pi\.on\(["']agent_settled["']/);
  assert.match(SRC, /continuationsInjected/);
  assert.match(SRC, /REVIEW_GATE_RESUME/);
});

test("compaction recovery: session_compact re-injects state", () => {
  assert.match(SRC, /pi\.on\(["']session_compact["']/);
  assert.match(SRC, /survived/i);
});

test("state persisted via appendEntry AND sidecar", () => {
  assert.match(SRC, /pi\.appendEntry\(ENTRY_TYPE/);
  assert.match(SRC, /saveSidecar/);
});

test("declare_done validates server-side and rejects on unmet gates", () => {
  assert.match(SRC, /name:\s*["']declare_done["']/);
  assert.match(SRC, /REJECTED/);
  assert.match(SRC, /isError:\s*true/);
});

test("record_review parses full output through verdict-parse", () => {
  assert.match(SRC, /name:\s*["']record_review["']/);
  assert.match(SRC, /parseReviewOutput/);
});

test("L5: commit & PR title/body must be English (blocks non-Latin scripts)", () => {
  // commit messages AND gh pr create title/body are language-checked.
  assert.match(SRC, /firstNonEnglish/);
  assert.match(SRC, /extractPrTextFields/);
  assert.match(SRC, /must be English/);
  // Applied to both ship kinds.
  assert.match(SRC, /s\.kind === "pr-create"/);
});

test("commands registered: gate-status, gate-bypass, gate-reset", () => {
  for (const cmd of ["gate-status", "gate-bypass", "gate-reset"]) {
    assert.match(SRC, new RegExp(`registerCommand\\(["']${cmd}["']`), cmd);
  }
});

test("precommit PASS is granted ONLY by the run_precommit tool (trusted spawn + nonce receipt)", () => {
  // Root-cause fix: bash stdout can never grant a PASS. The single authority is
  // the run_precommit tool, which spawns the trusted runner and verifies a
  // private nonce receipt.
  assert.match(SRC, /name:\s*["']run_precommit["']/);
  assert.match(SRC, /runTrustedPrecommit/);
  assert.match(SRC, /resolveTrustedRunner/);
  // Receipt protocol validation lives in lib/precommit-receipt.ts (pure).
  assert.match(SRC, /validatePrecommitReceipt/);
  const PR = readFileSync(join(ROOT, "lib", "precommit-receipt.ts"), "utf8");
  assert.match(PR, /receipt nonce mismatch/);
  // The old forgeable path (grant PASS from parsed stdout) must be gone: stdout
  // may only INVALIDATE a prior PASS, never set one.
  assert.doesNotMatch(SRC, /verdict === "PASS" && !event\.isError/);
});

test("run_precommit spawns with argv, never shell:true", () => {
  assert.match(SRC, /spawnSync\(/);
  assert.match(SRC, /shell:\s*false/);
  assert.doesNotMatch(SRC, /shell:\s*true/);
});

test("stale-state reconciliation is one-way", () => {
  assert.match(SRC, /git-clean can clear.*only edits/i);
});

test("sensitive-file guard wired into tool_call", () => {
  assert.match(SRC, /isSensitiveFile/);
});

test("no network fetch anywhere in the extension", () => {
  // The extension has "npx" in regex patterns (anti-forgery detection),
  // and import("node:child_process") — both are fine. Only block actual network calls.
  assert.doesNotMatch(SRC, /\bfetch\b/);
  assert.doesNotMatch(SRC, /import\("https?:/);
  // "npx" inside regex patterns is OK; "npx " (command invocation) is not.
  assert.doesNotMatch(SRC, /['"]npx\s/);
});

test("P0-2: branch commit detection via commitsAheadOfBase", () => {
  assert.match(SRC, /commitsAheadOfBase/);
});

test("P0-5: detectShipCommands returns array", () => {
  assert.match(SRC, /ships\.length/);
});

test("P1: stash/checkout/merge/rebase re-arming exists in tool_result bash handler", () => {
  assert.match(SRC, /stash\\s\+\(pop\|apply\)/);
  assert.match(SRC, /checkout.*switch.*restore.*reset/);
  assert.match(SRC, /merge\|pull\|rebase\|cherry-pick\|am/);
});

test("P1: turn_end awaits commitsAheadOfBase", () => {
  assert.match(SRC, /await\s+commitsAheadOfBase/);
});

test("precommit trust does NOT depend on parsing bash command text (root-cause fix)", () => {
  // The old forgeable approach inferred a PASS from whether a bash command
  // "looked like" a runner invocation. That whole trust path is gone; PASS now
  // comes only from run_precommit spawning the runner + verifying a receipt.
  // Guard against regressing to a command-text trust heuristic.
  assert.doesNotMatch(SRC, /isPrecommitRunnerCommand/);
});
