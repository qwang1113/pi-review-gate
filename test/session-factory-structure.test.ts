/**
 * ONE WAY TO OPEN A PANE — the structural half of the session factory.
 *
 * The unit tests in test/session-factory.test.ts prove the factory does the
 * right thing. They cannot prove that nobody ELSE still opens a pane their own
 * way, and that is the whole point of the refactor: every defect it removed
 * (an invisible judge border, a judge title nobody refreshed, a judge spawn
 * whose delivery was never verified) was a step one caller performed and
 * another forgot.
 *
 * So these two claims are asserted mechanically, over every source file rather
 * than a line window (a window that misses half the input does not fail — it
 * quietly reports a smaller number):
 *
 *   (a) the tmux `split-window` LITERAL exists in exactly two files: the argv
 *       builder that constructs it, and the bash guard's forbidden-alias table
 *       (which is not an execution point — it is the list of commands the agent
 *       may not type);
 *   (b) the spawn argv builders are imported and called in exactly one place:
 *       lib/session-factory.ts.
 *
 * Plus: the six call sites that open a pi session all go through the factory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every source file the gate ships, by directory enumeration — never a list. */
function sourceFiles(): Array<{ rel: string; text: string }> {
  const files: Array<{ rel: string; text: string }> = [];
  for (const dir of ["lib", "extensions"]) {
    for (const name of readdirSync(join(ROOT, dir)).sort()) {
      if (!name.endsWith(".ts")) continue;
      files.push({ rel: `${dir}/${name}`, text: readFileSync(join(ROOT, dir, name), "utf8") });
    }
  }
  return files;
}

test("the scan itself covers both ends before its verdict means anything", () => {
  const files = sourceFiles();
  const names = files.map((f) => f.rel);
  // A scan that silently missed a directory would pass every claim below.
  assert.ok(names.includes("lib/session-factory.ts"), "lib/ is scanned");
  assert.ok(names.includes("extensions/review-gate.ts"), "extensions/ is scanned too");
  assert.ok(names.filter((n) => n.startsWith("lib/")).length > 100, "…and lib/ is scanned WHOLE");
  assert.ok(files.every((f) => f.text.length > 0), "every scanned file was actually read");
});

test("(a) the split-window literal lives in exactly two files, and neither is a caller", () => {
  const holders = sourceFiles()
    .filter((f) => /"split-window"/.test(f.text))
    .map((f) => f.rel)
    .sort();
  assert.deepEqual(holders, ["lib/orchestrator-guard.ts", "lib/orchestrator-tmux.ts"],
    "only the argv builder constructs it; only the bash guard names it as a FORBIDDEN command " +
    "(that file is a deny-list, not an execution point)");
});

test("(b) the spawn argv builders have exactly one consumer: the session factory", () => {
  for (const builder of ["buildSpawnPaneArgv", "buildHandoffPaneArgv"]) {
    const users = sourceFiles()
      .filter((f) => f.text.includes(builder))
      .map((f) => f.rel)
      .sort();
    assert.deepEqual(users, ["lib/orchestrator-tmux.ts", "lib/session-factory.ts"],
      `${builder} is defined in orchestrator-tmux.ts and used ONLY by the factory`);
  }
});

