/**
 * THE REQUIREMENT RESTATEMENT (lib/restatement.ts) — the step the gate made
 * mandatory on 2026-09-06, and the refusal the two contract tools hand back
 * when it was skipped.
 *
 * What these tests are really defending:
 *
 *  - the CONTENT rule is wide and auditable. The whole accepted vocabulary is
 *    one exported array, and every entry is enumerated below — a narrowed
 *    condition (or a literal that crept into the function) fails here rather
 *    than in a session that gets refused for its word choice.
 *  - the refusal is SELF-RESCUING. The next session has never seen this
 *    mechanism; if the text does not carry the call, the skeleton and the
 *    appeal route, that session has to read the source to get unstuck.
 *  - a record is only "confirmed" when its own hash proves it. That is what
 *    stops a half-written or assembled record from counting as a user's yes.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  RESTATEMENT_APPROVE_LABEL,
  RESTATEMENT_CONTRAST_TOKENS,
  RESTATEMENT_MIN_CHARS,
  RESTATEMENT_REJECT_LABEL,
  RESTATEMENT_SKELETON,
  buildRestatementMissingRefusal,
  checkRestatementText,
  doProposeRestatement,
  hasBeforeAfterContrast,
  registerRestatementTools,
  restatementConfirmed,
  restatementHash,
  restatementRequiredInMode,
  type RestatementRecord,
  type RestatementStateSlice,
  type RestatementToolDeps,
} from "../lib/restatement.ts";
import type { ToolHost, ToolReply } from "../lib/tool-host.ts";

const ROOT = "/repo";

/** Filler that carries no contrast of its own, so a marker test is about the marker. */
const FILLER = "这轮要做的事情是把需求说回给用户确认，先读代码再落地，避免做完了交付的不是用户要的东西。".repeat(2);

/** A restatement that passes every check. */
const GOOD = [
  "1. 这件事是什么：把需求反述做成门禁的前置步骤。",
  "2. 举个例子：子会话被 spawn 之后先反述，用户点确认，才能谈 goal。",
  "3. 改之前：propose_loop_goal 直接跑审计。",
  "4. 改之后：没有已确认的反述就直接被拒，一个框都不弹。",
  "5. 哪几步会变得不同：谈 goal 之前多一步 propose_restatement。",
].join("\n");

// ---------------------------------------------------------------------------
// the content rule

test("the accepted contrast vocabulary is ONE exported array, and every entry works", () => {
  // Enumerated entry by entry (user requirement, 2026-09-06): a wide rule
  // nobody can list is a rule that quietly narrows.
  const arrows = RESTATEMENT_CONTRAST_TOKENS.filter((t) => t.role === "arrow");
  const befores = RESTATEMENT_CONTRAST_TOKENS.filter((t) => t.role === "before");
  const afters = RESTATEMENT_CONTRAST_TOKENS.filter((t) => t.role === "after");
  assert.ok(arrows.length >= 2 && befores.length >= 3 && afters.length >= 3,
    "the vocabulary must stay wide enough to be about substance, not word choice");

  for (const arrow of arrows) {
    assert.equal(hasBeforeAfterContrast(`${FILLER} 老样子 ${arrow.token} 新样子`), true,
      `an arrow alone is a contrast: ${arrow.token}`);
  }
  // Each BEFORE marker, paired with one fixed AFTER marker, and vice versa —
  // so a dropped row anywhere in the array is a failure with a name.
  for (const before of befores) {
    assert.equal(hasBeforeAfterContrast(`${FILLER}${before.token}是一个样子，改成另一个样子`), true,
      `before marker must be accepted: ${before.token}`);
  }
  for (const after of afters) {
    assert.equal(hasBeforeAfterContrast(`${FILLER}原来是一个样子，${after.token}是另一个样子`), true,
      `after marker must be accepted: ${after.token}`);
  }
});

test("a BEFORE marker alone (or an AFTER marker alone) is not a contrast", () => {
  assert.equal(hasBeforeAfterContrast(`${FILLER}原来就是这样`), false);
  assert.equal(hasBeforeAfterContrast(`${FILLER}以后就这样`), false);
  assert.equal(hasBeforeAfterContrast(FILLER), false);
});

