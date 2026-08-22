import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bareModelId,
  isJudgeEligible,
  planReviewFanout,
  planSlottedReviewFanout,
  formatFanoutPlan,
  formatFanoutDirective,
  judgeCandidatesFromFacts,
  planFanoutFromFacts,
  planConfiguredReviewFanout,
  NON_JUDGE_MODEL_IDS,
  type JudgeFacts,
} from "../lib/review-fanout.ts";

const facts = (
  models: Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }>,
  authed: string[],
  allowed: (m: { provider: string; id: string }) => boolean = () => true,
): JudgeFacts => ({ models, authedProviders: new Set(authed), allowed });

test("bareModelId strips provider prefix and thinking suffix", () => {
  assert.equal(bareModelId("claude-fable-5"), "claude-fable-5");
  assert.equal(bareModelId("anthropic/claude-fable-5"), "claude-fable-5");
  assert.equal(bareModelId("anthropic/claude-fable-5:max"), "claude-fable-5");
  assert.equal(bareModelId("opencode-go/deepseek-v4-flash"), "deepseek-v4-flash");
});

test("REGRESSION: slash-containing ids keep their id (first-slash provider split)", () => {
  // Round-2 P1: bareModelId took the LAST slash segment, rewriting
  // openrouter/deepseek/v4-flash into "v4-flash" — the slotted fan-out then
  // silently skipped a legal slot. The provider split is the FIRST slash,
  // mirroring lib/model-config parseModelSpec.
  assert.equal(bareModelId("openrouter/deepseek/v4-flash"), "deepseek/v4-flash");
  assert.equal(bareModelId("/gpt-5.6-sol"), "/gpt-5.6-sol", "a leading slash is malformed, not a provider");
  const f = facts(
    [
      { provider: "p", id: "foo/bar" },
      { provider: "anthropic", id: "claude-fable-5" },
    ],
    ["p", "anthropic"],
  );
  const plan = planSlottedReviewFanout(f, ["p/foo/bar", "anthropic/claude-fable-5"]);
  assert.deepEqual(plan.reviewers, ["p/foo/bar", "anthropic/claude-fable-5"], "a slash-containing slot must be selected, not skipped");
});

test("REGRESSION: a provider-less ambiguous id is skipped, never picked by registry order", () => {
  // Round-4 P1: validateSpec refuses a bare id that exists under several
  // providers; the fan-out used matches[0] and could deploy a provider the
  // renderer would reject.
  const f = facts(
    [
      { provider: "a", id: "duo-model" },
      { provider: "b", id: "duo-model" },
      { provider: "anthropic", id: "claude-fable-5" },
    ],
    ["a", "b", "anthropic"],
  );
  const plan = planSlottedReviewFanout(f, ["duo-model", "anthropic/claude-fable-5"]);
  assert.deepEqual(plan.reviewers, ["anthropic/claude-fable-5"], "the ambiguous bare id must not be selected");
  const f2 = facts([{ provider: "a", id: "solo-model" }, { provider: "anthropic", id: "claude-fable-5" }], ["a", "anthropic"]);
  const solo = planSlottedReviewFanout(f2, ["solo-model", "anthropic/claude-fable-5"]);
  assert.deepEqual(solo.reviewers, ["a/solo-model", "anthropic/claude-fable-5"], "an UNambiguous bare id still works");
});

test("REGRESSION: provider-less ambiguity counts UNAUTHENTICATED providers too", () => {
  // Round-6 P1: the ambiguity check ran on the auth-filtered list, so with
  // a/m and b/m but only "a" authenticated, bare "m" was selected — while
  // validateSpec refuses it (registry-wide ambiguity, pre-auth).
  const f = facts(
    [
      { provider: "a", id: "m" },
      { provider: "b", id: "m" },
      { provider: "anthropic", id: "claude-fable-5" },
    ],
    ["a", "anthropic"], // "b" NOT authenticated
  );
  const plan = planSlottedReviewFanout(f, ["m", "anthropic/claude-fable-5"]);
  assert.deepEqual(plan.reviewers, ["anthropic/claude-fable-5"], "the ambiguous bare id must be skipped even when only one provider is authed");
  assert.match(plan.note ?? "", /no provider prefix and exists under several providers/i, "the note explains the skip with its TRUE reason");
});

