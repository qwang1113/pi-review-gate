/**
 * Fast/full lane planning — the rules that decide `testScope` and the
 * per-step cache scope.
 *
 * These are the two decisions that make the split safe: `testScope` is what
 * the ship gate reads to refuse a narrowed run for a push/PR, and the cache
 * scope is what decides whether a step may reuse a previous PASS. Both are
 * pure, so every branch is pinned here rather than inferred from a live run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boundedTail,
  createCaptureAccumulator,
  detectsMdConsumingBuild,
  intersectWithScriptPaths,
  isDocFile,
  jestIgnoreArgs,
  maybeInjectJestIgnore,
  narrowableFlags,
  parseTestScript,
  planFastTests,
  runTestsByPathCommand,
  shellQuote,
  hasJestConfigSelection,
  splitTokens,
  stepInputScope,
} from "../scripts/precommit-plan.mjs";

// ---------------------------------------------------------------------------
// testScope — the three outcomes the gate distinguishes
// ---------------------------------------------------------------------------

const jestBin = () => "'/repo/node_modules/.bin/jest'";

test("testScope RELATED: a jest suite with changed sources derives a related set", () => {
  const plan = planFastTests({
    parsed: parseTestScript("jest test/unit --runInBand"),
    changedFiles: ["src/a.ts", "README.md"],
    fullCommand: "npm run test",
    resolveBin: jestBin,
  });
  assert.equal(plan.testScope, "related");
  assert.ok(plan.listCommand?.includes("--findRelatedTests"), "jest is enumerated first");
  assert.ok(plan.listCommand?.includes("'src/a.ts'"), "changed sources are passed through");
  assert.ok(!plan.listCommand?.includes("README.md"), "docs are not sources a runner can relate");
  assert.deepEqual(plan.positionals, ["test/unit"], "the script's own path filter is preserved");
});

test("testScope SKIPPED: a jest command that selects its own config is not narrowed", () => {
  // The enumeration (`--listTests --findRelatedTests`) would run under the
  // DEFAULT config, and its related set would then be executed as if it came
  // from the real one. Skipping costs a full run; guessing runs the wrong tests.
  for (const body of ["jest --config custom.json", "jest --selectProjects api", "jest --ignoreProjects legacy"]) {
    const plan = planFastTests({
      parsed: parseTestScript(body),
      tokens: splitTokens(body),
      changedFiles: ["src/a.ts"],
      fullCommand: "npm run test",
      resolveBin: jestBin,
    });
    assert.equal(plan.testScope, "skipped", `must not narrow: ${body}`);
    assert.match(plan.reason, /selects its own config/);
  }

  // Default config discovery still narrows.
  const ok = planFastTests({
    parsed: parseTestScript("jest --ci"),
    tokens: splitTokens("jest --ci"),
    changedFiles: ["src/a.ts"],
    fullCommand: "npm run test",
    resolveBin: jestBin,
  });
  assert.equal(ok.testScope, "related");
});

test("testScope RELATED: vitest uses its own related subcommand, no enumeration step", () => {
  const plan = planFastTests({
    parsed: parseTestScript("vitest --run"),
    changedFiles: ["src/a.ts"],
    fullCommand: "npm run test",
    resolveBin: () => "'/repo/node_modules/.bin/vitest'",
  });
  assert.equal(plan.testScope, "related");
  assert.equal(plan.listCommand, null);
  assert.match(plan.command ?? "", /related --run/);
});

test("testScope SKIPPED: an underivable runner never pretends to have covered tests", () => {
  for (const [body, why] of [
    ["node --test test/x.test.js", "node --test has no dependency graph"],
    ["mocha", "unknown runner"],
    ["jest && echo done", "compound command cannot be rewritten safely"],
    ["", "empty script"],
  ] as const) {
    const plan = planFastTests({
      parsed: parseTestScript(body),
      changedFiles: ["src/a.ts"],
      fullCommand: "npm run test",
      resolveBin: () => null,
    });
    assert.equal(plan.testScope, "skipped", why);
    assert.equal(plan.command, null);
  }
});

test("testScope SKIPPED: no changed sources, or an unresolvable binary", () => {
  const noSources = planFastTests({
    parsed: parseTestScript("jest"),
    changedFiles: ["docs/guide.md"],
    fullCommand: "npm run test",
    resolveBin: jestBin,
  });
  assert.equal(noSources.testScope, "skipped");

  const noBin = planFastTests({
    parsed: parseTestScript("jest"),
    changedFiles: ["src/a.ts"],
    fullCommand: "npm run test",
    resolveBin: () => null,
  });
  assert.equal(noBin.testScope, "skipped");
  assert.match(noBin.reason, /not resolvable/);
});

test("changed files unavailable (git unreadable) → skipped, never a silent full claim", () => {
  const plan = planFastTests({
    parsed: parseTestScript("jest"),
    // The runner passes `null` when `git status` could not be read at all.
    changedFiles: null as unknown as string[],
    fullCommand: "npm run test",
    resolveBin: jestBin,
  });
  assert.equal(plan.testScope, "skipped");
});

// ---------------------------------------------------------------------------
// Script parsing — env and flags must survive the rewrite
// ---------------------------------------------------------------------------

test("leading env assignments are preserved (a suite keyed on TEST_ENV breaks without them)", () => {
  const parsed = parseTestScript("TEST_ENV=unit NODE_OPTIONS=--x jest test/unit --runInBand");
  assert.deepEqual(parsed?.env, ["TEST_ENV=unit", "NODE_OPTIONS=--x"]);
  assert.equal(parsed?.runner, "jest");
  assert.deepEqual(parsed?.flags, ["--runInBand"]);
  assert.deepEqual(parsed?.positionals, ["test/unit"]);
});

test("cross-env is understood as the env-setting wrapper it is", () => {
  const parsed = parseTestScript("cross-env TEST_ENV=unit jest");
  assert.deepEqual(parsed?.env, ["TEST_ENV=unit"]);
  assert.equal(parsed?.runner, "jest");
});

test("coverage and path-filter flags are dropped from a narrowed run", () => {
  // Coverage thresholds are computed over the WHOLE suite: keeping them would
  // fail a narrowed run for a reason unrelated to the change.
  assert.deepEqual(
    narrowableFlags(["--runInBand", "--coverage", "--testPathPattern", "test/unit", "--ci"]),
    ["--runInBand", "--ci"],
  );
  assert.deepEqual(narrowableFlags(["--collectCoverageFrom=src/**", "--silent"]), ["--silent"]);
});

test("quoted script tokens survive splitting", () => {
  assert.deepEqual(splitTokens(`jest --testPathPattern "a b" 'c d'`), ["jest", "--testPathPattern", "a b", "c d"]);
});

test("the final command runs exact paths, not patterns", () => {
  const cmd = runTestsByPathCommand({
    env: "TEST_ENV=unit ",
    bin: "'/repo/node_modules/.bin/jest'",
    flags: ["--runInBand"],
    files: ["/repo/test/unit/a.test.ts"],
  });
  assert.match(cmd, /--runTestsByPath '\/repo\/test\/unit\/a\.test\.ts'/);
  assert.match(cmd, /^TEST_ENV=unit /);
});

// ---------------------------------------------------------------------------
// Intersection — jest ignores --testPathPattern next to --findRelatedTests
// ---------------------------------------------------------------------------

test("related tests are intersected with the script's own path filter", () => {
  // Verified against jest 29: `--testPathPattern` has no effect when
  // `--findRelatedTests` is present, so a `jest test/unit` project would
  // otherwise have integration/e2e suites pulled into its commit-time check.
  const related = [
    "/repo/test/unit/a.test.ts",
    "/repo/test/integration/b.test.ts",
  ];
  assert.deepEqual(
    intersectWithScriptPaths(related, ["test/unit"], "/repo"),
    ["/repo/test/unit/a.test.ts"],
  );
});

test("no path filter in the script → every related test is kept", () => {
  const related = ["/repo/test/a.test.ts", "/repo/test/b.test.ts"];
  assert.deepEqual(intersectWithScriptPaths(related, [], "/repo"), related);
});

test("an invalid regex filter degrades to a substring match, never to a throw", () => {
  // `test/unit(` is not a valid regex; the fallback compares it literally.
  const related = ["/repo/test/unit(1)/a.test.ts", "/repo/test/other/b.test.ts"];
  assert.deepEqual(
    intersectWithScriptPaths(related, ["test/unit("], "/repo"),
    ["/repo/test/unit(1)/a.test.ts"],
  );
});

// ---------------------------------------------------------------------------
// Cache input scope — which changes may leave a step's PASS reusable
// ---------------------------------------------------------------------------

test("documentation files are recognized narrowly", () => {
  for (const f of ["README.md", "docs/a.markdown", "notes.txt", "LICENSE", "img/x.png"]) {
    assert.ok(isDocFile(f), f);
  }
  // .mdx is compiled by bundlers, and a docs/ tree routinely holds real code.
  for (const f of ["docs/example.ts", "page.mdx", "src/a.ts", "Makefile"]) {
    assert.ok(!isDocFile(f), f);
  }
});

test("typecheck/build/test get the narrow scope; lint never does", () => {
  assert.equal(stepInputScope("typecheck", "npm run typecheck", false), "code-only");
  assert.equal(stepInputScope("build", "npm run build", false), "code-only");
  assert.equal(stepInputScope("test", "npm run test", false), "code-only");
  // Linters/formatters routinely process Markdown, so a doc change must be
  // able to bust a lint cache.
  assert.equal(stepInputScope("lint", "npm run lint", false), "all");
  // Unknown step names are conservative too.
  assert.equal(stepInputScope("cargo-test", "cargo test", false), "all");
});

test("a code step that itself runs a Markdown-aware tool loses the narrow scope", () => {
  assert.equal(stepInputScope("test", "npm run lint && prettier --check .", false), "all");
  assert.equal(stepInputScope("build", "markdownlint . && tsc", false), "all");
});

test("a Markdown-consuming framework disables the narrow scope entirely", () => {
  assert.equal(stepInputScope("test", "npm run test", true), "all");
  assert.ok(detectsMdConsumingBuild(["package.json", "astro.config.mjs"]));
  assert.ok(detectsMdConsumingBuild([".vitepress", "package.json"]));
  assert.ok(!detectsMdConsumingBuild(["package.json", "tsconfig.json"]));
});

// ---------------------------------------------------------------------------
// jest `.pi` ignore injection — the safety boundary around rewriting a script
// ---------------------------------------------------------------------------

test("jestIgnoreArgs merges the repo's own patterns with the .pi exclusion", () => {
  const args = jestIgnoreArgs(["/node_modules/", "<rootDir>/e2e/"]);
  assert.match(args, /--testPathIgnorePatterns '\/node_modules\/'/, "repo pattern must survive");
  assert.match(args, /--testPathIgnorePatterns '<rootDir>\/e2e\/'/, "repo pattern must survive");
  assert.match(args, /--testPathIgnorePatterns '<rootDir>\/\.pi\/'/, ".pi exclusion must be added");
});

test("jestIgnoreArgs does not duplicate an existing .pi exclusion", () => {
  const args = jestIgnoreArgs(["<rootDir>/.pi/"]);
  assert.equal(args.match(/testPathIgnorePatterns/g)?.length, 1);
});

// ---------------------------------------------------------------------------
// Bounded capture — byte-accurate cap, and the remainder policy after it
// ---------------------------------------------------------------------------

test("boundedTail bounds by BYTES, not just lines (an un-newlined blob is one line)", () => {
  // The receipt is refused by the extension above 1 MiB, so a line bound alone
  // is not a bound: 64 MiB with no newline is still exactly one line.
  const blob = "x".repeat(200_000);
  const tail = boundedTail(blob, { maxLines: 40, maxBytes: 1024 });
  assert.equal(Buffer.byteLength(tail, "utf8"), 1024, "must be cut to the byte bound");
  assert.ok(blob.endsWith(tail), "the END of the output is what is kept");
});

test("boundedTail keeps the last lines when they fit, and never splits a character", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const tail = boundedTail(lines, { maxLines: 3, maxBytes: 16 * 1024 });
  assert.equal(tail, "line 97\nline 98\nline 99");

  // A byte cut landing mid-character must drop the partial bytes, not decode
  // them into U+FFFD.
  const cjk = "\u4e2d".repeat(500); // 1500 bytes
  const cut = boundedTail(cjk, { maxLines: 40, maxBytes: 1000 });
  assert.ok(!cut.includes("\uFFFD"), "no replacement characters at the cut");
  assert.ok(cjk.endsWith(cut), "still a suffix of the original");
  assert.ok(Buffer.byteLength(cut, "utf8") <= 1000);
});

test("the capture cap counts BYTES, not decoded UTF-16 length", () => {
  // A decoded JS string is UTF-16 code units: CJK is 3 UTF-8 bytes per unit, so
  // counting decoded length would let ~3x the cap through. 10-byte cap, fed
  // four 3-byte characters = 12 bytes.
  const cap = createCaptureAccumulator(10);
  cap.push(3, "\u4e2d");
  cap.push(3, "\u6587");
  assert.equal(cap.truncated, false, "6 bytes is under the cap");
  cap.push(3, "\u5b57");
  cap.push(3, "\u7b26");
  assert.equal(cap.bytes, 12);
  assert.equal(cap.truncated, true, "12 bytes exceeds the 10-byte cap");
  assert.match(cap.text, /output truncated/, "the marker must be appended once");
  assert.equal(cap.text.match(/output truncated/g)?.length, 1);
});

test("the cap is a chunk-boundary bound, and what LEAVES is strictly bounded", () => {
  // The crossing chunk is kept whole (already in memory; cutting it would split
  // a line or a surrogate pair for no benefit), so `text` may exceed maxBytes.
  // The strict bound belongs to what is published — boundedTail.
  const cap = createCaptureAccumulator(10);
  cap.push(64, "y".repeat(64));
  assert.equal(cap.truncated, true);
  assert.ok(cap.text.length > 10, "documented: the crossing chunk is kept whole");

  const published = boundedTail(cap.text, { maxLines: 40, maxBytes: 16 });
  assert.ok(Buffer.byteLength(published, "utf8") <= 16, "the published copy IS strictly bounded");
});

test("chunks after truncation are dropped, but the decoder remainder still lands", () => {
  const cap = createCaptureAccumulator(4);
  cap.push(6, "overflow");
  assert.equal(cap.truncated, true);
  const afterMarker = cap.text;

  cap.push(100, "MUST-NOT-APPEAR");
  assert.equal(cap.text, afterMarker, "post-truncation chunks are ignored");

  // The remainder is at most a few bytes of a character the child was killed
  // inside; dropping it silently is how an aborted run loses its last line.
  cap.flush("\u25b6");
  assert.ok(cap.text.endsWith("\u25b6"), "the decoder remainder is appended even after truncation");
});

test("every accepted fragment is streamed to onText exactly once", () => {
  const seen: string[] = [];
  const cap = createCaptureAccumulator(1024, (t) => seen.push(t));
  cap.push(1, "a");
  cap.push(0, "");   // empty decode (a buffered partial character) emits nothing
  cap.push(1, "b");
  cap.flush("");
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(cap.text, "ab");
});

// ---------------------------------------------------------------------------
// Config selection — the query must describe the SAME config the run uses
// ---------------------------------------------------------------------------

test("hasJestConfigSelection detects every explicit selection, both spellings", () => {
  for (const body of [
    "jest --config custom.json",
    "jest --config=custom.json",
    "jest -c cfg.js",
    "jest --rootDir src",
    "jest --projects pkg-a pkg-b",
    "jest --selectProjects api web",
    "jest --roots src test",
    // Verified against jest-cli's own args.js: --ignoreProjects selects the
    // effective project set exactly as --selectProjects does.
    "jest --ignoreProjects legacy",
    "jest --ci --config custom.json --runInBand",
  ]) {
    assert.equal(hasJestConfigSelection(splitTokens(body)), true, `must detect selection in: ${body}`);
  }
});

test("hasJestConfigSelection is false for default config discovery", () => {
  for (const body of ["jest", "jest --ci", "jest --runInBand --silent", "jest test/foo.test.ts"]) {
    assert.equal(hasJestConfigSelection(splitTokens(body)), false, `must NOT claim selection in: ${body}`);
  }
  assert.equal(hasJestConfigSelection(undefined as unknown as string[]), false);
});

test("a multi-line script body is NOT a single simple command", () => {
  // npm script bodies may contain newlines and /bin/sh runs each line as its
  // own command. Treating them as one invocation let flags belonging to a
  // DIFFERENT command be read as jest's own.
  assert.equal(parseTestScript("jest\nsomething-else --config other.json"), null);
  assert.equal(parseTestScript("jest --ci\r\necho done"), null);
  // The single-line form still parses.
  assert.equal(parseTestScript("jest --ci")?.runner, "jest");
});

test("hasJestConfigSelection stops at `--` (end of jest's own options)", () => {
  // After `--`, tokens are path filters for the tests, so a --config there is
  // not jest's configuration.
  assert.equal(hasJestConfigSelection(splitTokens("jest -- --config theirs.json")), false);
  // A real selection BEFORE the separator still counts.
  assert.equal(hasJestConfigSelection(splitTokens("jest --config ours.json -- extra")), true);
});

test("a repo pattern that merely CONTAINS .pi does not suppress the exclusion", () => {
  // Substring matching here was a real defect: `.pipeline/` is not our
  // exclusion, and treating it as one leaves .pi/review-snapshots/ in the scan.
  for (const unrelated of ["<rootDir>/.pipeline/", "<rootDir>/.pixi/", "spec/.pixel/", "/node_modules/.pift/"]) {
    const args = jestIgnoreArgs([unrelated]);
    assert.match(args, /--testPathIgnorePatterns '<rootDir>\/\.pi\/'/,
      `the gate exclusion must still be added alongside ${unrelated}`);
    assert.ok(args.includes(shellQuote(unrelated)), "the repo's own pattern must survive");
  }
});

test("injection happens only for a single jest command", () => {
  const ignoreArgs = jestIgnoreArgs(["/node_modules/"]);
  const injected = maybeInjectJestIgnore({ command: "npm run test", body: "jest", pm: "npm", ignoreArgs });
  assert.equal(injected.injected, true);
  assert.match(injected.command, /^npm run test -- --testPathIgnorePatterns /, "npm needs -- to forward args");
});

test("non-npm package managers forward args without the -- separator", () => {
  const ignoreArgs = jestIgnoreArgs([]);
  const injected = maybeInjectJestIgnore({ command: "bun run test", body: "jest --ci", pm: "bun", ignoreArgs });
  assert.equal(injected.injected, true);
  assert.ok(!injected.command.includes(" -- "), "bun forwards directly");
});

test("compound and non-jest scripts are never rewritten", () => {
  const ignoreArgs = jestIgnoreArgs([]);
  for (const body of ["jest && tsc", "vitest run", "node --test test/*.test.ts", "jest | tee out.log"]) {
    const injected = maybeInjectJestIgnore({ command: "npm run test", body, pm: "npm", ignoreArgs });
    assert.equal(injected.injected, false, `must not rewrite: ${body}`);
    assert.equal(injected.command, "npm run test", "command must be untouched");
    assert.match(injected.reason ?? "", /not a single jest command/);
  }
});

test("no ignore args (showConfig unavailable) means no CLI override at all", () => {
  // Fail-safe direction: injecting only `.pi` would REPLACE the repo's own
  // testPathIgnorePatterns (jest CLI overrides config), silently running
  // suites the project deliberately excludes.
  const injected = maybeInjectJestIgnore({ command: "npm run test", body: "jest", pm: "npm", ignoreArgs: "" });
  assert.equal(injected.injected, false);
  assert.equal(injected.command, "npm run test");
  assert.match(injected.reason ?? "", /unavailable/);
});

test("runTestsByPathCommand appends the ignore args when given", () => {
  const cmd = runTestsByPathCommand({
    env: "", bin: "jest", flags: ["--ci"], files: ["test/a.test.ts"], ignore: "--testPathIgnorePatterns '<rootDir>/.pi/'",
  });
  assert.match(cmd, /--runTestsByPath 'test\/a\.test\.ts' --testPathIgnorePatterns '<rootDir>\/\.pi\/'/);
  const plain = runTestsByPathCommand({ env: "", bin: "jest", flags: [], files: ["test/a.test.ts"] });
  assert.ok(!plain.includes("testPathIgnorePatterns"), "no ignore args → unchanged command");
});
