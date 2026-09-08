import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THINKING_DISPLAY_LIMITS,
  THINKING_LOOP_DEFAULTS,
  THINKING_TRUNCATION_MARKER,
  createThinkingLoopDetector,
  repeatedNgrams,
  truncateThinkingForDisplay,
} from "../lib/thinking-loop-guard.ts";

// ---------------------------------------------------------------------------
// Fixtures. The loop sample is the upstream one verbatim
// (deepseek-ai/deepseek-harness#5976): no newlines at all, which is exactly why
// the display cut has to be char-bounded as well as line-bounded.

const LOOP_SAMPLE = "好。执行。好。（输出）好。好。";

function loopText(chars: number): string {
  return LOOP_SAMPLE.repeat(Math.ceil(chars / LOOP_SAMPLE.length)).slice(0, chars);
}

/** Deterministic pseudo-random CJK text: no n-gram repeats meaningfully. */
function variedText(chars: number): string {
  const alphabet =
    "的一是不了人我在有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从";
  let seed = 987654321;
  const out: string[] = [];
  for (let i = 0; i < chars; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out.push(alphabet[seed % alphabet.length]!);
  }
  return out.join("");
}

/**
 * HEALTHY but template-shaped reasoning — the shape that made an 8-character
 * n-gram detector fire on a perfectly good trace: the same clause recurs once
 * per item, broken every time by the item's own numbers.
 */
function templateReasoning(items: number): string {
  return Array.from(
    { length: items },
    (_, i) => `第${i}步：检查 ${i}.ts 里 ${i * 17} 行的条件分支，确认它与上游第 ${i * 3} 个调用的契约一致。`,
  ).join("");
}

/** Prose that reuses a long fixed clause once per sentence. */
function repeatedClauseProse(items: number): string {
  return Array.from(
    { length: items },
    (_, i) => `我在想第${i}种可能：如果缓存键包含时间戳，那么过期策略会与 ${i * 13} 号请求的顺序假设冲突，需要重新核对。`,
  ).join("");
}

/** Feed text as small deltas, the way Pi streams it. */
function stream(
  detector: ReturnType<typeof createThinkingLoopDetector>,
  text: string,
  chunk = 17,
): Array<{ at: number; repeats: number }> {
  const hits: Array<{ at: number; repeats: number }> = [];
  for (let i = 0; i < text.length; i += chunk) {
    const verdict = detector.observe("thinking", text.slice(i, i + chunk));
    if (verdict) hits.push({ at: i + chunk, repeats: verdict.repeats });
  }
  return hits;
}

test("the detection thresholds are pinned", () => {
  // Pinned literally (sibling precedent: test/readonly-stall.test.ts) so a
  // silent retune cannot change the behaviour without this test failing.
  assert.equal(THINKING_LOOP_DEFAULTS.minThinkingChars, 1200);
  assert.equal(THINKING_LOOP_DEFAULTS.windowChars, 800);
  assert.equal(THINKING_LOOP_DEFAULTS.ngramChars, 24);
  assert.equal(THINKING_LOOP_DEFAULTS.minRepeats, 12);
  assert.equal(THINKING_LOOP_DEFAULTS.minDistinctNgrams, 2);
  assert.equal(THINKING_LOOP_DEFAULTS.minRepeatRun, 300);
});

// ---------------------------------------------------------------------------
// repeatedNgrams — the low-entropy test itself

test("repeatedNgrams reports the top count, the distinct count and the longest run", () => {
  assert.deepEqual(repeatedNgrams("", 24, 2), { max: 0, distinct: 0, longestRun: 0 }, "empty text");
  assert.deepEqual(repeatedNgrams("abc", 24, 2), { max: 0, distinct: 0, longestRun: 0 },
    "shorter than one n-gram");
  assert.deepEqual(repeatedNgrams("abcdefghijklmnopqrstuvwx", 24, 2), { max: 1, distinct: 0, longestRun: 0 },
    "exactly one n-gram repeats once");
  assert.deepEqual(repeatedNgrams("a".repeat(30), 24, 2), { max: 7, distinct: 1, longestRun: 7 },
    "a single run is ONE high-frequency n-gram over a long run — not a loop");
});