test("REGRESSION: :off null-mapped by the model is refused (validateSpec parity)", () => {
  // Verified by direct validateSpec call: a map that EXPLICITLY nulls `off`
  // refuses the :off spec — the fan-out must agree (deployed = planned).
  const f = facts(
    [{ provider: "a", id: "m", thinkingLevelMap: { off: null } }, { provider: "anthropic", id: "claude-fable-5" }],
    ["a", "anthropic"],
  );
  const plan = planSlottedReviewFanout(f, ["a/m:off", "anthropic/claude-fable-5"]);
  assert.deepEqual(plan.reviewers, ["anthropic/claude-fable-5"], "the null-mapped :off slot is skipped");
  assert.ok(plan.note?.includes("a/m:off"), "the skip is named in the note");
});

test("REGRESSION: reasoning:false + :off survives a null off mapping (round-8 fix)", () => {
  // validateSpec short-circuits reasoning:false to `level === "off"` WITHOUT
  // consulting the map — the fan-out used to still read the map's null and
  // skip the slot (deployed ≠ planned). Mutation-killing: removing the
  // skip-map special case must fail this test.
  const f = facts(
    [{ provider: "p", id: "plain", reasoning: false, thinkingLevelMap: { off: null } }],
    ["p"],
  );
  const plan = planSlottedReviewFanout(f, ["p/plain:off"]);
  assert.deepEqual(plan.reviewers, ["p/plain:off"], "the :off slot on a reasoning:false model is planned despite the null map");
  assert.ok(!plan.note?.includes("p/plain:off"), "no unsupported-level skip may be recorded for it");
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
      // reasoning:false is the AUTO path's own guard: such a model cannot be
      // asked for a thinking level, so it must never be seated as a default
      // judge candidate (round-12 R2 P1: deleting that guard left the whole
      // suite green). A user may still pin it EXPLICITLY via slots — that is
      // the slotted path, covered separately.
      { provider: "anthropic", id: "claude-noreason-9", reasoning: false },
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
  // round-3 P1: the DEFAULT path must NOT name concrete specs — the pin in
  // the agent file stays the single source of truth there.
  assert.doesNotMatch(single, /Picked reviewer/, "default path must not override the agent-file pin");
  assert.match(single, /Do NOT spawn a second reviewer/);
  assert.match(single, /Copy this note into the recorded review/);

  const pair = formatFanoutDirective(planReviewFanout(["claude-fable-5", "onekey/gpt-5.6-sol"]));
  assert.match(pair, /CROSS-FAMILY PAIR/);
  assert.match(pair, /anthropic, openai/);
  assert.doesNotMatch(pair, /Picked reviewers/, "default path must not name specs (round-3 P1)");
  assert.doesNotMatch(pair, /Copy this note/, "a real pair has no fallback note to copy");

  // The SLOT path DOES name the picked specs (they are the user's own pin).
  const slotted = planSlottedReviewFanout(SLOT_FACTS, ["onekey/gpt-5.6-sol", "claude-fable-5"]);
  slotted.slotSource = "REVIEWER SLOT SOURCE: project";
  const slottedOut = formatFanoutDirective(slotted);
  assert.match(
    slottedOut,
    /Picked reviewers: onekey\/gpt-5\.6-sol, anthropic\/claude-fable-5/,
    "the exact picked pair must reach the agent on the slot path (same-family duplicates make family names ambiguous)",
  );

  const none = formatFanoutDirective(planReviewFanout([]));
  assert.match(none, /NONE/);
  assert.match(none, /gate stays CLOSED/i, "a missing judge must never read as permission to ship");
});

