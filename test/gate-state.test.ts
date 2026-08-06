import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  emptyState,
  isPlateaued,
  isOscillating,
  countOscillations,
  loadSidecar,
  migrateFingerprintVersion,
  FINGERPRINT_MIGRATION_NOTICE,
  saveSidecar,
  shouldStrategicReset,
  sidecarPath,
  unmetRequirements,
  type GateState,
  type RoundRecord,
  type GateVerdict,
} from "../lib/gate-state.ts";
import { FINGERPRINT_VERSION } from "../lib/fingerprint.ts";

const tempDirs: string[] = [];
function makeTemp(): string {
  const d = mkdtempSync(join(tmpdir(), "rg-state-"));
  tempDirs.push(d);
  return d;
}
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const FP = "f".repeat(64);
const OTHER_FP = "0".repeat(64);

function readyState(): GateState {
  const s = emptyState("sess1", 10);
  s.hasCodeChange = true;
  s.review = { verdict: "READY", fingerprint: FP, at: "t" };
  s.precommit = { verdict: "PASS", fingerprint: FP, at: "t" };
  return s;
}

// ---------------------------------------------------------------------------
// unmetRequirements — the single ship authority
// ---------------------------------------------------------------------------

test("task mode is optional and invalid persisted values fail closed to unchosen", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-task-mode-"));
  const path = join(dir, "state.json");
  try {
    const state = emptyState("s", 10);
    for (const mode of ["explore", "loop", "normal"] as const) {
      state.taskMode = mode;
      writeFileSync(path, JSON.stringify(state));
      assert.equal(loadSidecar(path)?.taskMode, mode);
    }

    // Unknown values (including the retired "readonly") fail closed to unchosen.
    for (const bad of ["readonly", "disabled"]) {
      writeFileSync(path, JSON.stringify({ ...state, taskMode: bad }));
      assert.equal(loadSidecar(path)?.taskMode, undefined, bad);
    }

    // taskModeSource: valid values round-trip; forged values fail closed to
    // absent (treated as "auto" — the hook stays fully enforced).
    writeFileSync(path, JSON.stringify({ ...state, taskModeSource: "user" }));
    assert.equal(loadSidecar(path)?.taskModeSource, "user");
    writeFileSync(path, JSON.stringify({ ...state, taskModeSource: "root" }));
    assert.equal(loadSidecar(path)?.taskModeSource, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("all gates met on same fingerprint → ship allowed", () => {
  assert.deepEqual(unmetRequirements(readyState(), FP, false), []);
});

// ---------------------------------------------------------------------------
// pausedQuestion — agent-requested loop pause (pause_for_question tool)
// ---------------------------------------------------------------------------

test("pausedQuestion: valid shape round-trips through the sidecar", () => {
  const dir = makeTemp();
  const path = join(dir, "state.json");
  const s = emptyState("s", 10);
  s.pausedQuestion = { question: "Which auth provider should I use?", at: "2026-01-01T00:00:00Z" };
  writeFileSync(path, JSON.stringify(s));
  assert.deepEqual(loadSidecar(path)?.pausedQuestion, s.pausedQuestion);
});

test("pausedQuestion: malformed shapes fail toward NOT paused (loop stays armed)", () => {
  const dir = makeTemp();
  const path = join(dir, "state.json");
  const base = emptyState("s", 10);
  for (const bad of [
    "just a string",
    42,
    null,
    { question: 42, at: "t" },
    { question: "q" }, // missing at
    { at: "t" }, // missing question
  ]) {
    writeFileSync(path, JSON.stringify({ ...base, pausedQuestion: bad }));
    const loaded = loadSidecar(path);
    assert.ok(loaded, `sidecar itself must stay valid for ${JSON.stringify(bad)}`);
    assert.equal(loaded?.pausedQuestion, undefined, JSON.stringify(bad));
  }
});

test("pausedQuestion NEVER affects the ship authority (tighten-only invariant)", () => {
  // A pause only relaxes auto-continuation; unmetRequirements must be blind
  // to it in both directions: gates met stay met, gates unmet stay unmet.
  const ready = readyState();
  ready.pausedQuestion = { question: "q", at: "t" };
  assert.deepEqual(unmetRequirements(ready, FP, false), []);

  const pending = emptyState("s", 10);
  pending.hasCodeChange = true;
  pending.pausedQuestion = { question: "q", at: "t" };
  const problems = unmetRequirements(pending, FP, false);
  assert.ok(problems.length > 0, "unmet gates must remain unmet while paused");
});

// ---------------------------------------------------------------------------
// scopeLimit — user-granted review-scope limit (request_scope_limit tool)
// ---------------------------------------------------------------------------

test("scopeLimit: valid shape round-trips through the sidecar", () => {
  const dir = makeTemp();
  const path = join(dir, "state.json");
  const s = emptyState("s", 10);
  s.scopeLimit = {
    preexistingFiles: ["src/old.ts", "docs/old.md"],
    sessionFiles: ["src/new.ts"],
    at: "2026-01-01T00:00:00Z",
  };
  writeFileSync(path, JSON.stringify(s));
  assert.deepEqual(loadSidecar(path)?.scopeLimit, s.scopeLimit);
});

test("scopeLimit: malformed shapes fail toward ABSENT (full-scope gate)", () => {
  const dir = makeTemp();
  const path = join(dir, "state.json");
  const base = emptyState("s", 10);
  for (const bad of [
    "just a string",
    42,
    null,
    { preexistingFiles: "not-array", sessionFiles: [], at: "t" },
    { preexistingFiles: [42], sessionFiles: [], at: "t" },
    { preexistingFiles: [], sessionFiles: [null], at: "t" },
    { preexistingFiles: [], sessionFiles: [] }, // missing at
    { sessionFiles: [], at: "t" }, // missing preexistingFiles
  ]) {
    writeFileSync(path, JSON.stringify({ ...base, scopeLimit: bad }));
    const loaded = loadSidecar(path);
    assert.ok(loaded, `sidecar itself must stay valid for ${JSON.stringify(bad)}`);
    assert.equal(loaded?.scopeLimit, undefined, JSON.stringify(bad));
  }
});

test("sessionEditedFiles: valid shape round-trips; malformed shapes fail toward ABSENT", () => {
  const dir = makeTemp();
  const path = join(dir, "state.json");
  const s = emptyState("s", 10);
  s.sessionEditedFiles = ["src/new.ts", "docs/x.md"];
  writeFileSync(path, JSON.stringify(s));
  assert.deepEqual(loadSidecar(path)?.sessionEditedFiles, s.sessionEditedFiles);

  const base = emptyState("s", 10);
  for (const bad of ["str", 42, { 0: "a" }, [1, 2], ["ok", null]]) {
    writeFileSync(path, JSON.stringify({ ...base, sessionEditedFiles: bad }));
    const loaded = loadSidecar(path);
    assert.ok(loaded, `sidecar itself must stay valid for ${JSON.stringify(bad)}`);
    assert.equal(loaded?.sessionEditedFiles, undefined, JSON.stringify(bad));
  }
});

test("scopeLimit NEVER affects the ship authority directly (arming flags decide)", () => {
  // The scope limit changes what ARMS the gate (hasCodeChange/hasDocChange,
  // maintained by the extension); unmetRequirements must be blind to it.
  const ready = readyState();
  ready.scopeLimit = { preexistingFiles: ["a.ts"], sessionFiles: ["b.ts"], at: "t" };
  assert.deepEqual(unmetRequirements(ready, FP, false), []);

  const pending = emptyState("s", 10);
  pending.hasCodeChange = true; // session's own edits stay fully gated
  pending.scopeLimit = { preexistingFiles: ["a.ts"], sessionFiles: ["b.ts"], at: "t" };
  const problems = unmetRequirements(pending, FP, false);
  assert.ok(problems.length > 0, "session edits must remain gated under a scope limit");
});

// ---------------------------------------------------------------------------
// docSync knob — code↔doc attestation enforcement
// ---------------------------------------------------------------------------

test("docSync disabled (requireDocSync false/absent): READY review without attestation ships", () => {
  // The project default is docSync ON — callers pass projectConfig.docSync.
  // This covers the explicit `"docSync": false` project opt-out path.
  assert.deepEqual(unmetRequirements(readyState(), FP, false), []);
  assert.deepEqual(unmetRequirements(readyState(), FP, false, { requireDocSync: false }), []);
});

test("docSync enforced: READY review lacking attestation blocks (fail-closed)", () => {
  const problems = unmetRequirements(readyState(), FP, false, { requireDocSync: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /docSync enforced/);
});

test("docSync enforced: UPDATED and NOT_NEEDED attestations both ship", () => {
  for (const att of ["UPDATED", "NOT_NEEDED"] as const) {
    const s = readyState();
    s.review.docSync = att;
    assert.deepEqual(unmetRequirements(s, FP, false, { requireDocSync: true }), [], att);
  }
});

test("docSync enforced on EVERY code change — touching a doc file does not exempt", () => {
  // Anti-gaming: the attestation is required even when hasDocChange is true,
  // so trivially appending to a .md cannot satisfy the gate.
  const s = readyState();
  s.hasDocChange = true;
  const problems = unmetRequirements(s, FP, false, { requireDocSync: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /docSync enforced/);
});

test("docSync enforcement does not fire for non-READY reviews (verdict blocks first)", () => {
  const s = readyState();
  s.review.verdict = "PENDING";
  const problems = unmetRequirements(s, FP, false, { requireDocSync: true });
  assert.ok(problems.some((p) => /review gate is PENDING/.test(p)));
  assert.ok(!problems.some((p) => /docSync/.test(p)), "no redundant docSync problem before READY");
});

test("loadSidecar: valid docSync round-trips, forged values fail closed to absent", () => {
  const dir = makeTemp();
  const path = sidecarPath(dir);
  const s = readyState();
  s.review.docSync = "NOT_NEEDED";
  saveSidecar(path, s);
  assert.equal(loadSidecar(path)?.review.docSync, "NOT_NEEDED");

  const forged = JSON.parse(readFileSync(path, "utf8"));
  forged.review.docSync = "YES"; // not in the enum whitelist
  writeFileSync(path, JSON.stringify(forged));
  const loaded = loadSidecar(path);
  assert.ok(loaded, "sidecar with forged docSync still loads");
  assert.equal(loaded?.review.docSync, undefined, "forged attestation dropped (blocks under enforcement)");
});

test("missing state → fail closed", () => {
  assert.ok(unmetRequirements(undefined, FP, false).length > 0);
});

test("no changes tracked → ship allowed (pre-existing work)", () => {
  const s = emptyState("sess1", 10);
  assert.deepEqual(unmetRequirements(s, FP, false), []);
});

test("review PENDING blocks", () => {
  const s = readyState();
  s.review.verdict = "PENDING";
  assert.ok(unmetRequirements(s, FP, false).some((p) => p.includes("PENDING")));
});

test("review READY but fingerprint mismatch blocks (edit-after-review)", () => {
  const s = readyState();
  assert.ok(unmetRequirements(s, OTHER_FP, false).some((p) => p.includes("fingerprint mismatch")));
});

test("precommit NOT_RUN blocks", () => {
  const s = readyState();
  s.precommit = { verdict: "NOT_RUN", fingerprint: null, at: null };
  assert.ok(unmetRequirements(s, FP, false).some((p) => p.includes("not run")));
});

test("precommit FAIL blocks", () => {
  const s = readyState();
  s.precommit = { verdict: "FAIL", fingerprint: null, at: "t" };
  assert.ok(unmetRequirements(s, FP, false).some((p) => p.includes("FAILED")));
});

test("PR #7 lesson 3: precommit NO_CHECKS_RUN blocks (not a pass)", () => {
  const s = readyState();
  s.precommit = { verdict: "NO_CHECKS_RUN", fingerprint: null, at: "t" };
  assert.ok(unmetRequirements(s, FP, false).some((p) => p.includes("NO_CHECKS_RUN")));
});

test("precommit PASS on stale fingerprint blocks", () => {
  const s = readyState();
  s.precommit.fingerprint = OTHER_FP;
  assert.ok(unmetRequirements(s, FP, false).some((p) => p.includes("precommit PASS (fingerprint mismatch)")));
});

test("fingerprint unavailable → fail closed even when verdicts look good", () => {
  const s = readyState();
  assert.ok(unmetRequirements(s, "__UNAVAILABLE__", true).length > 0);
});

test("doc-only change: needs doc review READY, no precommit requirement", () => {
  const s = emptyState("sess1", 10);
  s.hasDocChange = true;
  assert.ok(unmetRequirements(s, FP, false).some((p) => p.includes("doc review")));
  s.review = { verdict: "READY", fingerprint: FP, at: "t" };
  assert.deepEqual(unmetRequirements(s, FP, false), []);
});

test("bypass overrides everything", () => {
  const s = emptyState("sess1", 10);
  s.hasCodeChange = true;
  s.bypass = { active: true, reason: "hotfix", at: "t" };
  assert.deepEqual(unmetRequirements(s, FP, false), []);
});

// ---------------------------------------------------------------------------
// Sidecar persistence — fail-closed on corruption
// ---------------------------------------------------------------------------

test("sidecar round-trip", () => {
  const dir = makeTemp();
  const path = sidecarPath(dir);
  const s = readyState();
  saveSidecar(path, s);
  const loaded = loadSidecar(path);
  assert.equal(loaded?.review.verdict, "READY");
  assert.equal(loaded?.precommit.verdict, "PASS");
});

test("corrupt sidecar JSON → undefined (fail closed)", () => {
  const dir = makeTemp();
  const path = sidecarPath(dir);
  saveSidecar(path, readyState());
  writeFileSync(path, '{"schema": 1, "review": {'); // truncate
  assert.equal(loadSidecar(path), undefined);
});

test("unknown schema → undefined (fail closed)", () => {
  const dir = makeTemp();
  const path = sidecarPath(dir);
  saveSidecar(path, readyState());
  writeFileSync(path, JSON.stringify({ schema: 99, review: { verdict: "READY" } }));
  assert.equal(loadSidecar(path), undefined);
});

test("missing sidecar → undefined", () => {
  assert.equal(loadSidecar(join(makeTemp(), "nope.json")), undefined);
});

// ---------------------------------------------------------------------------
// Plateau detection
// ---------------------------------------------------------------------------

function round(n: number, total: number | null, fps: string[]): RoundRecord {
  return { round: n, findingsTotal: total, fingerprints: fps, at: "t" };
}

test("plateau: same findings 3 rounds, non-decreasing → true", () => {
  const rounds = [
    round(1, 3, ["a#1#x", "b#2#y", "c#3#z"]),
    round(2, 3, ["a#1#x", "b#2#y", "c#3#z"]),
    round(3, 3, ["a#1#x", "b#2#y", "d#4#w"]),
  ];
  assert.ok(isPlateaued(rounds, 3));
});

test("converging (totals decreasing) → not plateaued", () => {
  const rounds = [round(1, 5, ["a#1#x"]), round(2, 3, ["a#1#x"]), round(3, 1, ["a#1#x"])];
  assert.ok(!isPlateaued(rounds, 3));
});

test("new issues each round (low overlap) → not plateaued", () => {
  const rounds = [
    round(1, 2, ["a#1#x", "b#1#y"]),
    round(2, 2, ["c#1#z", "d#1#w"]),
    round(3, 2, ["e#1#v", "f#1#u"]),
  ];
  assert.ok(!isPlateaued(rounds, 3));
});

test("unparseable totals (null) → not plateaued (rely on hard cap)", () => {
  const rounds = [round(1, null, []), round(2, null, []), round(3, null, [])];
  assert.ok(!isPlateaued(rounds, 3));
});

test("fewer rounds than window → not plateaued", () => {
  assert.ok(!isPlateaued([round(1, 3, ["a#1#x"])], 3));
});

// ---------------------------------------------------------------------------
// Oscillation detection (READY→BLOCKED thrash the plateau check cannot catch)
// ---------------------------------------------------------------------------

function vround(n: number, verdict: Exclude<GateVerdict, "PENDING">): RoundRecord {
  return { round: n, findingsTotal: verdict === "BLOCKED" ? 1 : 0, fingerprints: [], verdict, at: "t" };
}

test("oscillation: counts each READY→BLOCKED transition", () => {
  const rounds = [
    vround(1, "BLOCKED"),
    vround(2, "READY"),
    vround(3, "BLOCKED"), // flip 1
    vround(4, "READY"),
    vround(5, "BLOCKED"), // flip 2
  ];
  assert.equal(countOscillations(rounds), 2);
  assert.ok(!isOscillating(rounds, 3));
  assert.ok(isOscillating(rounds, 2));
});

test("oscillation: steady convergence (BLOCKED*→READY) never counts", () => {
  const rounds = [vround(1, "BLOCKED"), vround(2, "BLOCKED"), vround(3, "READY")];
  assert.equal(countOscillations(rounds), 0);
  assert.ok(!isOscillating(rounds, 1));
});

test("oscillation: BLOCKED after BLOCKED is not a flip (only READY→BLOCKED)", () => {
  const rounds = [vround(1, "READY"), vround(2, "BLOCKED"), vround(3, "BLOCKED")];
  assert.equal(countOscillations(rounds), 1);
});

test("oscillation: legacy rounds without a verdict never fabricate a flip", () => {
  const rounds: RoundRecord[] = [
    { round: 1, findingsTotal: 0, fingerprints: [], at: "t" }, // legacy: verdict absent
    vround(2, "BLOCKED"),
    { round: 3, findingsTotal: 0, fingerprints: [], at: "t" }, // legacy READY-ish, unknown
    vround(4, "BLOCKED"),
  ];
  // No known READY precedes either BLOCKED, so zero flips.
  assert.equal(countOscillations(rounds), 0);
});

test("oscillation: a legacy round between READY and BLOCKED is skipped, flip still seen", () => {
  const rounds: RoundRecord[] = [
    vround(1, "READY"),
    { round: 2, findingsTotal: 0, fingerprints: [], at: "t" }, // legacy gap
    vround(3, "BLOCKED"),
  ];
  assert.equal(countOscillations(rounds), 1);
});

// ---------------------------------------------------------------------------
// P1 fail-closed regression: unknown/forged verdicts must never fail-open.

test("loadSidecar rejects forged precommit.verdict='READY' (not a precommit enum)", () => {
  const p = sidecarPath(makeTemp());
  const bad = emptyState("sess1", 10);
  bad.hasCodeChange = true;
  bad.review = { verdict: "READY", fingerprint: FP, at: "t" };
  // "READY" is a REVIEW verdict, not a valid PRECOMMIT verdict.
  (bad.precommit as unknown as { verdict: string }).verdict = "READY";
  saveSidecar(p, emptyState("sess1", 10)); // create the .pi dir + a valid file first
  writeFileSync(p, JSON.stringify(bad));    // then overwrite with the forged payload
  assert.equal(loadSidecar(p), undefined, "forged precommit verdict must be rejected");
});

test("loadSidecar rejects unknown review.verdict", () => {
  const p = sidecarPath(makeTemp());
  const bad = emptyState("sess1", 10);
  (bad.review as unknown as { verdict: string }).verdict = "APPROVED";
  saveSidecar(p, emptyState("sess1", 10));
  writeFileSync(p, JSON.stringify(bad));
  assert.equal(loadSidecar(p), undefined);
});

test("unmetRequirements blocks an in-memory unknown precommit verdict (default-deny)", () => {
  const s = emptyState("sess1", 10);
  s.hasCodeChange = true;
  s.review = { verdict: "READY", fingerprint: FP, at: "t" };
  // Simulate a value that somehow bypassed the loader, bound to current FP.
  (s.precommit as unknown as { verdict: string; fingerprint: string }).verdict = "READY";
  s.precommit.fingerprint = FP;
  const problems = unmetRequirements(s, FP, false);
  assert.ok(problems.some((p) => /unrecognized/.test(p)), "unknown precommit verdict must block");
});

// ---------------------------------------------------------------------------
// shouldStrategicReset — sd0x-dev-flow R10 "Think Harder" firing predicate
// ---------------------------------------------------------------------------

function blockedNearCap(rounds: number, maxRounds = 10): GateState {
  const s = emptyState("sess1", maxRounds);
  s.hasCodeChange = true;
  s.review = { verdict: "BLOCKED", fingerprint: null, at: "t" };
  for (let i = 1; i <= rounds; i++) {
    s.rounds.push({ round: i, findingsTotal: 3, fingerprints: ["a#1#x"], at: "t" });
  }
  return s;
}

test("R10 fires: BLOCKED at maxRounds-offset", () => {
  assert.ok(shouldStrategicReset(blockedNearCap(7), true, 3)); // threshold = 10-3
});

test("R10 does not fire below threshold", () => {
  assert.ok(!shouldStrategicReset(blockedNearCap(6), true, 3));
});

test("R10 does not fire when thinkHarder disabled", () => {
  assert.ok(!shouldStrategicReset(blockedNearCap(9), false, 3));
});

test("R10 is one-shot: fired flag suppresses", () => {
  const s = blockedNearCap(8);
  s.strategicResetFired = true;
  assert.ok(!shouldStrategicReset(s, true, 3));
});

test("R10 does NOT consume the one-shot on non-BLOCKED verdicts (reviewer P1)", () => {
  // READY awaiting precommit, PENDING before first review, NEEDS_HUMAN already
  // escalated — none of these is "the loop is stuck"; none may fire.
  for (const v of ["READY", "PENDING", "NEEDS_HUMAN"] as const) {
    const s = blockedNearCap(8);
    s.review.verdict = v;
    assert.ok(!shouldStrategicReset(s, true, 3), v);
  }
});

test("R10 threshold floors at 1 for tiny maxRounds", () => {
  const s = blockedNearCap(1, 3); // threshold = max(1, 3-3) = 1
  assert.ok(shouldStrategicReset(s, true, 3));
});

test("R10 fired flag survives sidecar round-trip", () => {
  const p = sidecarPath(makeTemp());
  const s = blockedNearCap(8);
  s.strategicResetFired = true;
  saveSidecar(p, s);
  const loaded = loadSidecar(p);
  assert.ok(loaded);
  assert.equal(loaded!.strategicResetFired, true);
  assert.ok(!shouldStrategicReset(loaded!, true, 3));
});

test("legacy sidecar without strategicResetFired still validates (schema compat)", () => {
  const p = sidecarPath(makeTemp());
  const s = blockedNearCap(8);
  saveSidecar(p, s);
  // Simulate an old-version sidecar: strip the new optional field.
  const raw = JSON.parse(readFileSync(p, "utf8"));
  delete raw.strategicResetFired;
  writeFileSync(p, JSON.stringify(raw));
  const loaded = loadSidecar(p);
  assert.ok(loaded, "legacy schema-1 sidecar must still load");
  assert.ok(shouldStrategicReset(loaded!, true, 3), "absent flag ⇒ not fired");
});

// ---------------------------------------------------------------------------
// migrateFingerprintVersion(): the extension side of the same problem. A
// binding produced by a different algorithm cannot be verified by this one, so
// it is invalidated rather than trusted — but the CHANGE FLAGS must survive,
// otherwise the migration would disarm the gate instead of re-arming it.

test("loading a pre-versioning sidecar invalidates its bindings", () => {
  const state = emptyState("s", 10);
  state.hasCodeChange = true;
  state.review = { verdict: "READY", fingerprint: "old-algo-digest", at: "t", docSync: "UPDATED" };
  state.precommit = { verdict: "PASS", fingerprint: "old-algo-digest", at: "t" };
  delete (state as { fingerprintVersion?: number }).fingerprintVersion;

  assert.equal(migrateFingerprintVersion(state), true, "a real binding was dropped");
  assert.equal(state.review.verdict, "PENDING");
  assert.equal(state.review.fingerprint, null);
  assert.equal(state.precommit.verdict, "NOT_RUN");
  assert.equal(state.precommit.fingerprint, null);
  assert.equal(state.fingerprintVersion, FINGERPRINT_VERSION);
  assert.equal(state.hasCodeChange, true,
    "the worktree still holds uncommitted work — forgetting that would DISARM the gate");
});

test("a binding from a newer algorithm is invalidated too (never trusted forward)", () => {
  const state = emptyState("s", 10);
  state.hasCodeChange = true;
  state.review = { verdict: "READY", fingerprint: "future-digest", at: "t" };
  state.fingerprintVersion = FINGERPRINT_VERSION + 5;
  assert.equal(migrateFingerprintVersion(state), true);
  assert.equal(state.review.verdict, "PENDING");
  assert.equal(state.fingerprintVersion, FINGERPRINT_VERSION);
});

test("a current-version sidecar is left completely alone", () => {
  const state = emptyState("s", 10);
  state.hasCodeChange = true;
  state.review = { verdict: "READY", fingerprint: "current-digest", at: "t", docSync: "NOT_NEEDED" };
  state.precommit = { verdict: "PASS", fingerprint: "current-digest", at: "t" };
  assert.equal(migrateFingerprintVersion(state), false, "no migration should be reported");
  assert.equal(state.review.verdict, "READY");
  assert.equal(state.review.fingerprint, "current-digest");
  assert.equal(state.precommit.verdict, "PASS");
});

test("migrating a state that had no binding reports nothing to the user", () => {
  const state = emptyState("s", 10);
  delete (state as { fingerprintVersion?: number }).fingerprintVersion;
  assert.equal(migrateFingerprintVersion(state), false,
    "there was no READY/PASS to lose, so there is nothing to explain");
  assert.equal(state.fingerprintVersion, FINGERPRINT_VERSION);
});

test("loadSidecar applies the migration (bindings cannot survive an upgrade)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-mig-"));
  try {
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({
      schema: 1,
      sessionId: "s",
      hasCodeChange: true,
      hasDocChange: false,
      review: { verdict: "READY", fingerprint: "old-algo-digest", at: "t" },
      precommit: { verdict: "PASS", fingerprint: "old-algo-digest", at: "t" },
      rounds: [],
      maxRounds: 10,
      bypass: { active: false, reason: null, at: null },
      updatedAt: "t",
    }));
    const loaded = loadSidecar(path);
    assert.ok(loaded, "the sidecar shape is still valid, so it must load");
    assert.equal(loaded!.review.verdict, "PENDING", "the old-algorithm READY must not survive");
    assert.equal(loaded!.precommit.verdict, "NOT_RUN");
    assert.equal(loaded!.hasCodeChange, true);
    assert.equal(loaded!.fingerprintVersion, FINGERPRINT_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the migration notice explains the cause and the recovery steps", () => {
  // Without this the user only sees READY silently become PENDING.
  assert.match(FINGERPRINT_MIGRATION_NOTICE, /fingerprint algorithm changed/);
  assert.match(FINGERPRINT_MIGRATION_NOTICE, /code itself was NOT modified/);
  assert.match(FINGERPRINT_MIGRATION_NOTICE, /restart Pi/);
});

test("loadSidecar reports whether it invalidated a binding", () => {
  // The migration is applied inside loadSidecar so it can never be forgotten;
  // the consequence is that callers cannot detect it afterwards (the version
  // field is already updated). Without this out-parameter the user sees READY
  // become PENDING with no explanation.
  const dir = mkdtempSync(join(tmpdir(), "rg-mig2-"));
  try {
    const path = join(dir, "state.json");
    const base = {
      schema: 1,
      sessionId: "s",
      hasCodeChange: true,
      hasDocChange: false,
      review: { verdict: "READY", fingerprint: "old-algo-digest", at: "t" },
      precommit: { verdict: "PASS", fingerprint: "old-algo-digest", at: "t" },
      rounds: [],
      maxRounds: 10,
      bypass: { active: false, reason: null, at: null },
      updatedAt: "t",
    };

    // Unversioned (pre-migration) sidecar → migration reported.
    writeFileSync(path, JSON.stringify(base));
    const stale = { migrated: false };
    const loadedStale = loadSidecar(path, stale);
    assert.equal(stale.migrated, true, "an invalidated binding must be reported to the caller");
    assert.equal(loadedStale!.review.verdict, "PENDING");

    // Current-version sidecar → nothing to report.
    writeFileSync(path, JSON.stringify({ ...base, fingerprintVersion: FINGERPRINT_VERSION }));
    const fresh = { migrated: false };
    const loadedFresh = loadSidecar(path, fresh);
    assert.equal(fresh.migrated, false, "a current binding must not be reported as migrated");
    assert.equal(loadedFresh!.review.verdict, "READY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a migration is reported even when the sidecar had nothing else wrong", () => {
  // Regression guard for the double-consumption bug: calling the migration a
  // second time on an already-migrated state returns false, so the caller must
  // rely on the value loadSidecar handed back, not on a fresh call.
  const dir = mkdtempSync(join(tmpdir(), "rg-mig3-"));
  try {
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({
      schema: 1,
      sessionId: "s",
      hasCodeChange: true,
      hasDocChange: false,
      review: { verdict: "READY", fingerprint: "old", at: "t" },
      precommit: { verdict: "PASS", fingerprint: "old", at: "t" },
      rounds: [],
      maxRounds: 10,
      bypass: { active: false, reason: null, at: null },
      updatedAt: "t",
    }));
    const out = { migrated: false };
    const loaded = loadSidecar(path, out)!;
    assert.equal(out.migrated, true);
    assert.equal(migrateFingerprintVersion(loaded), false,
      "a second call cannot see the migration — this is why the out-parameter exists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