test("check: empty, too short, and contrast-free drafts are refused — each naming its fix", () => {
  const empty = checkRestatementText("   ");
  assert.equal(empty.ok, false);
  assert.match(empty.ok === false ? empty.text : "", /空/);

  const short = checkRestatementText("改之前 A，改之后 B。");
  assert.equal(short.ok, false);
  assert.match(short.ok === false ? short.text : "", new RegExp(String(RESTATEMENT_MIN_CHARS)),
    "the floor is named — an agent cannot guess how much more to write");

  const noContrast = checkRestatementText(FILLER + FILLER);
  assert.equal(noContrast.ok, false);
  const text = noContrast.ok === false ? noContrast.text : "";
  assert.match(text, /改之前/, "the refusal shows the phrasing it wants");
  assert.match(text, /→/);
  assert.ok(text.includes(RESTATEMENT_SKELETON), "…and hands over the skeleton to copy");
});

test("check: a draft over the cap is refused with its own length, not silently truncated", () => {
  const huge = "改之前 A，改之后 B。" + "字".repeat(9000);
  const out = checkRestatementText(huge);
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.text : "", /8000/);
});

test("check: a good draft passes and comes back NORMALIZED", () => {
  const out = checkRestatementText(`\r\n${GOOD}\r\n\r\n`);
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.text, GOOD.replace(/\r\n/g, "\n"),
    "CRLF and outer whitespace must not change what the hash binds to");
});

// ---------------------------------------------------------------------------
// the record

test("confirmed: only a record whose own hash proves it counts", () => {
  const record: RestatementRecord = {
    text: GOOD, hash: restatementHash(GOOD), at: "2026-09-06T00:00:00.000Z", station: "precommit",
  };
  assert.equal(restatementConfirmed(record), true);
  assert.equal(restatementConfirmed(undefined), false);
  assert.equal(restatementConfirmed({ ...record, hash: "0".repeat(64) }), false,
    "a hash that does not match the text is not a confirmation");
  assert.equal(restatementConfirmed({ ...record, text: GOOD + "偷偷加一句" }), false,
    "…and neither is text that was edited after the fact");
  assert.equal(restatementConfirmed({ ...record, text: "   " }), false);
});

test("scope: loop and orchestrator require it; explore and normal do not", () => {
  assert.equal(restatementRequiredInMode("loop"), true);
  assert.equal(restatementRequiredInMode("orchestrator"), true);
  assert.equal(restatementRequiredInMode("explore"), false);
  assert.equal(restatementRequiredInMode("normal"), false);
  assert.equal(restatementRequiredInMode(undefined), false);
});

// ---------------------------------------------------------------------------
// the refusal both contract tools hand back