const SLOT_FACTS = facts(
  [
    { provider: "anthropic", id: "claude-fable-5" },
    { provider: "anthropic", id: "claude-opus-5" },
    { provider: "onekey", id: "gpt-5.6-sol" },
    { provider: "onekey", id: "gpt-5.5" },
    { provider: "onekey", id: "glm-5.3" },
    { provider: "zhipu", id: "glm-5.3" },
    { provider: "xai", id: "grok-4.6" },
    { provider: "opencode-go", id: "deepseek-v4-flash" },
  ],
  ["anthropic", "onekey", "xai", "opencode-go"],
);

test("formatFanoutDirective renders the slotSource line first on slot-driven plans", () => {
  // REGRESSION (round-1 P1): the injected directive must tell the agent WHICH
  // layer and WHICH slots decided the pair. The extension stamps
  // `plan.slotSource`; failure to render it hides the user-pinned source.
  const plan = planSlottedReviewFanout(SLOT_FACTS, ["onekey/gpt-5.6-sol", "claude-fable-5"]);
  plan.slotSource = "REVIEWER SLOT SOURCE: project — slots: onekey/gpt-5.6-sol | claude-fable-5";
  const out = formatFanoutDirective(plan);
  assert.ok(out.startsWith("REVIEWER SLOT SOURCE: project"), "source line must lead the directive");
  assert.match(out, /CROSS-FAMILY PAIR/);
  // The default (no slotSource) is unchanged for non-slotted plans.
  assert.doesNotMatch(formatFanoutDirective(planReviewFanout(["claude-fable-5"])), /^REVIEWER SLOT SOURCE/);
});

test("unrecognized single-family slots carry the collapse caveat, and slot plans use slot phrasing", () => {
  // Two DIFFERENT unknown vendors collapse into one family — the note must say
  // so instead of asserting a false same-family claim.
  const twoUnknown = facts(
    [{ provider: "px", id: "cohere-command-r" }, { provider: "py", id: "ernie-5" }],
    ["px", "py"],
  );
  const single = planSlottedReviewFanout(twoUnknown, ["px/cohere-command-r", "py/ernie-5"]);
  assert.equal(single.crossFamily, false);
  assert.deepEqual(single.reviewers, ["px/cohere-command-r"]);
  assert.match(single.note!, /UNRECOGNIZED/, "unknown collapse must carry the caveat");
  // SINGLE + NONE branches must speak in slots, not host, when slotSource is set.
  const singleDirective = formatFanoutDirective(single);
  assert.match(singleDirective, /in your reviewer slots/);
  // The slot-path SINGLE branch must name the picked spec (round-4 P2: no
  // assertion covered this line; deleting it left the suite green).
  assert.match(singleDirective, /Picked reviewer: px\/cohere-command-r\. Spawn exactly that spec\./);
  const none = formatFanoutDirective(planSlottedReviewFanout(facts([], []), ["nothing"]));
  assert.match(none, /in your reviewer slots/);
});

// ---------------------------------------------------------------------------
// planSlottedReviewFanout — user slot list with the reviewer `auto` switch OFF.
// ---------------------------------------------------------------------------


test("configured fanout helper preserves the default path and honors slots", () => {
  const def = planFanoutFromFacts(SLOT_FACTS);
  assert.deepStrictEqual(planConfiguredReviewFanout(SLOT_FACTS, { auto: true, slots: [], source: "global" }), def);
  assert.deepStrictEqual(planConfiguredReviewFanout(SLOT_FACTS, { auto: false, slots: [], source: "project" }), def);
  const slotted = planConfiguredReviewFanout(SLOT_FACTS, {
    auto: false,
    slots: ["onekey/gpt-5.6-sol", "claude-fable-5"],
    source: "project",
  });
  assert.equal(slotted?.crossFamily, true);
  assert.match(slotted?.slotSource ?? "", /REVIEWER SLOT SOURCE: project/);
  // The stamp lives ONCE, here in the helper (round-12 Nit: the extension held
  // a second copy that could drift), so its FULL text is pinned behaviorally.
  assert.match(
    slotted?.slotSource ?? "",
    /slots: onekey\/gpt-5\.6-sol \| claude-fable-5\. The first two usable slots win — capability ranking is bypassed\./,
    "the stamp must name the slots and state that capability ranking is bypassed",
  );
});