test("the upstream loop sample clears every half of the threshold", () => {
  const stats = repeatedNgrams(loopText(800), THINKING_LOOP_DEFAULTS.ngramChars, THINKING_LOOP_DEFAULTS.minRepeats);
  assert.ok(stats.max >= THINKING_LOOP_DEFAULTS.minRepeats, `max=${stats.max}`);
  assert.ok(stats.distinct >= THINKING_LOOP_DEFAULTS.minDistinctNgrams, `distinct=${stats.distinct}`);
  assert.ok(stats.longestRun >= THINKING_LOOP_DEFAULTS.minRepeatRun, `longestRun=${stats.longestRun}`);
});

test("template-shaped healthy reasoning repeats SCATTERED, never in one long run", () => {
  const stats = repeatedNgrams(
    templateReasoning(40).slice(0, 800),
    THINKING_LOOP_DEFAULTS.ngramChars,
    THINKING_LOOP_DEFAULTS.minRepeats,
  );
  assert.ok(stats.longestRun < THINKING_LOOP_DEFAULTS.minRepeatRun, `longestRun=${stats.longestRun}`);
});

test("a long separator run is NOT a loop: one repeated n-gram, ordinary prose around it", () => {
  // The exact false positive the distinct-count half exists for: a rule drawn
  // inside otherwise-varied thinking repeats `-` over a long consecutive run.
  const text = `${"-".repeat(600)}${variedText(200)}`;
  const stats = repeatedNgrams(text, THINKING_LOOP_DEFAULTS.ngramChars, THINKING_LOOP_DEFAULTS.minRepeats);
  assert.ok(stats.max >= THINKING_LOOP_DEFAULTS.minRepeats, `max=${stats.max}`);
  assert.ok(stats.distinct < THINKING_LOOP_DEFAULTS.minDistinctNgrams, `distinct=${stats.distinct}`);
});

test("varied prose stays far below the repeat threshold", () => {
  const stats = repeatedNgrams(variedText(800), THINKING_LOOP_DEFAULTS.ngramChars, THINKING_LOOP_DEFAULTS.minRepeats);
  assert.ok(stats.max < THINKING_LOOP_DEFAULTS.minRepeats, `max=${stats.max}`);
  assert.equal(stats.distinct, 0);
});

// ---------------------------------------------------------------------------
// createThinkingLoopDetector — the fold

test("a pure-thinking loop trips once the thresholds are crossed", () => {
  const detector = createThinkingLoopDetector();
  const hits = stream(detector, loopText(4000));
  assert.equal(hits.length, 1, "exactly one verdict per turn");
  assert.ok(hits[0]!.at >= THINKING_LOOP_DEFAULTS.minThinkingChars, "not before the floor");
  assert.ok(hits[0]!.repeats >= THINKING_LOOP_DEFAULTS.minRepeats);
});

test("a two-character cycle still trips: it is the fastest-spinning shape", () => {
  const detector = createThinkingLoopDetector();
  const hits = stream(detector, "好。".repeat(2000));
  assert.equal(hits.length, 1);
});

test("a separator rule inside otherwise-varied thinking never trips", () => {
  const detector = createThinkingLoopDetector();
  const hits = stream(detector, `${"-".repeat(2000)}${variedText(4000)}`);
  assert.deepEqual(hits, [], "a repeated RUN is not a repeated CYCLE");
});

test("template-shaped but healthy reasoning never trips", () => {
  const detector = createThinkingLoopDetector();
  const hits = stream(detector, templateReasoning(400));
  assert.deepEqual(hits, [], "a recurring clause is not a loop while each repeat is broken by its item");
});

test("prose that reuses one long clause never trips", () => {
  const detector = createThinkingLoopDetector();
  const hits = stream(detector, repeatedClauseProse(200));
  assert.deepEqual(hits, []);
});

test("an English word-salad loop trips just like the Chinese one", () => {
  const detector = createThinkingLoopDetector();
  const hits = stream(detector, "Let me check. Wait. Actually. Let me check. Hmm. ".repeat(200));
  assert.equal(hits.length, 1);
});

test("varied long thinking never trips", () => {
  const detector = createThinkingLoopDetector();
  const hits = stream(detector, variedText(20_000));
  assert.deepEqual(hits, [], "a long, non-repetitive thinking block is not a loop");
});

