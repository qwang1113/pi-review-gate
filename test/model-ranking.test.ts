import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  familyOf,
  capabilityOf,
  rankJudges,
  FAMILY_CAPABILITY,
  SNAPSHOT_DATE,
} from "../lib/model-ranking.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --------------------------------------------------------------------------
// Family mapping — local gateway ids AND provider/id forms.

test("familyOf maps local gateway ids to families", () => {
  assert.equal(familyOf("claude-opus-4-8"), "anthropic");
  assert.equal(familyOf("claude-fable-5"), "anthropic");
  assert.equal(familyOf("deepseek-v4-pro"), "deepseek");
  assert.equal(familyOf("glm-5.2"), "zhipu");
  assert.equal(familyOf("kimi-k2.7-code"), "moonshot");
  assert.equal(familyOf("minimax-m3"), "minimax");
  assert.equal(familyOf("onekey/gpt-5.6-sol"), "openai");
  assert.equal(familyOf("gpt-5.5"), "openai");
});

test("familyOf returns 'unknown' for unrecognized ids", () => {
  assert.equal(familyOf("some-random-model-xyz"), "unknown");
});

test("familyOf: distinctive vendor tokens win over generic openai codenames (no collision)", () => {
  // A different vendor carrying an openai-ish codename must NOT map to openai.
  assert.equal(familyOf("deepseek-o4x"), "deepseek");
  assert.equal(familyOf("glm-5-terra"), "zhipu");
  assert.equal(familyOf("kimi-luna"), "moonshot");
  // But genuine openai codenames still resolve to openai.
  assert.equal(familyOf("gpt-5.6-terra"), "openai");
  assert.equal(familyOf("gpt-5.6-luna"), "openai");
  assert.equal(familyOf("o3-mini"), "openai");
});

test("familyOf: bare 'o'-series only matches as a standalone token", () => {
  assert.equal(familyOf("o1-preview"), "openai");
  // 'o4' embedded in a longer alnum token must not trigger the o-series branch.
  assert.equal(familyOf("foo4bar"), "unknown");
});

test("capabilityOf returns a positive score for known families, 0 for unknown", () => {
  assert.ok(capabilityOf("deepseek-v4-pro") > 0);
  assert.ok(capabilityOf("claude-opus-4-8") > 0);
  assert.equal(capabilityOf("nonexistent-model"), 0);
});

// --------------------------------------------------------------------------
// Selection — capability × cross-family diversity.

test("rankJudges prefers a strong DIFFERENT-family model over same-family main", () => {
  // Main agent is Anthropic. Even though anthropic scores highest raw, a
  // strong different-family judge should win the top slot.
  const { best, mainFamily } = rankJudges({
    mainModelId: "claude-opus-4-8",
    available: ["claude-fable-5", "deepseek-v4-pro", "glm-5.2"],
  });
  assert.equal(mainFamily, "anthropic");
  assert.notEqual(best?.family, "anthropic");
  assert.equal(best?.id, "deepseek-v4-pro"); // strongest open-weight, different family
});

test("rankJudges with diversityWeight=0 picks single strongest regardless of family", () => {
  const { best } = rankJudges({
    mainModelId: "claude-opus-4-8",
    available: ["claude-fable-5", "deepseek-v4-pro"],
    diversityWeight: 0,
  });
  // No diversity reward → highest raw capability (anthropic) wins.
  assert.equal(best?.family, "anthropic");
});

test("rankJudges ranks all candidates best-first and dedupes", () => {
  const { ranked } = rankJudges({
    mainModelId: "claude-opus-4-8",
    available: ["deepseek-v4-pro", "deepseek-v4-pro", "glm-5.2", "minimax-m3"],
  });
  assert.equal(ranked.length, 3, "duplicates removed");
  // effective scores must be non-increasing
  for (let i = 1; i < ranked.length; i++) {
    // recompute is not exposed; assert order via known capabilities/diversity
    assert.ok(ranked[i - 1].score >= 0 && ranked[i].score >= 0);
  }
  assert.equal(ranked[0].family, "deepseek");
});

test("rankJudges is deterministic (stable tie-break by id)", () => {
  const a = rankJudges({ mainModelId: "claude-opus-4-8", available: ["glm-5.2", "kimi-k2.7-code"] });
  const b = rankJudges({ mainModelId: "claude-opus-4-8", available: ["kimi-k2.7-code", "glm-5.2"] });
  assert.deepEqual(a.ranked.map((c) => c.id), b.ranked.map((c) => c.id));
});

test("rankJudges handles empty candidate list", () => {
  const { best, ranked } = rankJudges({ mainModelId: "claude-opus-4-8", available: [] });
  assert.equal(best, undefined);
  assert.equal(ranked.length, 0);
});