test("slots: a reasoning:false model pinned with a non-off level reports the TRUE skip reason (round-12 P2)", () => {
  // Round 1 fixed the NONE/SINGLE note blaming reasons that were all false
  // (unauthenticated / allowlist-blocked / cheap-tier / absent) for a slot that
  // was really dropped because a reasoning:false model cannot honor a level
  // other than `:off`. Round 2: that fix had no pinning test — disabling the
  // bucket push left the suite green.
  const f = facts(
    [
      { provider: "p", id: "plain", reasoning: false },
      { provider: "anthropic", id: "claude-fable-5" },
    ],
    ["p", "anthropic"],
  );
  const plan = planSlottedReviewFanout(f, ["p/plain:high", "anthropic/claude-fable-5"]);
  assert.deepEqual(plan.reviewers, ["anthropic/claude-fable-5"], "the refused slot must not be picked");
  assert.match(
    plan.note ?? "",
    /skipped because their :thinking level is unsupported by the target model: p\/plain:high/,
    `the note must name the slot AND the real reason: ${plan.note}`,
  );
  // `:off` on the same model stays usable (validateSpec parity, round-8 P1).
  const offPlan = planSlottedReviewFanout(f, ["p/plain:off"]);
  assert.deepEqual(offPlan.reviewers, ["p/plain:off"], ":off is allowed on a reasoning:false model");
  // A genuinely ABSENT slot keeps the generic message (no false attribution).
  const absent = planSlottedReviewFanout(f, ["p/not-in-registry:high"]);
  assert.deepEqual(absent.reviewers, []);
  assert.doesNotMatch(
    absent.note ?? "",
    /:thinking level is unsupported/,
    `an absent model must NOT be blamed on its thinking level: ${absent.note}`,
  );
});
test("slots: user order decides the pair, capability ranking is bypassed", () => {
  const plan = planSlottedReviewFanout(SLOT_FACTS, [
    "onekey/gpt-5.6-sol",
    "claude-fable-5",
    "onekey/glm-5.3:high",
  ]);
  assert.equal(plan.crossFamily, true);
  assert.deepEqual(plan.reviewers, ["onekey/gpt-5.6-sol", "anthropic/claude-fable-5"]);
  assert.deepEqual(plan.families, ["openai", "anthropic"]);
  assert.equal(plan.note, undefined);
});

test("slots: same-family duplicates are skipped so the pair stays cross-family", () => {
  const plan = planSlottedReviewFanout(SLOT_FACTS, [
    "onekey/gpt-5.6-sol",
    "onekey/gpt-5.5", // same family (openai) — must be skipped
    "claude-fable-5",
  ]);
  assert.deepEqual(plan.reviewers, ["onekey/gpt-5.6-sol", "anthropic/claude-fable-5"]);
  assert.deepEqual(plan.families, ["openai", "anthropic"]);
});

test("slots: the `:thinking` suffix is stripped before MATCHING but kept on the picked spec", () => {
  // round-2 Nit: the injected "Picked reviewers" line must carry the per-slot
  // thinking level the user pinned, not a bare provider/id. The facts carry
  // metadata so the restricted tiers (max/xhigh) are provably supported.
  const withTlm = facts(
    [
      { provider: "anthropic", id: "claude-fable-5", thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } },
      { provider: "onekey", id: "gpt-5.6-sol", thinkingLevelMap: { low: "low", high: "high", max: "max" } },
      { provider: "onekey", id: "gpt-5.5" },
      { provider: "onekey", id: "glm-5.3" },
      { provider: "zhipu", id: "glm-5.3" },
      { provider: "xai", id: "grok-4.6" },
      { provider: "opencode-go", id: "deepseek-v4-flash" },
    ],
    ["anthropic", "onekey", "xai", "opencode-go"],
  );
  const plan = planSlottedReviewFanout(withTlm, ["claude-fable-5:max", "onekey/gpt-5.6-sol:high"]);
  assert.deepEqual(plan.reviewers, ["anthropic/claude-fable-5:max", "onekey/gpt-5.6-sol:high"]);
});

