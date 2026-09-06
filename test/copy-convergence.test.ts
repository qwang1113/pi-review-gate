/**
 * THREE PIECES OF DOCTRINE THAT USED TO GO STALE IN SILENCE.
 *
 * `docs/module-map.md` §7.2 is the list of copies no test watches, and on
 * 2026-09-17 three of its rows were checked against the code for the first
 * time. Every one of them was already wrong:
 *
 *  - the ORCHESTRATION TOOL INVENTORY ("工具集（10 个）", hand-written in five
 *    places): `docs/execution-model.md` named three tools that had been
 *    deleted a month earlier and never named `orchestrator_plan` at all.
 *  - the CHILD STATES: the union has eight members, and `README.md`,
 *    `docs/execution-model.md`, `docs/orchestrator-supervision.md` — and the
 *    comment above the union itself — all still said seven. `mode-changed`
 *    appeared in no document.
 *  - the 600-LINE HARD LIMIT: `test/file-size-gate.test.ts` imports the
 *    constant and never spells the number, so every prose copy of "600" was
 *    free to drift.
 *
 * The shape of each test is the one `test/review-carryover.test.ts`
 * established: derive the truth from the CODE, prove the scan really saw the
 * surfaces it judges (a vacuous pass is worse than no pin — the copy map would
 * go on citing a test that checks nothing), and only then compare.
 *
 * WHAT THESE TESTS DO NOT DO: judge whether a doc's *explanation* is any good.
 * They check the facts a machine can own — which tools exist, which states
 * exist, what the limit is — and leave the prose to the reviewer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import { makeFakeWorld } from "./helpers/fake-orchestration.ts";
import { CHILD_STATES } from "../lib/orchestrator-child-state.ts";
import { NEW_FILE_HARD_LIMIT } from "../lib/file-size-gate.ts";
import {
  paragraphAround,
  proseSurfaces,
  readRepoFile,
  readSurfaces,
} from "./helpers/doc-surfaces.ts";

/** The tool names the gate actually registers for an orchestrator. */
function registeredOrchestrationTools(): string[] {
  const world = makeFakeWorld();
  return [...world.tools.keys()].filter((name) => name.startsWith("orchestrator_")).sort();
}

/**
 * The precommit STEP NAMES, taken from the runner that declares them.
 *
 * `docs/module-map.md` §7.2 named `scripts/precommit-plan.mjs` as the
 * authority; it is not — that module plans a step's cache scope and takes the
 * name as an argument. The names are declared in `scripts/precommit-runner.mjs`
 * (`collectStep(...)`), which is what this reads.
 */