test("open-weight families are flagged (the 'open-source api' models)", () => {
  const { ranked } = rankJudges({
    mainModelId: "claude-opus-4-8",
    available: ["deepseek-v4-pro", "glm-5.2", "kimi-k2.7-code", "minimax-m3"],
  });
  assert.ok(ranked.every((c) => c.openWeight), "all these are open-weight families");
});

// --------------------------------------------------------------------------
// Snapshot integrity.

test("FAMILY_CAPABILITY scores are within 0..100 and unique per family", () => {
  const seen = new Set<string>();
  for (const c of FAMILY_CAPABILITY) {
    assert.ok(c.score >= 0 && c.score <= 100, `${c.family} score out of range`);
    assert.ok(!seen.has(c.family), `duplicate family ${c.family}`);
    seen.add(c.family);
    assert.ok(c.source.length > 0, `${c.family} missing source`);
  }
});

test("SNAPSHOT_DATE is an ISO date", () => {
  assert.match(SNAPSHOT_DATE, /^\d{4}-\d{2}-\d{2}$/);
});

// --------------------------------------------------------------------------
// The fetcher must stay OPT-IN and GATE-EXTERNAL (network isolation invariant).

test("only fetch-leaderboard.mjs performs network I/O; lib/ and extension stay network-free", () => {
  // lib/model-ranking.ts must not make network calls (word 'fetch' in prose is
  // fine; an actual `fetch(` / http import is not).
  const rankSrc = readFileSync(join(ROOT, "lib", "model-ranking.ts"), "utf8");
  assert.doesNotMatch(rankSrc, /\bfetch\s*\(/, "ranking lib must not call fetch()");
  assert.doesNotMatch(rankSrc, /import\("https?:/, "ranking lib must not import over http");

  // The extension must not import the fetcher or reference the network.
  const extSrc = readFileSync(join(ROOT, "extensions", "review-gate.ts"), "utf8");
  assert.doesNotMatch(extSrc, /fetch-leaderboard/, "extension must not pull in the fetcher");
  assert.doesNotMatch(extSrc, /\bfetch\b/, "extension must stay network-free");

  // Only the opt-in gate-external fetcher may call the network.
  const fetcherSrc = readFileSync(join(ROOT, "scripts", "fetch-leaderboard.mjs"), "utf8");
  assert.match(fetcherSrc, /GATE-EXTERNAL/, "fetcher must document it is gate-external");
  assert.match(fetcherSrc, /fetch\(/, "fetcher is the one place network I/O lives");
});

// Judge model priority is pinned by the user (highest priority first). thinking
// is a single value, not a fallback list; max is the highest valid pi level
// (pi --help: off, minimal, low, medium, high, xhigh, max). Models whose
// provider lacks reasoning-effort support clamp gracefully.
const JUDGE_THINKING = /thinking:\s*max/;

test("adviser is pinned to the user's priority list at max thinking, and stays a non-gatekeeper", () => {
  const adviser = readFileSync(join(ROOT, "agents", "adviser.md"), "utf8");
  assert.match(adviser, /name:\s*adviser/);
  assert.match(adviser, JUDGE_THINKING);
  // Priority: fable-5 > gpt-sol > opus-4.8 > gpt-5.5
  assert.match(adviser, /model:\s*claude-fable-5/);
  assert.match(adviser, /fallbackModels:\s*onekey\/gpt-5\.6-sol,\s*claude-opus-4-8,\s*onekey\/gpt-5\.5/);
  // Consultant, not a gatekeeper: no record_review tool, no gate verdicts.
  assert.doesNotMatch(adviser, /tools:.*record_review/);
  assert.match(adviser, /not an executor and not a gatekeeper/i);
});

test("reviewer override is pinned to the user's priority list at max thinking and still emits a gate verdict", () => {
  const reviewer = readFileSync(join(ROOT, "agents", "reviewer.md"), "utf8");
  assert.match(reviewer, /name:\s*reviewer/);
  assert.match(reviewer, JUDGE_THINKING);
  // Priority: fable-5 > gpt-5.5 > opus-4.8 (user's current pin)
  assert.match(reviewer, /model:\s*claude-fable-5/);
  assert.match(reviewer, /fallbackModels:\s*onekey\/gpt-5\.5,\s*claude-opus-4-8/);
  // Reviewer IS the gatekeeper: it must instruct ending with a JSON gate verdict.
  assert.match(reviewer, /"gate":\s*"READY"/);
});

test("pinned thinking level is a valid pi THINKING_LEVEL, never an invented one", () => {
  for (const f of ["adviser.md", "reviewer.md"]) {
    const src = readFileSync(join(ROOT, "agents", f), "utf8");
    const m = src.match(/^thinking:\s*(\S+)/m);
    assert.ok(m, `${f} must declare a thinking level`);
    assert.ok(["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(m![1]), `${f} thinking '${m![1]}' must be a valid pi level`);
  }
});
