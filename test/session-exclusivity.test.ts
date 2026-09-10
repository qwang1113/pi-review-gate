/**
 * ONE gate session per worktree: who is refused, who is exempt, and every way
 * the decision must FAIL OPEN rather than lock a human out of their checkout.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PRESENCE_FRESH_MS,
  PRESENCE_HEARTBEAT_MS,
  checkSessionExclusivity,
  claimsMainSidecar,
  parsePresence,
  presenceFor,
  presenceIsOurs,
  type PresenceRecord,
} from "../lib/session-exclusivity.ts";

const NOW = 1_700_000_000_000;
const REPO = "/Users/dev/workspace/pi-review-gate";

/** A holder whose heartbeat is `ageMs` old. */
function holder(ageMs: number, over: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    sessionId: "session-incumbent",
    pid: 4242,
    host: "laptop.local",
    at: new Date(NOW - ageMs).toISOString(),
    ...over,
  };
}

function verdict(env: NodeJS.ProcessEnv, existing: PresenceRecord | undefined, sessionId: string | null = "session-newcomer") {
  return checkSessionExclusivity({ env, sessionId, existing, repoRoot: REPO, now: NOW });
}

/** The env of an ordinary (sidecar-claiming) session. */
const PLAIN: NodeJS.ProcessEnv = {};
/** A judge pane: identity in RG_JUDGE_*, no state variant. */
const JUDGE: NodeJS.ProcessEnv = {
  RG_JUDGE_OPENER: "session-child-1",
  RG_JUDGE_ID: "rg-reviewer-abc",
  RG_JUDGE_ROLE: "reviewer",
};
/** An orchestration child: its own sidecar variant. */
const CHILD: NodeJS.ProcessEnv = { RG_STATE_VARIANT: "child-7" };

test("the exemption matrix: who claims the main sidecar at all", () => {
  assert.equal(claimsMainSidecar(PLAIN), true, "an ordinary session claims it");
  assert.equal(claimsMainSidecar({ RG_ORCHESTRATION_ID: "orch-1" }), true,
    "a project manager writes the main sidecar too, so it claims it");
  assert.equal(claimsMainSidecar(JUDGE), false, "a judge writes no gate state");
  assert.equal(claimsMainSidecar(CHILD), false, "an orchestration child writes its own variant file");
  // A judge that is ALSO given a variant is still a judge — neither writes the
  // main sidecar, so the order of these two checks cannot matter.
  assert.equal(claimsMainSidecar({ ...JUDGE, ...CHILD }), false);
});

test("the exemption matrix × a live incumbent: only the second CLAIMANT is refused", () => {
  const live = holder(5_000);
  // The row that refuses.
  const plain = verdict(PLAIN, live);
  assert.equal(plain.ok, false, "a second ordinary session in one worktree is refused");
  // The rows that must not — a judge's cwd IS the repo under review and a
  // child's cwd IS the repo its task declares, so refusing them would kill
  // every review and every orchestration.
  assert.equal(verdict(JUDGE, live).ok, true, "a judge pane runs in the same worktree by design");
  assert.equal(verdict(CHILD, live).ok, true, "an orchestration child does too");
});

test("the verdict is what decides whether to TAKE the claim — never the mode", () => {
  // The caller (extensions/review-gate.ts) may choose not to REFUSE in normal
  // mode, where the gate is off by definition. It must still ask, because the
  // answer also decides whether it may write the presence record: taking the
  // claim from a live holder would steal its protection and — since the record
  // would then carry OUR session id — delete it on our way out
  // (`presenceIsOurs`). This test pins the fact the caller relies on.
  const live = holder(5_000);
  assert.equal(verdict(PLAIN, live).ok, false, "occupied ⇒ do not take the claim");
  assert.equal(verdict(PLAIN, undefined).ok, true, "free ⇒ take it");
  assert.equal(verdict(PLAIN, holder(PRESENCE_FRESH_MS + 1)).ok, true, "lapsed ⇒ take it");
  // And the record we would overwrite is identifiable as somebody else's.
  assert.equal(presenceIsOurs(live, "session-newcomer"), false,
    "a newcomer must never read the holder's record as its own");
});

test("the refusal names the holder and gives two concrete ways out", () => {
  const v = verdict(PLAIN, holder(5_000));
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.equal(v.holder.sessionId, "session-incumbent");
  // WHICH session, so a human can find it — the diagnostic fields earn their
  // place here and nowhere else.
  assert.match(v.reason, /session-incumbent/);
  assert.match(v.reason, /4242/);
  assert.match(v.reason, /laptop\.local/);
  // Way out 1: a real command, with the real repo path in it.
  assert.match(v.reason, /git -C \/Users\/dev\/workspace\/pi-review-gate worktree add \.\.\/pi-review-gate-2/);
  // Way out 2: closing the other session is enough — no file to delete by hand.
  assert.match(v.reason, /不需要手工删任何文件/);
  assert.match(v.reason, /60 秒/, "…and it says how long that takes");
});

test("a lapsed heartbeat is reclaimed automatically — no manual cleanup", () => {
  assert.equal(verdict(PLAIN, holder(PRESENCE_FRESH_MS + 1)).ok, true, "past the window ⇒ nobody is here");
  assert.equal(verdict(PLAIN, holder(PRESENCE_FRESH_MS)).ok, true, "exactly at the window ⇒ lapsed");
  assert.equal(verdict(PLAIN, holder(PRESENCE_FRESH_MS - 1)).ok, false, "just inside it ⇒ still held");
  assert.ok(PRESENCE_HEARTBEAT_MS * 2 < PRESENCE_FRESH_MS,
    "the holder must refresh several times per window, or a healthy session would lapse");
});

