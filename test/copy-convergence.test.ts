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

/** The markdown table that starts at `header`, up to the first blank line. */
function tableAfter(text: string, header: string): string {
  const start = text.indexOf(header);
  if (start === -1) return "";
  const end = text.indexOf("\n\n", start);
  return text.slice(start, end === -1 ? text.length : end);
}

/** The single line containing `needle` — a one-row inventory is still one. */
function lineContaining(text: string, needle: string): string {
  const at = text.indexOf(needle);
  if (at === -1) return "";
  const from = text.lastIndexOf("\n", at) + 1;
  const to = text.indexOf("\n", at);
  return text.slice(from, to === -1 ? text.length : to);
}

/** Chinese numerals as far as any inventory in this repo counts. */
const CN_NUMERALS: Record<string, number> = {
  "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12,
};

/**
 * The number a passage states out loud — "工具集（10 个）", "全部走十个工具".
 * `undefined` when it states none, which is allowed: a list may simply list.
 */
function countClaimedIn(scope: string): number | undefined {
  const digits = /(\d+)\s*个/.exec(scope);
  if (digits) return Number(digits[1]);
  const chinese = /([一二三四五六七八九十]+)\s*个/.exec(scope);
  if (chinese && CN_NUMERALS[chinese[1]!] !== undefined) return CN_NUMERALS[chinese[1]!];
  return undefined;
}


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

  // Each inventory is judged INSIDE ITS OWN WINDOW, never against the whole
  // file (round-1 P1): README names all ten tools in two different places, so
  // a whole-file scan stayed green while either copy lost a tool. The window
  // is the passage that claims to BE the list.
  const inventories: { path: string; window: (text: string) => string }[] = [
    // AGENTS.md writes the family with a shorthand tail (`_spawn`, `_wait`…).
    { path: "AGENTS.md", window: (t) => paragraphAround(t, t.indexOf("工具集（")) },
    // README has two: the orchestrator-role table, and the row in the tool
    // reference. Both are inventories, so both are checked.
    { path: "README.md", window: (t) => tableAfter(t, "| Tool | What the orchestrator asks for |") },
    { path: "README.md", window: (t) => lineContaining(t, "The orchestration layer, available only in") },
    { path: "QUICKSTART.md", window: (t) => paragraphAround(t, t.indexOf("orchestrator_plan")) },
  ];

  for (const { path, window } of inventories) {
    const text = readRepoFile(path);
    const scope = window(text);
    // Self-proof #2: the window found the passage, and it is a passage — not
    // the empty string and not the whole file.
    assert.ok(
      scope.length > 200 && scope.length < text.length,
      `${path}: the inventory window came out at ${scope.length} chars — it did not find the list`,
    );
    for (const tool of registered) {
      const shorthand = "`_" + tool.slice("orchestrator_".length) + "`";
      assert.ok(
        scope.includes(tool) || scope.includes(shorthand),
        `${path} lists the orchestration tools but that list never names ${tool} — the inventory is ` +
          "short of what the gate registers, which is exactly how a tool nobody documents stops being used",
      );
    }
    // A COUNT stated out loud in the same window ("工具集（10 个）", "十个工具")
    // is the part a human reads and nobody recomputes.
    const counted = countClaimedIn(scope);
    if (counted !== undefined) {
      assert.equal(
        counted,
        registered.length,
        `${path} claims ${counted} orchestration tools, the gate registers ${registered.length}`,
      );
    }
  }
  // …and at least one surface must state the count, or that check is dead code.
  assert.ok(
    inventories.some(({ path, window }) => countClaimedIn(window(readRepoFile(path))) !== undefined),
    "no doc states how many orchestration tools there are — the count check never runs",
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
      // enumerations, so the passage has to be about a child's state. The
      // window is a NEIGHBOURHOOD, not the paragraph (round-1 P2): the copy
      // this round corrected lives in a section HEADING — "## 二、状态：八态"
      // — which is a paragraph of its own and mentions nothing else, so a
      // paragraph-sized window silently skipped the very line at issue.
      const context = text.slice(Math.max(0, match.index - 400), match.index + 400);
      if (!/orchestrator-child-state|子会话|child|waiting-judge|监督|心跳|pane/.test(context)) continue;
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

// ---------------------------------------------------------------------------
// 5. the review round's cancel matrix (2026-09-16)
// ---------------------------------------------------------------------------

/**
 * THE ONE HOME, and the surfaces that summarise it.
 *
 * The quality round, the functional reviewer and the precommit lane used to run
 * in a fixed order (quality first, then the reviewer, the lane beside them).
 * They now start together and the cancel matrix decides who stops whom — a
 * table that existed in FIVE prose copies before this test, four of which said
 * the opposite of what the code does. `docs/module-map.md` §7.1 carries this
 * row; the anchors below are what proves the scan read a surface that still
 * discusses the matrix at all.
 */
const CANCEL_AUTHORITY = "docs/execution-model.md";
const CANCEL_SECTION = "并行三方与取消矩阵";
const CANCEL_SURFACES: ReadonlyArray<{ path: string; anchor: string | RegExp }> = [
  { path: "AGENTS.md", anchor: "quality round runs BESIDE" },
  { path: "docs/coding-standards.md", anchor: "审核分两轮，但不是串行" },
  { path: "README.md", anchor: "the quality round and the reviewer all run" },
  { path: "skills/review-loop/SKILL.md", anchor: "cancel" },
  { path: "agents/reviewer.md", anchor: "AT THE SAME" },
  { path: "agents/quality-auditor.md", anchor: "same round as the functional reviewer" },
];

test("the cancel matrix has ONE substantive home, and it states all three rows", () => {
  const authority = readRepoFile(CANCEL_AUTHORITY);
  assert.ok(authority.includes(CANCEL_SECTION),
    `${CANCEL_AUTHORITY} must carry the §${CANCEL_SECTION} section — every pointer below aims at it`);
  // The three rows, as FACTS about who stops whom. Each is the thing four
  // copies used to get wrong.
  assert.match(authority, /质量轮非 READY[\s\S]{0,160}reviewer 的 pane[\s\S]{0,120}precommit lane/,
    "row 1: a blocking quality verdict stops the reviewer AND the lane");
  assert.match(authority, /reviewer 非 READY[\s\S]{0,160}质量轮的 pane[\s\S]{0,120}precommit lane/,
    "row 2: a blocking reviewer verdict stops the quality round AND the lane");
  assert.match(authority, /precommit 落 FAIL[\s\S]{0,160}reviewer 的 pane[\s\S]{0,120}质量轮（它只静态读代码/,
    "row 3: a FAILED lane stops ONLY the reviewer — the quality round carries on");
  // …the parking rule the two judges running together makes necessary…
  assert.match(authority, /扣下/, "the held-READY rule is stated where the matrix is");
  assert.match(authority, /pendingReady/, "…and names where the hold actually lands");
  // …and the fact that makes the matrix necessary at all.
  assert.match(authority, /同一时刻启动/, "the three parties start together");
});

test("every surface that summarises the cancel matrix says the NEW order and points home", () => {
  const summaries = readSurfaces(CANCEL_SURFACES);
  for (const s of summaries) {
    assert.ok(s.text.includes("execution-model.md"),
      `${s.path} summarises the matrix but does not point at ${CANCEL_AUTHORITY} — a summary ` +
      "with no pointer is a copy that goes stale on its own");
  }
  const byPath = new Map(summaries.map((s) => [s.path, s.text]));
  // A pointer alone is not enough: a surface that keeps the OLD model in its own
  // words sends the reader back to it. Each of these states the fact that moved.
  assert.match(byPath.get("AGENTS.md")!, /kills the reviewer's pane/,
    "AGENTS.md must say what a non-READY quality round DOES, not just point");
  assert.match(byPath.get("README.md")!, /cancel matrix/, "README names the mechanism");
  assert.match(byPath.get("skills/review-loop/SKILL.md")!, /SAME\s*TIME|at the same time/i,
    "the shipped skill tells the agent the two judges start together");
  assert.match(byPath.get("docs/coding-standards.md")!, /同时启动/,
    "the standards' review section says the two rounds are not serial");
});

test("no surface still teaches the SERIAL round this replaced (negative, with a self-proof)", () => {
  // The exact wordings that were wrong. Kept as literals so the SELF-PROOF
  // below can prove the pattern still matches them: a negative scan whose
  // regex silently stops matching passes for the wrong reason, and that is the
  // failure mode this whole file exists to prevent.
  const GONE = [
    "A code-quality round runs FIRST",
    "dispatches `quality-auditor` FIRST",
    "Once the quality round passes, the gate dispatches the reviewer",
    "quality round has passed",
    "Precommit runs FIRST, review second — never concurrently",
    "过了才是 `reviewer`",
    "before the functional reviewer",
    "runs BEFORE you, on the SAME commit range",
  ];
  const STALE = new RegExp(GONE.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
  for (const gone of GONE) {
    assert.match(gone, STALE, `the negative pattern must match the wording it exists to catch: ${gone}`);
  }
  const scanned = readSurfaces(CANCEL_SURFACES.filter((s) => s.path !== CANCEL_AUTHORITY));
  assert.ok(scanned.length >= 5, "the negative scan must cover every pointer surface");
  for (const s of scanned) {
    assert.doesNotMatch(s.text, STALE,
      `${s.path} still teaches the serial quality round (2026-09-15) — the code starts all three ` +
      `parties together; the matrix's home is ${CANCEL_AUTHORITY} §${CANCEL_SECTION}`);
  }
});