test("slots: an UNKNOWN `:thinking` suffix makes the slot unresolvable, never a bare-id match (round-3/5 P2)", () => {
  // A bogus level must not reach the prompt as a spawn instruction. Since
  // round-5, bareModelId strips ONLY known levels — so `:bogus` stays part of
  // the id, the slot matches nothing and is dropped (consistent with the
  // renderer, which refuses the whole chain).
  const plan = planSlottedReviewFanout(SLOT_FACTS, ["claude-fable-5:bogus", "onekey/gpt-5.6-sol:ultrathink"]);
  assert.deepEqual(plan.reviewers, []);
  assert.match(plan.note!, /NONE of the configured slots is usable/);
});

test("slots: a level EXPLICITLY null-mapped by the model skips the slot (round-4/7 P2)", () => {
  // fable-5's map EXPLICITLY nulls `off` — the renderer refuses it, so the
  // directive must not name it either. (A merely MISSING key is default-
  // supported since round-7, aligned with pi-subagents.)
  const factsWithTlm = facts(
    [
      { provider: "anthropic", id: "claude-fable-5", thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } },
      { provider: "onekey", id: "gpt-5.6-sol", thinkingLevelMap: { low: "low", high: "high", max: "max" } },
    ],
    ["anthropic", "onekey"],
  );
  const plan = planSlottedReviewFanout(factsWithTlm, ["claude-fable-5:off", "onekey/gpt-5.6-sol:max"]);
  assert.deepEqual(plan.reviewers, ["onekey/gpt-5.6-sol:max"], "fable:off must be skipped, the supported pair wins");
  assert.equal(plan.crossFamily, false, "one unusable slot leaves a single-family plan");
  assert.ok(plan.note);
  // The note must SAY WHY the slot was dropped (round-5 P2: it used to blame
  // "only one family in the slots").
  assert.match(plan.note!, /anthropic\/claude-fable-5:off/, "the skipped slot must be named");
  assert.match(plan.note!, /unsupported by the target model/);
});

test("slots: restricted tiers are refused even WITHOUT metadata — mirrors validateSpec (round-8 P2)", () => {
  // The gate-doctor disk fallback never carries thinkingLevelMap; validateSpec
  // still refuses xhigh/max there. The planner must do the same, or the
  // directive would name a level the renderer rejects.
  const noTlm = facts(
    [{ provider: "anthropic", id: "claude-fable-5" }, { provider: "onekey", id: "gpt-5.6-sol" }],
    ["anthropic", "onekey"],
  );
  const plan = planSlottedReviewFanout(noTlm, ["claude-fable-5:max", "onekey/gpt-5.6-sol:high"]);
  assert.deepEqual(plan.reviewers, ["onekey/gpt-5.6-sol:high"], "fable:max (restricted, no metadata) must be skipped");
  assert.match(plan.note!, /anthropic\/claude-fable-5:max/);
  assert.equal(plan.crossFamily, false);
});

test("slots: xhigh without metadata follows pi-subagents defaults", () => {
  const noTlm = facts(
    [{ provider: "anthropic", id: "claude-fable-5" }, { provider: "onekey", id: "gpt-5.6-sol" }],
    ["anthropic", "onekey"],
  );
  const plan = planSlottedReviewFanout(noTlm, ["claude-fable-5:xhigh", "onekey/gpt-5.6-sol:high"]);
  assert.deepEqual(plan.reviewers, ["anthropic/claude-fable-5:xhigh", "onekey/gpt-5.6-sol:high"]);
  assert.equal(plan.crossFamily, true);
});

