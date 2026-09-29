/**
 * The acceptance round's SCOPE (lib/acceptance-scope.ts, 2026-09-29): a
 * docs/tests-only change dispatches nothing, a READY survives one, and a round
 * after a READY is told what changed since — against a real git repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acceptanceDecision, buildAcceptanceTask, sanitizeAcceptanceRecord, type AcceptanceRecord } from "../lib/acceptance-round.ts";
import { filesSince, needsAcceptance } from "../lib/acceptance-scope.ts";
import { git } from "./helpers/git.ts";

const AT = "2026-09-29T00:00:00.000Z";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

test("only a positive doc or test is exempt from acceptance", () => {
  for (const p of ["lib/a.ts", "src/x.py", "scripts/run.sh", "lib/testing.ts", "lib/contest/a.ts", "package.json", "db/m.sql", "hooks/pre-push"]) {
    assert.equal(needsAcceptance(p), true, p);
  }
  for (const p of ["test/a.test.ts", "tests/x.py", "src/__tests__/a.ts", "lib/a.test.ts", "web/b.spec.tsx", "README.md", "docs/x.mdx"]) {
    assert.equal(needsAcceptance(p), false, p);
  }
});

test("a docs/tests-only scope: SKIPPED without a READY, the READY carried over with one", () => {
  const base = { hasCodeChange: true, gateOpen: true, fingerprint: "fp-2", scopeFiles: ["README.md", "test/a.test.ts"] };
  const skipped = acceptanceDecision(base);
  assert.equal(skipped.action === "skip" && skipped.status, "SKIPPED");
  assert.match(skipped.reason, /文档 \/ 测试/);
  const ready: AcceptanceRecord = { status: "READY", verdict: "READY", fingerprint: "fp-1", head: HEAD, at: AT };
  assert.equal(acceptanceDecision({ ...base, record: ready }).action, "pass", "the old READY still answers");
  assert.equal(acceptanceDecision({ ...base, scopeFiles: [] }).action, "skip", "an empty scope has nothing to run");
  assert.equal(acceptanceDecision({ ...base, scopeFiles: ["lib/a.ts"], record: ready }).action, "dispatch");
  assert.equal(acceptanceDecision({ hasCodeChange: true, gateOpen: true, fingerprint: "fp-2" }).action, "dispatch",
    "an unknown scope keeps the stricter old behaviour");
});

test("the record keeps its head; a malformed one is dropped", () => {
  assert.equal(sanitizeAcceptanceRecord({ status: "READY", at: AT, head: HEAD })?.head, HEAD);
  assert.equal(sanitizeAcceptanceRecord({ status: "READY", at: AT, head: "; rm -rf /" })?.head, undefined);
});

test("an incremental task names the accepted head and only the changed files", () => {
  const task = buildAcceptanceTask({
    repoRoot: "/repo",
    goalText: "# t\n真实验收方案：\n  - 正向：起服务\n非目标：\n",
    sinceAccepted: { head: HEAD, files: ["lib/a.ts"] },
  });
  assert.match(task, /INCREMENTAL ROUND/);
  assert.match(task, /<since_accepted>[\s\S]*lib\/a\.ts/);
  assert.doesNotMatch(buildAcceptanceTask({ repoRoot: "/repo", goalText: "# t" }), /INCREMENTAL/);
});

test("filesSince sees committed, uncommitted and untracked changes since the base", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-acc-scope-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "g@example.com"]);
    git(dir, ["config", "user.name", "g"]);
    writeFileSync(join(dir, "a.ts"), "1\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
    const base = git(dir, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, "README.md"), "x\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "docs"]);
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "test", "a.test.ts"), "t\n");
    assert.deepEqual(filesSince(dir, base)?.sort(), ["README.md", "test/a.test.ts"]);
    assert.equal(filesSince(dir, undefined), undefined, "no base ⇒ unknown");
    assert.equal(filesSince(dir, "nope"), undefined, "an unreadable base ⇒ unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
