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
  detectsMdConsumingBuild,
  intersectWithScriptPaths,
  isDocFile,
  narrowableFlags,
  parseTestScript,
  planFastTests,
  runTestsByPathCommand,
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