test("slots: provider-less spec resolves by id, honoring auth + allowlist + judge tier", () => {
  // glm-5.3 exists under BOTH onekey and zhipu in SLOT_FACTS — a bare spec
  // is registry-ambiguous and must be skipped (validateSpec parity); the
  // QUALIFIED form resolves cleanly.
  const bare = planSlottedReviewFanout(SLOT_FACTS, [
    "glm-5.3",            // provider-less AND ambiguous (onekey + zhipu) — skipped
    "deepseek-v4-flash",  // cheap tier — never judge-eligible, skipped
    "claude-fable-5",
  ]);
  assert.deepEqual(bare.reviewers, ["anthropic/claude-fable-5"], "the ambiguous bare id is skipped");
  const qualified = planSlottedReviewFanout(SLOT_FACTS, [
    "onekey/glm-5.3",
    "deepseek-v4-flash",
    "claude-fable-5",
  ]);
  assert.deepEqual(qualified.reviewers, ["onekey/glm-5.3", "anthropic/claude-fable-5"], "the qualified form resolves by auth + judge tier");
});

test("slots: only one usable family ⇒ single reviewer with a declared slot note", () => {
  const single = planSlottedReviewFanout(
    facts(
      [{ provider: "anthropic", id: "claude-fable-5" }, { provider: "opencode-go", id: "deepseek-v4-flash" }],
      ["anthropic", "opencode-go"],
    ),
    ["claude-fable-5", "claude-opus-5", "deepseek-v4-flash"],
  );
  assert.equal(single.crossFamily, false);
  assert.deepEqual(single.reviewers, ["anthropic/claude-fable-5"]);
  assert.ok(single.note);
  assert.match(single.note!, /SINGLE/);
});

test("slots: no usable slot ⇒ no reviewers with an explicit note", () => {
  const plan = planSlottedReviewFanout(SLOT_FACTS, ["missing-model", "opencode-go/deepseek-v4-flash"]);
  assert.deepEqual(plan.reviewers, []);
  assert.ok(plan.note);
  assert.match(plan.note!, /NONE of the configured slots/);
});

test("slots: NONE branch also names slots skipped for an unsupported level (round-5 P2)", () => {
  // The levelSkipNote fragment was only asserted on the SINGLE branch; the
  // NONE branch calls it too — deleting it there kept the suite green.
  const factsWithTlm = facts(
    [{ provider: "anthropic", id: "claude-fable-5", thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } }],
    ["anthropic"],
  );
  const plan = planSlottedReviewFanout(factsWithTlm, ["claude-fable-5:off"]);
  assert.deepEqual(plan.reviewers, [], "the only slot is skipped — nothing usable remains");
  assert.match(plan.note!, /NONE of the configured slots/);
  assert.match(plan.note!, /anthropic\/claude-fable-5:off/, "the skipped slot must be named");
  assert.match(plan.note!, /unsupported by the target model/);
});

test("slots: a CROSS-FAMILY pair that lost a preferred slot to an unsupported level carries the note (round-7 P2)", () => {
  // The crossFamily return branch attaches levelSkipNote too; deleting that
  // spread kept the suite green (round-7 mutation).
  const factsWithTlm = facts(
    [
      { provider: "anthropic", id: "claude-fable-5", thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } },
      { provider: "onekey", id: "gpt-5.6-sol", thinkingLevelMap: { low: "low", high: "high", max: "max" } },
      { provider: "xai", id: "grok-4.6", thinkingLevelMap: { low: "low", high: "high", max: "max" } },
    ],
    ["anthropic", "onekey", "xai"],
  );
  const plan = planSlottedReviewFanout(factsWithTlm, [
    "claude-fable-5:off", // explicitly null-mapped — skipped
    "onekey/gpt-5.6-sol:max",
    "xai/grok-4.6:max",
  ]);
  assert.equal(plan.crossFamily, true, "two usable families still pair up");
  assert.deepEqual(plan.reviewers, ["onekey/gpt-5.6-sol:max", "xai/grok-4.6:max"]);
  assert.ok(plan.note, "the lost slot must be visible even when the pair survives");
  assert.match(plan.note!, /anthropic\/claude-fable-5:off/);
  assert.match(plan.note!, /unsupported by the target model/);
});

