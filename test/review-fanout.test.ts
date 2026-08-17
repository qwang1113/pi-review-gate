import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bareModelId,
  isJudgeEligible,
  planReviewFanout,
  formatFanoutPlan,
  formatFanoutDirective,
  judgeCandidatesFromFacts,
  planFanoutFromFacts,
  NON_JUDGE_MODEL_IDS,
  type JudgeFacts,
} from "../lib/review-fanout.ts";

const facts = (
  models: Array<{ provider: string; id: string }>,
  authed: string[],
  allowed: (m: { provider: string; id: string }) => boolean = () => true,
): JudgeFacts => ({ models, authedProviders: new Set(authed), allowed });

test("bareModelId strips provider prefix and thinking suffix", () => {
  assert.equal(bareModelId("claude-fable-5"), "claude-fable-5");
  assert.equal(bareModelId("anthropic/claude-fable-5"), "claude-fable-5");
  assert.equal(bareModelId("anthropic/claude-fable-5:max"), "claude-fable-5");
  assert.equal(bareModelId("opencode-go/deepseek-v4-flash"), "deepseek-v4-flash");
});

test("the cheap flash tier is never judge-eligible, however it is spelled", () => {
  assert.ok(NON_JUDGE_MODEL_IDS.includes("deepseek-v4-flash"));
  for (const spec of ["deepseek-v4-flash", "opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-flash:max"]) {
    assert.equal(isJudgeEligible(spec), false, spec);
  }
  assert.equal(isJudgeEligible("claude-fable-5"), true);
  assert.equal(isJudgeEligible("onekey/gpt-5.6-sol"), true);
});

test("two judge-eligible families ⇒ cross-family pair, one per family, no note", () => {
  const plan = planReviewFanout(["claude-fable-5", "claude-opus-5", "onekey/gpt-5.6-sol"]);
  assert.equal(plan.crossFamily, true);
  assert.equal(plan.reviewers.length, 2);
  assert.deepEqual(plan.families, ["anthropic", "openai"]);
  // The caller's preference order wins WITHIN a family: opus must not displace fable.
  assert.equal(plan.reviewers[0], "claude-fable-5");
  assert.equal(plan.reviewers[1], "onekey/gpt-5.6-sol");
  assert.equal(plan.note, undefined, "a real cross-family pair needs no fallback note");
});

test("REGRESSION: one family ⇒ ONE reviewer plus a mandatory declared note", () => {
  // The observed waste: this host has anthropic + opencode-go/flash, so after
  // excluding the cheap tier there is exactly one judge family — yet two
  // same-family reviewers were spawned, doubling cost for zero diversity.
  const plan = planReviewFanout(["claude-fable-5", "claude-opus-5", "opencode-go/deepseek-v4-flash"]);
  assert.equal(plan.crossFamily, false);
  assert.deepEqual(plan.reviewers, ["claude-fable-5"]);
  assert.deepEqual(plan.families, ["anthropic"]);
  assert.ok(plan.note, "a single-reviewer fallback MUST carry a note");
  assert.match(plan.note!, /Only ONE judge-eligible model family/);
  assert.match(plan.note!, /SINGLE reviewer/);
});

test("no judge-eligible model ⇒ no reviewers and an explicit warning note", () => {
  const plan = planReviewFanout(["opencode-go/deepseek-v4-flash"]);
  assert.deepEqual(plan.reviewers, []);
  assert.deepEqual(plan.families, []);
  assert.equal(plan.crossFamily, false);
  assert.match(plan.note!, /NO judge-eligible model/);
});

test("empty availability is handled like no judge-eligible model", () => {
  const plan = planReviewFanout([]);
  assert.deepEqual(plan.reviewers, []);
  assert.ok(plan.note);
});

test("families are ordered by capability so the strongest judge leads", () => {
  // qwen scores below anthropic in the snapshot, so anthropic must lead
  // regardless of input order.
  const plan = planReviewFanout(["qwen-3-max", "claude-fable-5"]);
  assert.deepEqual(plan.families, ["anthropic", "qwen"]);
  assert.equal(plan.reviewers[0], "claude-fable-5");
});

test("more than two families still dispatches exactly two", () => {
  const plan = planReviewFanout(["claude-fable-5", "onekey/gpt-5.6-sol", "glm-5.3", "grok-4.6"]);
  assert.equal(plan.reviewers.length, 2);
  assert.equal(new Set(plan.families).size, 2);
});

test("REGRESSION: family ranking scores the FAMILY, not its name re-parsed as a model id", () => {
  // capabilityOf() expects a MODEL ID: familyOf("meta") is "unknown" (the id
  // tokens are `meta-`/`llama`), so ranking family NAMES through it scored
  // meta 0 and dropped it below weaker families. Live repro of the bug:
  const plan = planReviewFanout(["llama-5-405b", "mistral-large-3", "glm-5.3"]);
  // meta 78 > zhipu 84? no — zhipu leads, then meta (78) must beat mistral (76).
  assert.deepEqual(plan.families, ["zhipu", "meta"]);
  assert.equal(plan.reviewers[1], "llama-5-405b");
});