test("a turn that emits any text is not a loop", () => {
  const detector = createThinkingLoopDetector();
  detector.observe("text", "x");
  const hits = stream(detector, loopText(4000));
  assert.deepEqual(hits, []);
  assert.equal(detector.snapshot().textChars, 1);
});

test("a turn that emits any tool-call content is not a loop", () => {
  const detector = createThinkingLoopDetector();
  detector.observe("toolcall", '{"path":');
  const hits = stream(detector, loopText(4000));
  assert.deepEqual(hits, []);
  assert.equal(detector.snapshot().toolCallChars, 8);
});

test("thinking below the floor never trips, however repetitive", () => {
  const detector = createThinkingLoopDetector();
  const hits = stream(detector, loopText(THINKING_LOOP_DEFAULTS.minThinkingChars - 1));
  assert.deepEqual(hits, []);
});

test("reset clears the turn so the next one is judged afresh", () => {
  const detector = createThinkingLoopDetector();
  stream(detector, loopText(4000));
  assert.equal(detector.snapshot().tripped, true);
  detector.reset();
  assert.deepEqual(detector.snapshot(), {
    thinkingChars: 0,
    textChars: 0,
    toolCallChars: 0,
    tripped: false,
  });
  // The same loop trips again in the new turn.
  assert.equal(stream(detector, loopText(4000)).length, 1);
});

test("empty deltas are ignored", () => {
  const detector = createThinkingLoopDetector();
  assert.equal(detector.observe("thinking", ""), undefined);
  assert.deepEqual(detector.snapshot(), {
    thinkingChars: 0,
    textChars: 0,
    toolCallChars: 0,
    tripped: false,
  });
});

// ---------------------------------------------------------------------------
// truncateThinkingForDisplay — display-only cut

test("untouched text is returned unchanged", () => {
  const short = "line one\nline two";
  assert.equal(truncateThinkingForDisplay(short, { maxChars: 100, maxLines: 10 }), short);
});

test("a no-newline loop sample is bounded by CHARS, not just lines", () => {
  const loop = loopText(50_000);
  const out = truncateThinkingForDisplay(loop, { maxChars: 400, maxLines: 20 });
  assert.ok(out.length <= 400, `length=${out.length}`);
  assert.ok(out.startsWith(THINKING_TRUNCATION_MARKER));
  assert.ok(out.endsWith(loop.slice(-40)), "the newest thinking is what survives");
});

test("a many-line block is bounded by LINES", () => {
  const many = Array.from({ length: 200 }, (_, i) => `thinking line ${i}`).join("\n");
  const out = truncateThinkingForDisplay(many, { maxChars: 100_000, maxLines: 5 });
  assert.ok(out.split("\n").length <= 5, `lines=${out.split("\n").length}`);
  assert.ok(out.startsWith(THINKING_TRUNCATION_MARKER));
  assert.ok(out.endsWith("thinking line 199"), "the newest lines survive");
});

test("both limits hold at once, marker included", () => {
  const many = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(80)}`).join("\n");
  const out = truncateThinkingForDisplay(many, { maxChars: 300, maxLines: 4 });
  assert.ok(out.length <= 300, `length=${out.length}`);
  assert.ok(out.split("\n").length <= 4, `lines=${out.split("\n").length}`);
});

test("a budget too small for the marker still yields a bounded string", () => {
  const out = truncateThinkingForDisplay(loopText(5000), { maxChars: 5, maxLines: 3 });
  assert.ok(out.length <= 5, `length=${out.length}`);
});

test("a single-line budget yields exactly one line", () => {
  // Reviewer P1, round 1: marker + body was two lines under a one-line budget.
  const out = truncateThinkingForDisplay("x".repeat(200), { maxChars: 100, maxLines: 1 });
  assert.equal(out.split("\n").length, 1);
  assert.ok(out.length <= 100, `length=${out.length}`);
});

test("the default limits are the exported constants", () => {
  const loop = loopText(50_000);
  const out = truncateThinkingForDisplay(loop);
  assert.ok(out.length <= THINKING_DISPLAY_LIMITS.maxChars);
  assert.ok(out.split("\n").length <= THINKING_DISPLAY_LIMITS.maxLines);
});