test("every unknown answer FAILS OPEN — refusing needs a positive fact", () => {
  assert.equal(verdict(PLAIN, undefined).ok, true, "no presence file ⇒ nobody is here");
  assert.equal(verdict(PLAIN, holder(5_000, { at: "not-a-date" })).ok, true, "an unparseable heartbeat proves nothing");
  // Clock anomaly: a heartbeat from the future (skewed container, NFS, a
  // hand-edited file). The gate's usual direction is fail-CLOSED; here the
  // thing being decided is whether to refuse a human's own checkout, so it is
  // deliberately the other way.
  assert.equal(verdict(PLAIN, holder(-60_000)).ok, true, "a future heartbeat is a broken clock, not a live session");
  // Cross-host is NOT an exemption: a fresh heartbeat means somebody is live
  // in this worktree, whichever machine wrote it (that is the case that most
  // needs refusing on a shared mount).
  assert.equal(verdict(PLAIN, holder(5_000, { host: "some-other-box" })).ok, false,
    "host takes no part in the decision");
});

test("a session never refuses ITSELF (a same-id restart resumes its own claim)", () => {
  const mine = holder(5_000, { sessionId: "session-mine" });
  assert.equal(verdict(PLAIN, mine, "session-mine").ok, true, "our own record is not an incumbent");
  assert.equal(verdict(PLAIN, mine, null).ok, false,
    "…but an unidentifiable session cannot claim somebody else's record as its own");
});

test("presence records round-trip, and a corrupt one reads as no holder", () => {
  const rec = presenceFor("session-mine", 99, "box", NOW);
  assert.deepEqual(parsePresence(JSON.stringify(rec)), rec);
  assert.equal(parsePresence(undefined), undefined, "no file");
  assert.equal(parsePresence("not json"), undefined);
  assert.equal(parsePresence(JSON.stringify({ at: "x" })), undefined, "no session id ⇒ no holder");
  assert.equal(parsePresence(JSON.stringify({ sessionId: "s" })), undefined, "no heartbeat ⇒ no holder");
  // The diagnostic fields are allowed to be missing — they decide nothing, so
  // losing them must not invalidate a live claim.
  const thin = parsePresence(JSON.stringify({ sessionId: "s", at: rec.at }));
  assert.equal(thin?.sessionId, "s");
  assert.equal(thin?.pid, -1);
  assert.equal(thin?.host, "unknown");
});

test("only the holder clears its own record on the way out", () => {
  const mine = holder(1_000, { sessionId: "session-mine" });
  assert.equal(presenceIsOurs(mine, "session-mine"), true);
  assert.equal(presenceIsOurs(mine, "session-other"), false,
    "a refused session must not delete the live holder's claim as it exits");
  assert.equal(presenceIsOurs(undefined, "session-mine"), false);
  assert.equal(presenceIsOurs(mine, null), false);
});

// ---------------------------------------------------------------------------
// THE HEIR TAKES OVER — a successor must not be refused by the session it
// replaces. MEASURED (2026-09-10, rebate): `orchestrator_handoff` opens its
// successor in the SAME worktree on purpose (that is how one orchestration
// keeps reaching its children), and the guard refused it with a message
// naming the very session that had just handed over. The successor's pi then
// exited — the handoff reported success and left nobody holding the plan.
// ---------------------------------------------------------------------------

/** The heir of `session-incumbent`, in an ordinary (claiming) session. */
function heir(existing: PresenceRecord | undefined, successorOf: string | undefined) {
  return checkSessionExclusivity({
    env: PLAIN,
    sessionId: "session-successor",
    existing,
    ...(successorOf === undefined ? {} : { successorOf }),
    repoRoot: REPO,
    now: NOW,
  });
}

test("a successor takes the claim over from the session it replaces", () => {
  const v = heir(holder(1_000), "session-incumbent");
  assert.equal(v.ok, true,
    "the heartbeat is fresh and the answer is still yes: being the named heir IS the takeover — winning a race against a file deletion is not");
});

test("a fresh heartbeat is still the reason to refuse when the heir is not named", () => {
  assert.equal(heir(holder(1_000), undefined).ok, false,
    "no takeover claim ⇒ the ordinary rule stands, or every second session would walk in");
});

test("naming somebody ELSE as the predecessor is not a takeover", () => {
  const v = heir(holder(1_000), "session-somebody-else");
  assert.equal(v.ok, false,
    "the claim is the HEIRSHIP relation, not the presence of the variable — a stale or forged id must not open an occupied checkout");
});

test("an empty or blank predecessor id is treated as absent", () => {
  assert.equal(heir(holder(1_000), "").ok, false);
  assert.equal(heir(holder(1_000), "   ").ok, false);
});

test("a lapsed holder is taken over with or without an heirship claim", () => {
  assert.equal(heir(holder(PRESENCE_FRESH_MS + 1), undefined).ok, true,
    "the ordinary lapse path is unchanged");
  assert.equal(heir(holder(PRESENCE_FRESH_MS + 1), "session-incumbent").ok, true);
});

test("an heirship claim does not exempt a session that claims no sidecar", () => {
  // A judge or a child never claims the main sidecar, so the guard returns
  // before it looks at any holder — the new field must not have moved that
  // precedence.
  assert.equal(
    checkSessionExclusivity({
      env: JUDGE, sessionId: "session-judge", existing: holder(1_000),
      successorOf: "session-incumbent", repoRoot: REPO, now: NOW,
    }).ok,
    true,
  );
});