function precommitStepNames(): string[] {
  const source = readRepoFile("scripts/precommit-runner.mjs");
  const names = new Set<string>();
  for (const match of source.matchAll(/collectStep\("([a-z-]+)"/g)) names.add(match[1]!);
  return [...names].sort();
}


/**
 * Words that mark a mention as HISTORY rather than instruction. A doc is
 * allowed — encouraged, even — to explain what was replaced and why; what it
 * may not do is leave a dead tool reading like a live one.
 */
const REMOVAL_MARKERS = [
  "已删除", "已整体删除", "已并入", "上一版", "原来的", "原 ", "替换", "退役", "不再",
  "retired", "removed", "deleted", "no longer", "gone", "replaced",
];

// ---------------------------------------------------------------------------
// 1. the orchestration tool inventory
// ---------------------------------------------------------------------------

test("every doc inventory of the orchestration tools is the set the gate registers", () => {
  const registered = registeredOrchestrationTools();
  // Self-proof #1: the derivation produced a real inventory. An empty or
  // half-built fake world would make every assertion below vacuous.
  assert.ok(
    registered.length >= 8 && registered.includes("orchestrator_plan"),
    `the registration scan found ${registered.length} tools (${registered.join(", ")}) — that is not the tool family`,
  );

  const inventories = readSurfaces([
    // AGENTS.md writes the family with a shorthand tail (`_spawn`, `_wait`…).
    { path: "AGENTS.md", anchor: /工具集（\d+ 个）/ },
    { path: "README.md", anchor: "orchestrator_handoff" },
    { path: "QUICKSTART.md", anchor: "orchestrator_spawn" },
  ]);

  for (const { path, text } of inventories) {
    for (const tool of registered) {
      const shorthand = "`_" + tool.slice("orchestrator_".length) + "`";
      assert.ok(
        text.includes(tool) || text.includes(shorthand),
        `${path} lists the orchestration tools but never names ${tool} — the inventory is short of ` +
          "what the gate registers, which is exactly how a tool nobody documents stops being used",
      );
    }
  }

  // The COUNT AGENTS.md states out loud, checked against the registry: the
  // number is the part a human reads and the part nobody recomputes.
  const agents = inventories.find((s) => s.path === "AGENTS.md")!;
  const claimed = /工具集（(\d+) 个）/.exec(agents.text);
  assert.ok(claimed, "AGENTS.md must state how many orchestration tools there are");
  assert.equal(
    Number(claimed![1]),
    registered.length,
    `AGENTS.md claims ${claimed![1]} orchestration tools, the gate registers ${registered.length}`,
  );
});

test("no doc presents a DELETED orchestration tool as one you can still call", () => {
  const registered = new Set(registeredOrchestrationTools());
  const surfaces = proseSurfaces();
  // Self-proof: the scan must cover the design docs, which is where the dead
  // names survive, and the token regex must actually be matching.
  for (const rel of ["AGENTS.md", "README.md", "docs/execution-model.md", "docs/orchestrator-supervision.md"]) {
    assert.ok(surfaces.includes(rel), `the scan must cover ${rel}`);
  }
  let mentions = 0;
  for (const rel of surfaces) {
    const text = readRepoFile(rel);
    for (const match of text.matchAll(/orchestrator_[a-z_]+/g)) {
      mentions++;
      const name = match[0];
      if (registered.has(name)) continue;
      const context = paragraphAround(text, match.index);
      assert.ok(
        REMOVAL_MARKERS.some((marker) => context.includes(marker)),
        `${rel} names ${name}, which the gate does not register, in a passage that never says it is ` +
          "gone. Either the doc is describing history (say so in that paragraph) or it is telling a " +
          "reader to call a tool that does not exist.",
      );
    }
  }
  assert.ok(mentions > 30, `the token scan found only ${mentions} orchestrator_* mentions — it is not reading the docs`);
});

// ---------------------------------------------------------------------------
// 2. the child states
// ---------------------------------------------------------------------------

/** A number word, in either language, as used by "七态" / "seven states". */
const NUMERALS: Record<string, number> = {
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

test("a doc that COUNTS the child states counts the union", () => {
  const expected = CHILD_STATES.length;
  const pattern = /([五六七八九十]|five|six|seven|eight|nine|ten)\s*(态|个状态|状态|\s+states)/gi;
  let claims = 0;
  for (const rel of proseSurfaces()) {
    const text = readRepoFile(rel);
    for (const match of text.matchAll(pattern)) {
      const claimed = NUMERALS[match[1]!.toLowerCase()];
      if (claimed === undefined) continue;
      // Only the child-state doctrine: the same phrase shape is used for other
      // enumerations, so the passage has to be about a child's state.
      const context = paragraphAround(text, match.index);
      if (!/orchestrator-child-state|子会话|child|waiting-judge|监督/.test(context)) continue;
      claims++;
      assert.equal(
        claimed,
        expected,
        `${rel} says "${match[0]}" — the union in lib/orchestrator-child-state.ts has ${expected} ` +
          `members (${CHILD_STATES.join(", ")}). A count nobody recomputes is the copy that goes stale first.`,
      );
    }
  }
  // Self-proof: the docs DO count the states out loud in several places. Zero
  // matches would mean the regex broke, not that the drift was fixed.
  assert.ok(claims >= 3, `the scan found only ${claims} state-count claims — check the pattern before trusting a pass`);
});

test("the docs that enumerate the child states enumerate ALL of them", () => {
  // Explicit windows, because only these passages claim to be the full list —
  // a doc that merely mentions `waiting-judge` in passing owes nothing.
  const windows: { path: string; window: (text: string) => string }[] = [
    {
      path: "AGENTS.md",
      window: (text) => paragraphAround(text, text.indexOf("working / waiting-input")),
    },
    {
      path: "docs/execution-model.md",
      window: (text) => paragraphAround(text, text.indexOf("结构化真值")),
    },
    {
      path: "docs/orchestrator-supervision.md",
      window: (text) => {
        const start = text.indexOf("## 二、状态");
        const end = text.indexOf("\n## ", start + 1);
        return text.slice(start, end === -1 ? text.length : end);
      },
    },
  ];
  for (const { path, window } of windows) {
    const text = readRepoFile(path);
    const scope = window(text);
    // Self-proof: the window found something, and something of the right size.
    assert.ok(
      scope.length > 200 && scope.length < text.length,
      `${path}: the enumeration window came out at ${scope.length} chars — it did not find the passage`,
    );
    for (const state of CHILD_STATES) {
      assert.ok(
        scope.includes(state),
        `${path} enumerates the child states but omits \`${state}\` — the union in ` +
          "lib/orchestrator-child-state.ts has it, and a supervisor reading this list would not know it exists",
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 3. the 600-line hard limit
// ---------------------------------------------------------------------------

test("every prose copy of the new-file line limit is the gate's own number", () => {
  // A line that states the RULE: a number immediately followed by 行/-line,
  // in a sentence that is about a limit. Prose like "how a 600-line file
  // becomes an 8000-line one" states no limit and is left alone.
  const limitLine = /(\d{3,5})\s*(?:行|-line)/g;
  let checked = 0;
  for (const rel of proseSurfaces()) {
    for (const line of readRepoFile(rel).split("\n")) {
      if (!/硬拦|上限|hard limit|limit of/.test(line)) continue;
      for (const match of line.matchAll(limitLine)) {
        checked++;
        assert.equal(
          Number(match[1]),
          NEW_FILE_HARD_LIMIT,
          `${rel} states a ${match[1]}-line limit; lib/file-size-gate.ts enforces ` +
            `${NEW_FILE_HARD_LIMIT} (NEW_FILE_HARD_LIMIT). The doc is what people plan against — ` +
            "it has to be the number the gate will actually apply.",
        );
      }
    }
  }
  // Self-proof: the rule IS written down in prose, in more than one place. If
  // this scan stops finding it, the pin is protecting nothing.
  assert.ok(checked >= 3, `the scan found only ${checked} written copies of the line limit — check the pattern`);
});

// ---------------------------------------------------------------------------
// 4. the precommit step names
// ---------------------------------------------------------------------------

test("every doc that lists the precommit steps lists the ones the runner runs", () => {
  const steps = precommitStepNames();
  // Self-proof: the derivation found a real ladder, not an empty set.
  assert.ok(
    steps.length >= 4 && steps.includes("typecheck") && steps.includes("test"),
    `the runner scan found ${steps.length} step names (${steps.join(", ")}) — that is not the precommit ladder`,
  );

  // A line that WRITES OUT the ladder ("lint + typecheck + …", "lint/typecheck/…")
  // is claiming to be the list; a line that mentions one step is not.
  const ladder = /lint\s*[+/]\s*typecheck/;
  let listings = 0;
  for (const rel of proseSurfaces()) {
    for (const line of readRepoFile(rel).split("\n")) {
      if (!ladder.test(line)) continue;
      listings++;
      for (const step of steps) {
        // The `test` step is legitimately written as "the complete suite" /
        // "the tests related to the changed files" — the LANE is what those
        // sentences are about. What may not happen is a step vanishing.
        const written = step === "test" ? /test|suite/ : new RegExp(step);
        assert.ok(
          written.test(line),
          `${rel} writes out the precommit ladder but omits \`${step}\`: ${line.trim().slice(0, 160)}\n` +
            `The runner declares ${steps.join(" / ")} (scripts/precommit-runner.mjs, collectStep) — ` +
            "a ladder that reads short is one somebody will plan a commit around.",
        );
      }
    }
  }
  assert.ok(listings >= 3, `the scan found only ${listings} written copies of the ladder — check the pattern`);
});