test("all six pane-opening call sites go through openSessionPane", () => {
  // Six anchors, and the window for each ends where the NEXT function starts —
  // never at a guessed brace. A window that ran past its function would find a
  // neighbour's call and report success for a caller that opens panes its own
  // way, so the disjointness is asserted below rather than assumed.
  const sites: Array<{ file: string; anchor: string }> = [
    { file: "extensions/review-gate.ts", anchor: "async function dispatchJudgeRound(" },
    { file: "lib/judge-spawn-tools.ts", anchor: "async function doSpawn(" },
    { file: "lib/judge-spawn-tools.ts", anchor: "async function doRecover(" },
    { file: "lib/orchestrator-dispatch.ts", anchor: "export async function dispatchSpawn(" },
    { file: "lib/orchestrator-recovery-tools.ts", anchor: "async function doRecover(" },
    { file: "lib/orchestrator-session-tools.ts", anchor: "async function doHandoff(" },
  ];
  /** From this function's start to wherever the next function begins. */
  const windowOf = (text: string, at: number): string => {
    const next = [...text.matchAll(/\n\s*(?:export )?(?:async )?function \w+\(/g)]
      .map((m) => m.index!)
      .find((index) => index > at);
    return text.slice(at, next ?? text.length);
  };
  for (const site of sites) {
    const text = readFileSync(join(ROOT, site.file), "utf8");
    const at = text.indexOf(site.anchor);
    assert.ok(at > 0, `${site.file} must still contain ${site.anchor}`);
    assert.equal(text.indexOf(site.anchor, at + 1), -1, `${site.anchor} must name ONE function in ${site.file}`);
    const body = windowOf(text, at);
    // The window is genuinely this function's: no other site's anchor is in it.
    for (const other of sites) {
      if (other === site || other.file !== site.file) continue;
      assert.ok(!body.includes(other.anchor), `${site.anchor}'s window must stop before ${other.anchor}`);
    }
    const opens = [...body.matchAll(/openSessionPane\(/g)].length;
    assert.equal(opens, 1, `${site.file} ${site.anchor} opens its pane through the factory, exactly once`);
  }
});

test("nothing opens a pane behind the factory's back", () => {
  const stragglers = sourceFiles()
    .filter((f) => f.rel !== "lib/session-factory.ts")
    .filter((f) => /\b(openJudgePane|buildSpawnPaneArgv\(|buildHandoffPaneArgv\()/.test(f.text))
    .filter((f) => f.rel !== "lib/orchestrator-tmux.ts")
    .map((f) => f.rel);
  assert.deepEqual(stragglers, [],
    "the old openJudgePane is gone and no second caller assembles a spawn argv");
});

test("both recover tools reach the same recovery judgement", () => {
  for (const file of ["lib/judge-spawn-tools.ts", "lib/orchestrator-recovery-tools.ts"]) {
    const text = readFileSync(join(ROOT, file), "utf8");
    assert.match(text, /paneRecoverability\(\{/,
      `${file} decides recoverability with the shared function, not its own comparison`);
  }
});

test("the judge probe repaints the border from the channel projection (C2)", () => {
  const text = readFileSync(join(ROOT, "lib", "judge-session-tools.ts"), "utf8");
  const at = text.indexOf("export function probeJudgeRound(");
  assert.ok(at > 0, "the probe must exist");
  const body = text.slice(at, text.indexOf("\n}", at));
  assert.match(body, /refreshSessionPaneTitle\(deps\.tmux/,
    "the judge's title is repainted by the SAME function the orchestration side uses");
  assert.match(body, /paintTitle\(projection\.lastState\?\.state/,
    "…from the channel projection, never from the screen");
  assert.match(body, /paintTitle\("done"\)/, "…and a finished round says so on the border");
});

test("both label-bar release sites ask about a CHILD and about a MANAGER's children", () => {
  // The window-level border line is shared by every pane in the window, so the
  // LAST decorated pane releases it. "Last" needs two different facts, and each
  // was measured as a defect on its own (reviewer P2 ×2, 2026-09-05):
  //   - a CHILD of an orchestration cannot see the manager's panes, so it never
  //     releases (recognised by the orchestration id in its environment);
  //   - a MANAGER has decorated panes that are not judges — its children — and
  //     must count them, or it blanks their borders when it closes its own
  //     auditor, and never releases at all when it has none.
  const ext = readFileSync(join(ROOT, "extensions", "review-gate.ts"), "utf8");
  const windowAt = (needle: string, chars: number): string => {
    const at = ext.indexOf(needle);
    assert.ok(at > 0, `${needle} must exist in the extension`);
    return ext.slice(at, at + chars);
  };
  // 1. judge_close's wiring.
  const judgeWiring = windowAt("insideOrchestration: () =>", 260);
  assert.match(judgeWiring, /ORCHESTRATION_ID_ENV/, "a child is recognised by its environment");
  assert.match(judgeWiring, /otherDecoratedPanes: \(\) => liveOrchestrationChildren\(\)/,
    "…and a manager's children are counted, not assumed away");
  // 2. declare_done's cascade.
  const cascade = windowAt("const releases = releasesWindowLabels({", 320);
  assert.match(cascade, /remainingDecoratedPanes: remainingClosable \+ liveOrchestrationChildren\(\)/,
    "the cascade counts the manager's children too");
  assert.match(cascade, /insideOrchestration: Boolean\(process\.env\[ORCHESTRATION_ID_ENV\]/,
    "…and still never releases from inside a child session");
  // 3. And the counter itself only answers for a manager.
  const counter = windowAt("function liveOrchestrationChildren()", 300);
  assert.match(counter, /taskMode !== "orchestrator"/, "nobody else owns child panes");
  assert.match(counter, /!c\.closedAt/, "…and a closed child is not on screen");
});