test("a lone UNRECOGNIZED family says so instead of claiming a known single family", () => {
  const plan = planReviewFanout(["vendor-x-ultra", "vendor-y-ultra"]);
  assert.equal(plan.crossFamily, false, "unknown vendors collapse into one family — stay conservative");
  assert.match(plan.note!, /unrecognized/i);
  assert.match(plan.note!, /may be higher than this plan can prove/);
});

test("formatFanoutPlan states plainly whether the pair is real", () => {
  const pair = planReviewFanout(["claude-fable-5", "onekey/gpt-5.6-sol"]);
  assert.match(formatFanoutPlan(pair), /cross-family pair/);
  const single = planReviewFanout(["claude-fable-5"]);
  assert.match(formatFanoutPlan(single), /SINGLE \(fallback\)/);
  assert.match(formatFanoutPlan(planReviewFanout([])), /NONE/);
});

test("judgeCandidatesFromFacts keeps only authed + allowed + judge-tier models", () => {
  const f = facts(
    [
      { provider: "anthropic", id: "claude-fable-5" },
      { provider: "anthropic", id: "claude-opus-5" },
      { provider: "opencode-go", id: "deepseek-v4-flash" }, // cheap tier: never judges
      { provider: "opencode-go", id: "deepseek-v4-pro" }, // allowlist refuses it
      { provider: "onekey", id: "gpt-5.6-sol" }, // provider not authenticated
    ],
    ["anthropic", "opencode-go"],
    (m) => !(m.provider === "opencode-go" && m.id !== "deepseek-v4-flash"),
  );
  assert.deepEqual(judgeCandidatesFromFacts(f), [
    "anthropic/claude-fable-5",
    "anthropic/claude-opus-5",
  ]);
});

test("REGRESSION: this host (anthropic + flash only) plans exactly ONE reviewer", () => {
  // The environment that produced the observed waste: two same-family
  // reviewers were spawned and billed as a cross-family pair.
  const plan = planFanoutFromFacts(
    facts(
      [
        { provider: "anthropic", id: "claude-fable-5" },
        { provider: "anthropic", id: "claude-opus-5" },
        { provider: "opencode-go", id: "deepseek-v4-flash" },
      ],
      ["anthropic", "opencode-go"],
    ),
  );
  assert.ok(plan);
  assert.equal(plan!.crossFamily, false);
  assert.equal(plan!.reviewers.length, 1);
  assert.ok(plan!.note);
});

test("two authed families plan a real cross-family pair", () => {
  const plan = planFanoutFromFacts(
    facts(
      [
        { provider: "anthropic", id: "claude-fable-5" },
        { provider: "onekey", id: "gpt-5.6-sol" },
      ],
      ["anthropic", "onekey"],
    ),
  );
  assert.ok(plan);
  assert.equal(plan!.crossFamily, true);
  assert.deepEqual(plan!.families, ["anthropic", "openai"]);
  assert.equal(plan!.note, undefined);
});

test("an EMPTY registry yields no plan at all (unknown ≠ none)", () => {
  // Silence is mandatory here: an unreadable registry must never be reported
  // as "this host has no judge" — that false alarm once claimed every
  // built-in chain was unavailable while the review was running on one.
  assert.equal(planFanoutFromFacts(facts([], [])), undefined);
});

test("a known registry with no judge-eligible model DOES report none", () => {
  const plan = planFanoutFromFacts(
    facts([{ provider: "opencode-go", id: "deepseek-v4-flash" }], ["opencode-go"]),
  );
  assert.ok(plan);
  assert.deepEqual(plan!.reviewers, []);
  assert.match(plan!.note!, /NO judge-eligible model/);
});

test("formatFanoutDirective tells the agent the COUNT and carries the note", () => {
  const single = formatFanoutDirective(planReviewFanout(["claude-fable-5"]));
  assert.match(single, /SINGLE reviewer/);
  assert.match(single, /Do NOT spawn a second reviewer/);
  assert.match(single, /Copy this note into the recorded review/);

  const pair = formatFanoutDirective(planReviewFanout(["claude-fable-5", "onekey/gpt-5.6-sol"]));
  assert.match(pair, /CROSS-FAMILY PAIR/);
  assert.match(pair, /anthropic, openai/);
  assert.doesNotMatch(pair, /Copy this note/, "a real pair has no fallback note to copy");

  const none = formatFanoutDirective(planReviewFanout([]));
  assert.match(none, /NONE/);
  assert.match(none, /gate stays CLOSED/i, "a missing judge must never read as permission to ship");
});
