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
 *   (b) the argv builders are imported and called in exactly the places their
 *       job allows: OPENING has one path (lib/session-factory.ts for a child's
 *       window and the relay's split, lib/session-tmux-scope.ts for the session
 *       itself), while reading a session's marker and killing one also has the
 *       orphan sweep — which reclaims a holder that is provably gone and never
 *       opens anything;
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

test("(b) the argv builders have exactly the consumers their job allows — and opening has ONE path", () => {
  // The window/session builders live in the tmux module. The claim that matters
  // is about OPENING: exactly one file may create the session and one may open
  // a child in it, because a third consumer is how a second opening path
  // starts. Reading a session's marker and KILLING one is a different job with
  // a second, argued consumer (2026-09-25, t2): the orphan sweep reclaims the
  // session of a holder that is PROVABLY gone, after reading that session's own
  // `@rg_scope_owner` marker and finding the dead holder's id in it — it never
  // creates anything, and its kill goes through the same builder (and the same
  // shape check) as the owner's own `closeOwnSession`.
  const openingBuilders = [
    "buildNewSessionArgv",
    "buildNewWindowArgv",
    "buildSetSessionOwnerArgv",
  ];
  const readOrKillBuilders = ["buildKillSessionArgv", "buildReadSessionOwnerArgv", "buildListSessionsArgv"];
  const factoryDefined = ["buildHandoffPaneArgv", "buildKillWindowArgv", "buildKillPaneArgv"];
  const claims: Array<[readonly string[], string[]]> = [
    [openingBuilders, ["lib/orchestrator-tmux.ts", "lib/session-tmux-scope.ts"]],
    [readOrKillBuilders, ["lib/orchestrator-tmux.ts", "lib/session-tmux-scope.ts", "lib/session-orphan-sweep.ts"]],
    [factoryDefined, ["lib/orchestrator-tmux.ts", "lib/session-factory.ts"]],
  ];
  for (const [builders, consumers] of claims) {
    for (const builder of builders) {
      const users = sourceFiles()
        .filter((f) => f.text.includes(builder))
        .map((f) => f.rel)
        .sort();
      assert.deepEqual(users, [...consumers].sort(),
        `${builder} is defined in orchestrator-tmux.ts and used only by ${consumers.slice(1).join(" / ")}`);
    }
  }
  // …and NEITHER the factory NOR the sweep is a second caller of the OPENING
  // builders: the session is the scope module's, and only the scope module's.
  const factoryText = sourceFiles().find((f) => f.rel === "lib/session-factory.ts")!.text;
  const sweepText = sourceFiles().find((f) => f.rel === "lib/session-orphan-sweep.ts")!.text;
  for (const builder of openingBuilders) {
    assert.ok(!factoryText.includes(builder), `the factory must not call ${builder} itself`);
    assert.ok(!sweepText.includes(builder), `the sweep reclaims, it never opens: ${builder} is not its business`);
  }
});

test("all six pane-opening call sites go through the factory", () => {
  // Six anchors, and the window for each ends where the NEXT function starts —
  // never at a guessed brace. A window that ran past its function would find a
  // neighbour's call and report success for a caller that opens panes its own
  // way, so the disjointness is asserted below rather than assumed.
  const sites: Array<{ file: string; anchor: string }> = [
    { file: "lib/judge-round-dispatch.ts", anchor: "async function dispatchJudgeRound(" },
    { file: "lib/judge-spawn-tools.ts", anchor: "async function doSpawn(" },
    { file: "lib/judge-spawn-tools.ts", anchor: "async function doRecover(" },
    { file: "lib/orchestrator-dispatch.ts", anchor: "export async function dispatchSpawn(" },
    { file: "lib/orchestrator-recovery-tools.ts", anchor: "async function doRecover(" },
    { file: "extensions/review-gate.ts", anchor: "openSuccessor: async (spec) => {" },
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
    const opens = [...body.matchAll(/openSessionWindow\(/g)].length;
    assert.equal(opens, 1, `${site.file} ${site.anchor} opens its child through the factory, exactly once`);
  }
});

test("nothing opens a child behind the factory's back", () => {
  const stragglers = sourceFiles()
    .filter((f) => f.rel !== "lib/session-factory.ts" && f.rel !== "lib/session-tmux-scope.ts")
    .filter((f) => /\b(openJudgePane|buildSpawnPaneArgv\(|buildNewSessionArgv\(|buildNewWindowArgv\()/.test(f.text))
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
  const text = readFileSync(join(ROOT, "lib", "judge-wait-criteria.ts"), "utf8");
  const at = text.indexOf("export function probeJudgeRound(");
  assert.ok(at > 0, "the probe must exist");
  const body = text.slice(at, text.indexOf("\n}", at));
  assert.match(body, /refreshSessionPaneTitle\(deps\.tmux/,
    "the judge's title is repainted by the SAME function the orchestration side uses");
  assert.match(body, /paintTitle\(projection\.lastState\?\.state/,
    "…from the channel projection, never from the screen");
  assert.match(body, /paintTitle\("done"\)/, "…and a finished round says so on the border");
});

test("the label-bar RELEASE is deleted, not bypassed (2026-09-17)", () => {
  // Five close paths used to share one question — "is this the last decorated
  // pane I can see" — through `releasesWindowLabels` + `countDecoratedPanes`,
  // fed by `insideOrchestration` / `otherDecoratedPanes` / `decoratedJudgePanes`
  // and the `labelBarOwnedByOthers()` guest test. All of it is GONE, and the
  // reason is a measurement: taking the window's label bar down writes
  // `pane-border-status`, which RESIZES EVERY PANE IN THE WINDOW (scratch tmux:
  // SIGWINCH, rows 84 ↔ 83, in both directions; re-setting the same value
  // triggers nothing). The bar is turned on by whoever opens a decorated pane
  // and left on.
  //
  // Pinned by ABSENCE across the whole tree: a symbol that comes back is a
  // second path to sequence by hand (philosophy three), and `grep` is the
  // check the goal names.
  const roots = ["extensions", "lib"];
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      const text = readFileSync(join(ROOT, rel), "utf8");
      for (const symbol of ["hideLabelsVia", "releasesWindowLabels", "countDecoratedPanes", "decoratedJudgePanes", "otherDecoratedPanes", "labelBarOwnedByOthers", "buildHidePaneLabelsArgv"]) {
        // Mentions inside a comment are how this repository records WHY
        // something was deleted; only code counts.
        for (const line of text.split("\n")) {
          if (!line.includes(symbol)) continue;
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
          offenders.push(`${rel}: ${symbol}: ${line.trim()}`);
        }
      }
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders, [], "the release path is deleted, not bypassed");
});