test("slots: an UNAUTHENTICATED provider is skipped as unusable (auth filter is enforced)", () => {
  const f = facts(
    [{ provider: "onekey", id: "gpt-5.6-sol" }, { provider: "anthropic", id: "claude-fable-5" }, { provider: "zhipu", id: "glm-5.3" }],
    ["onekey", "anthropic"], // zhipu never authenticated
  );
  const plan = planSlottedReviewFanout(f, ["onekey/gpt-5.6-sol", "zhipu/glm-5.3", "claude-fable-5"]);
  assert.deepEqual(plan.reviewers, ["onekey/gpt-5.6-sol", "anthropic/claude-fable-5"], "zhipu glm must be skipped");
});

test("slots: an ALLOWLIST-BLOCKED provider is skipped as unusable (allowlist filter is enforced)", () => {
  const f = facts(
    [
      { provider: "onekey", id: "gpt-5.6-sol" },
      { provider: "opencode-go", id: "deepseek-v4-pro" },
      { provider: "anthropic", id: "claude-fable-5" },
    ],
    ["onekey", "opencode-go", "anthropic"],
    (m) => m.provider !== "opencode-go", // allowlist denies every opencode-go id but flash
  );
  const plan = planSlottedReviewFanout(f, ["opencode-go/deepseek-v4-pro", "onekey/gpt-5.6-sol", "claude-fable-5"]);
  assert.deepEqual(plan.reviewers, ["onekey/gpt-5.6-sol", "anthropic/claude-fable-5"], "blocked provider must be skipped");
});

test("slots: a colon-bearing id (ollama qwen3:32b) matches the full id, not a stripped bare id", () => {
  // Round-8 P1 / round-5 P2: bareModelId strips only KNOWN thinking LEVELS —
  // `qwen3:32b` (numeric suffix) and `qwen3:latest` (letter tag outside the
  // level whitelist) are real ids and must NOT be reduced to `qwen3` (which
  // would silently mis-match to a different model or fall to NONE/SINGLE with
  // no diagnosis).
  assert.equal(bareModelId("ollama/qwen3:32b"), "qwen3:32b");
  assert.equal(bareModelId("ollama/qwen3:latest"), "qwen3:latest");
  // Sanity: the thinking suffix path is still stripped as before.
  assert.equal(bareModelId("onekey/gpt-5.6-sol:high"), "gpt-5.6-sol");
  assert.equal(bareModelId("anthropic/claude-fable-5"), "claude-fable-5");
  // And the slot planner actually picks the colon-id model when present.
  const f = facts(
    [{ provider: "ollama", id: "qwen3:32b" }, { provider: "anthropic", id: "claude-fable-5" }],
    ["ollama", "anthropic"],
  );
  const plan = planSlottedReviewFanout(f, ["ollama/qwen3:32b", "claude-fable-5"]);
  assert.deepEqual(plan.reviewers, ["ollama/qwen3:32b", "anthropic/claude-fable-5"]);
});

test("slots: the provider prefix narrows matches (annotated prov beats bare-id prov)", () => {
  // Round-8 P2: "provider filter" and "unauthenticated skip" must be
  // distinguishable — pinning a provider must select THAT provider's id when
  // the same id exists on two providers.
  const f = facts(
    [{ provider: "onekey", id: "glm-5.3" }, { provider: "zhipu", id: "glm-5.3" }, { provider: "anthropic", id: "claude-fable-5" }],
    ["onekey", "zhipu", "anthropic"],
  );
  const plan = planSlottedReviewFanout(f, ["zhipu/glm-5.3", "onekey/glm-5.3", "claude-fable-5"]);
  assert.deepEqual(plan.reviewers, ["zhipu/glm-5.3", "anthropic/claude-fable-5"], "zhipu wins via explicit provider, onekey glm is same-family and skipped");
});