test("the refusal is self-rescuing: the call, the skeleton, and a way out that works", () => {
  for (const tool of ["propose_loop_goal", "orchestrator_plan"] as const) {
    const text = buildRestatementMissingRefusal(tool);
    assert.match(text, new RegExp(tool), "it says which tool refused");
    assert.match(text, /propose_restatement\(\{/, "…and the exact call to make");
    assert.match(text, /restatement:/);
    assert.match(text, /station:/);
    assert.match(text, /precommit \| commit \| pr/, "…with the three stations spelled out");
    assert.ok(text.includes(RESTATEMENT_SKELETON), "…and a skeleton to copy");
    // THE MISJUDGEMENT ROUTE (user decision, 2026-09-06). This used to point at
    // `request_arbitration`, which cannot hear a TOOL refusal at all: the
    // arbiter only rules on a recorded ship / text / zero-inspection block, so
    // the appeal comes back "nothing to arbitrate" — or, worse, judges an
    // older unrelated block and spends one of the session's three. The routes
    // named now both exist: hand the decision to the user, or leave the mode.
    assert.doesNotMatch(text, /request_arbitration/,
      "a route that cannot work is worse than no route");
    assert.match(text, /ask_user/, "the decision belongs to the user, and the text says how to reach them");
    assert.match(text, /gate-mode/, "…and how to leave the mode that requires a contract at all");

    assert.match(text, /不提供任何豁免开关/,

      "…stated plainly, so nobody goes looking for a flag that does not exist");
    assert.match(text, /没有弹出任何对话框|一个框都不弹|没有弹/,
      "the user was not disturbed, and the agent must know that");
  }
});

// ---------------------------------------------------------------------------
// propose_restatement

interface Fake {
  deps: RestatementToolDeps;
  st: RestatementStateSlice;
  /** Every user-facing surface reached, in order. */
  surfaces: string[];
  persisted: string[];
  confirm: boolean;
  outcome?: { answer: string | undefined; by: "human" | "orchestrator" | "dismissed" | "interrupted"; reason?: string };
}

function fake(over: Partial<Fake> = {}): Fake {
  const f: Fake = { deps: undefined as unknown as RestatementToolDeps, st: {}, surfaces: [], persisted: [], confirm: true, ...over };
  f.deps = {
    primaryRepoRoot: () => ROOT,
    cwd: () => ROOT,
    stateFor: () => f.st,
    persist: (_ctx, root) => { f.persisted.push(root); },
    log: () => {},
    showToUser: () => { f.surfaces.push("showToUser"); return true; },
    confirmBounded: async () => { f.surfaces.push("confirm"); return f.confirm; },
    askEitherSide: async (_request, _hasUI, render) => {
      if (f.outcome) return { ...f.outcome, requestId: "r1" };
      const answer = await render(new AbortController().signal);
      return { answer, by: "human", requestId: "r1" };
    },
    gitRoot: (dir) => (dir === "/other" ? "/other" : null),
    now: () => new Date("2026-09-06T12:00:00.000Z"),
  };
  return f;
}

const UI = { hasUI: true };

test("propose: a confirmed restatement is recorded with its hash, time and station", async () => {
  const f = fake();
  const out = await doProposeRestatement(f.deps, { restatement: GOOD, station: "commit" }, UI);
  assert.equal(out.details?.confirmed, true);
  assert.deepEqual(f.surfaces, ["showToUser", "confirm"], "the text is shown BEFORE the dialog asks");
  assert.equal(f.st.restatement?.text, GOOD);
  assert.equal(f.st.restatement?.hash, restatementHash(GOOD));
  assert.equal(f.st.restatement?.station, "commit");
  assert.equal(f.st.restatement?.at, "2026-09-06T12:00:00.000Z");
  assert.deepEqual(f.persisted, [ROOT]);
  assert.equal(restatementConfirmed(f.st.restatement), true);
  assert.match(out.content[0]!.text, /propose_loop_goal/, "the reply says what the next step is");
});

test("propose: a refused draft never reaches the user", async () => {
  const f = fake();
  const out = await doProposeRestatement(f.deps, { restatement: "太短了", station: "pr" }, UI);
  assert.equal(out.isError, true);
  assert.deepEqual(f.surfaces, [], "a draft the gate can reject mechanically costs the user nothing");
  assert.equal(f.st.restatement, undefined);
});

test("propose: an unreadable station is recorded as the strictest one, not refused", async () => {
  const f = fake();
  const out = await doProposeRestatement(f.deps, { restatement: GOOD, station: "开到 PR" }, UI);
  assert.equal(out.details?.confirmed, true);
  assert.equal(f.st.restatement?.station, "precommit");
  assert.match(out.content[0]!.text, /precommit/, "the reply says which station was actually recorded");
});

test("propose: the user's NO records nothing and points at the next attempt", async () => {
  const f = fake({ confirm: false });
  const out = await doProposeRestatement(f.deps, { restatement: GOOD, station: "precommit" }, UI);
  assert.equal(out.details?.confirmed, false);
  assert.equal(f.st.restatement, undefined);
  assert.deepEqual(f.persisted, []);
  assert.match(out.content[0]!.text, /propose_restatement/);
});

test("propose: the ORCHESTRATOR's decline reason comes back as the objection", async () => {
  const f = fake({ outcome: { answer: RESTATEMENT_REJECT_LABEL, by: "orchestrator", reason: "第 3 条理解反了" } });
  const out = await doProposeRestatement(f.deps, { restatement: GOOD, station: "precommit" }, UI);
  assert.equal(out.details?.confirmed, false);
  assert.match(out.content[0]!.text, /第 3 条理解反了/);
});

test("propose: an interrupt is NOT a rejection", async () => {
  const f = fake({ outcome: { answer: undefined, by: "interrupted" } });
  const out = await doProposeRestatement(f.deps, { restatement: GOOD, station: "precommit" }, UI);
  assert.equal(out.details?.confirmed, false);
  assert.equal(out.details?.interrupted, true);
  assert.match(out.content[0]!.text, /不是被否掉/);
  assert.equal(f.st.restatement, undefined);
});

test("propose: the PM sees the child's OWN words — the full text travels as the payload", async () => {
  const f = fake();
  let seen: { topic?: string; payload?: string; options: string[] } | undefined;
  f.deps.askEitherSide = async (request) => {
    seen = { topic: request.topic, payload: request.payload, options: request.options };
    return { answer: RESTATEMENT_APPROVE_LABEL, by: "orchestrator", requestId: "r1" };
  };
  await doProposeRestatement(f.deps, { restatement: GOOD, station: "pr" }, UI);
  assert.equal(seen?.topic, "restatement");
  assert.equal(seen?.payload, GOOD, "a retyped summary must never be what gets confirmed");
  assert.deepEqual(seen?.options, [RESTATEMENT_APPROVE_LABEL, RESTATEMENT_REJECT_LABEL]);
  assert.equal(f.st.restatement?.station, "pr");
});

test("propose: a repo that is not a git root is refused, naming the path", async () => {
  const f = fake();
  const out = await doProposeRestatement(f.deps, { restatement: GOOD, station: "precommit", repo: "/nope" }, UI);
  assert.equal(out.isError, true);
  assert.match(out.content[0]!.text, /\/nope/);
  assert.deepEqual(f.surfaces, []);
});

test("propose: calling it again overwrites the record — the newest confirmation wins", async () => {
  const f = fake();
  await doProposeRestatement(f.deps, { restatement: GOOD, station: "precommit" }, UI);
  const revised = GOOD + "\n6. 补充：改之后还要更新文档。";
  await doProposeRestatement(f.deps, { restatement: revised, station: "pr" }, UI);
  assert.equal(f.st.restatement?.text, revised);
  assert.equal(f.st.restatement?.station, "pr");
});

test("registration: ONE tool, with no parameter that could attest the user's yes", () => {
  const specs = new Map<string, { description: string; parameters: { properties?: Record<string, unknown> } }>();
  const host: ToolHost = {
    registerTool: (definition) => {
      specs.set(definition.name, definition as unknown as {
        description: string; parameters: { properties?: Record<string, unknown> };
      });
    },
  };
  registerRestatementTools(host, fake().deps);
  assert.deepEqual([...specs.keys()], ["propose_restatement"]);
  assert.deepEqual(
    Object.keys(specs.get("propose_restatement")!.parameters.properties ?? {}).sort(),
    ["repo", "restatement", "station"],
    "no `confirmed`/`approved` parameter — the confirmation comes from a dialog only",
  );
  assert.match(specs.get("propose_restatement")!.description, /propose_loop_goal/,
    "the tool says which step it unblocks");
});

test("registration: the registered tool dispatches to the handler, not to a copy", async () => {
  const f = fake();
  const tools = new Map<string, (params: Record<string, unknown>, ctx: unknown) => Promise<ToolReply>>();
  const host: ToolHost = {
    registerTool: (definition) => {
      tools.set(definition.name, (params, ctx) => definition.execute("id", params, undefined, undefined, ctx));
    },
  };
  registerRestatementTools(host, f.deps);
  const out = await tools.get("propose_restatement")!({ restatement: GOOD, station: "commit" }, UI);
  assert.equal(out.details?.confirmed, true);
  assert.equal(f.st.restatement?.station, "commit");
});
