import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  blockedMarkerPath,
  parseBlockedMarker,
  recordBlockedMarker,
  reconcileBlockedMarker,
  reconcileBlockedOwners,
  upsertBlockedOwner,
  type BlockedMarker,
  type BlockedOwner,
} from "../lib/blocked-marker.ts";
import { CONCURRENT_SESSION_WINDOW_MS } from "../lib/constants.ts";
import { isGateOwnedPath } from "../lib/fingerprint.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function owner(over: Partial<BlockedOwner> = {}): BlockedOwner {
  return {
    sessionId: "s-other",
    pid: 4242,
    host: "box",
    at: new Date(NOW - 1000).toISOString(),
    ...over,
  };
}

function marker(...owners: BlockedOwner[]): BlockedMarker {
  return { schema: 1, owners };
}

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "blocked-marker-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  return root;
}

function sidecarIn(root: string): string {
  return join(root, ".pi", "review-gate-state.json");
}

// ---------------------------------------------------------------------------
// parseBlockedMarker

test("a well-formed marker parses; legacy/corrupt content never does", () => {
  const good = JSON.stringify(marker(owner()));
  assert.deepEqual(parseBlockedMarker(good), marker(owner()));

  for (const raw of [
    "FAILED_WRITE",                                     // the legacy plain-text marker
    "",                                                 // truncated to nothing
    '{"schema":1,"owners":[{"sessionId":"a","pid":1,',  // truncated JSON
    '{"schema":2,"owners":[]}',                         // unknown schema
    '{"schema":1}',                                     // no owners array
    '{"schema":1,"owners":{}}',                         // owners not an array
    "[]",                                               // not an object shape
    "null",
  ]) {
    assert.equal(parseBlockedMarker(raw), null, `must not parse: ${raw}`);
  }
});

test("ONE malformed owner invalidates the whole marker (never silently dropped)", () => {
  // Dropping the bad entry would shrink the owner set, and an owner set that
  // reaches zero gets the file deleted — a corrupt byte must not be able to
  // delete a live session's fail-closed signal.
  for (const bad of [
    { pid: 1, host: "h", at: new Date(NOW).toISOString() },              // no sessionId key
    { sessionId: 1, pid: 1, host: "h", at: new Date(NOW).toISOString() }, // wrong type
    { sessionId: "a", pid: 1.5, host: "h", at: new Date(NOW).toISOString() },
    { sessionId: "a", pid: 1, host: 2, at: new Date(NOW).toISOString() },
    { sessionId: "a", pid: 1, host: "h", at: "not-a-date" },
    { sessionId: "a", pid: 1, host: "h" },
    null,
  ]) {
    const raw = JSON.stringify({ schema: 1, owners: [owner(), bad] });
    assert.equal(parseBlockedMarker(raw), null, `must reject the file: ${JSON.stringify(bad)}`);
  }
});

test("an empty owners array is valid and reclaimable (an abandoned shell)", () => {
  assert.deepEqual(parseBlockedMarker('{"schema":1,"owners":[]}'), marker());
});

// ---------------------------------------------------------------------------
// upsertBlockedOwner

test("upsert keys on sessionId, so repeated failures do not grow the file", () => {
  const mine = owner({ sessionId: "mine", at: new Date(NOW).toISOString() });
  const again = owner({ sessionId: "mine", at: new Date(NOW + 5).toISOString() });
  const after = upsertBlockedOwner(upsertBlockedOwner(marker(owner()), mine), again);
  assert.equal(after.owners.length, 2);
  assert.deepEqual(after.owners.map((o) => o.sessionId), ["s-other", "mine"]);
  assert.equal(after.owners[1].at, again.at, "the newer failure timestamp must win");
});

test("anonymous (null sessionId) failures each add their own owner", () => {
  // Without an identity we cannot prove two failures came from one process, so
  // collapsing them could drop a live session's claim.
  const anon = owner({ sessionId: null });
  const after = upsertBlockedOwner(upsertBlockedOwner(marker(), anon), anon);
  assert.equal(after.owners.length, 2);
});

// ---------------------------------------------------------------------------
// reconcileBlockedOwners

test("reclaims our own owner and silent-past-the-window orphans, keeps the rest", () => {
  const mine = owner({ sessionId: "mine", at: new Date(NOW).toISOString() });
  const liveOther = owner({ sessionId: "live", at: new Date(NOW - 1000).toISOString() });
  const orphan = owner({
    sessionId: "dead",
    at: new Date(NOW - CONCURRENT_SESSION_WINDOW_MS - 1).toISOString(),
  });

  const res = reconcileBlockedOwners(marker(mine, liveOther, orphan), "mine", NOW);
  assert.deepEqual(res.survivors.map((o) => o.sessionId), ["live"]);
  assert.equal(res.changed, true);
});

test("a concurrent session's fresh owner is NEVER reclaimed (the fail-open this fixes)", () => {
  const liveOther = owner({ sessionId: "live", at: new Date(NOW).toISOString() });
  const res = reconcileBlockedOwners(marker(liveOther), "mine", NOW);
  assert.deepEqual(res.survivors, [liveOther]);
  assert.equal(res.changed, false);
});

test("future timestamps (clock skew on a shared checkout) are kept, not reclaimed", () => {
  const skewed = owner({ sessionId: "live", at: new Date(NOW + 60_000).toISOString() });
  assert.equal(reconcileBlockedOwners(marker(skewed), "mine", NOW).survivors.length, 1);
});

test("an anonymous session reclaims nothing by identity (only by age)", () => {
  // sessionId null must not match other anonymous owners: that would delete a
  // live headless session's signal.
  const anonFresh = owner({ sessionId: null, at: new Date(NOW).toISOString() });
  const anonOld = owner({
    sessionId: null,
    at: new Date(NOW - CONCURRENT_SESSION_WINDOW_MS - 1).toISOString(),
  });
  const res = reconcileBlockedOwners(marker(anonFresh, anonOld), null, NOW);
  assert.deepEqual(res.survivors, [anonFresh]);
});

// ---------------------------------------------------------------------------
// recordBlockedMarker (IO)

test("a write failure creates a JSON marker owned by this session", () => {
  const root = tmpRepo();
  try {
    const path = blockedMarkerPath(sidecarIn(root));
    recordBlockedMarker(path, { sessionId: "mine", nowMs: NOW });
    const parsed = parseBlockedMarker(readFileSync(path, "utf8"));
    assert.ok(parsed, "the marker must be parsable by the extension");
    assert.equal(parsed.owners.length, 1);
    assert.equal(parsed.owners[0].sessionId, "mine");
    assert.equal(parsed.owners[0].pid, process.pid);
    assert.equal(parsed.owners[0].at, new Date(NOW).toISOString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two sessions failing in the same repo both hold the marker", () => {
  const root = tmpRepo();
  try {
    const path = blockedMarkerPath(sidecarIn(root));
    recordBlockedMarker(path, { sessionId: "a", nowMs: NOW });
    recordBlockedMarker(path, { sessionId: "b", nowMs: NOW });
    const parsed = parseBlockedMarker(readFileSync(path, "utf8"));
    assert.deepEqual(parsed?.owners.map((o) => o.sessionId), ["a", "b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unparsable marker is left byte-for-byte alone by a new failure", () => {
  const root = tmpRepo();
  try {
    const path = blockedMarkerPath(sidecarIn(root));
    writeFileSync(path, "FAILED_WRITE");
    recordBlockedMarker(path, { sessionId: "mine", nowMs: NOW });
    assert.equal(readFileSync(path, "utf8"), "FAILED_WRITE",
      "it already blocks commits; overwriting would destroy the evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// reconcileBlockedMarker (IO)

test("reconcile removes the file only when every owner was reclaimed", () => {
  const root = tmpRepo();
  try {
    const path = blockedMarkerPath(sidecarIn(root));
    recordBlockedMarker(path, { sessionId: "mine", nowMs: NOW });
    assert.equal(reconcileBlockedMarker(path, { sessionId: "mine", nowMs: NOW }), "removed");
    assert.equal(existsSync(path), false);
    assert.equal(reconcileBlockedMarker(path, { sessionId: "mine", nowMs: NOW }), "absent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcile rewrites the file when a foreign owner survives", () => {
  const root = tmpRepo();
  try {
    const path = blockedMarkerPath(sidecarIn(root));
    recordBlockedMarker(path, { sessionId: "mine", nowMs: NOW });
    recordBlockedMarker(path, { sessionId: "live", nowMs: NOW });
    assert.equal(reconcileBlockedMarker(path, { sessionId: "mine", nowMs: NOW }), "rewritten");
    assert.equal(existsSync(path), true, "the concurrent session still fails closed");
    const parsed = parseBlockedMarker(readFileSync(path, "utf8"));
    assert.deepEqual(parsed?.owners.map((o) => o.sessionId), ["live"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcile keeps an unparsable marker untouched (needs one manual cleanup)", () => {
  const root = tmpRepo();
  try {
    const path = blockedMarkerPath(sidecarIn(root));
    writeFileSync(path, "FAILED_WRITE");
    assert.equal(reconcileBlockedMarker(path, { sessionId: "mine", nowMs: NOW }), "kept-unparsable");
    assert.equal(readFileSync(path, "utf8"), "FAILED_WRITE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcile leaves a marker held only by a live foreign session", () => {
  const root = tmpRepo();
  try {
    const path = blockedMarkerPath(sidecarIn(root));
    recordBlockedMarker(path, { sessionId: "live", nowMs: NOW });
    assert.equal(reconcileBlockedMarker(path, { sessionId: "mine", nowMs: NOW }), "kept");
    assert.equal(existsSync(path), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a hand-written owner-less shell is reclaimed (it blocks with no signal behind it)", () => {
  const root = tmpRepo();
  try {
    const path = blockedMarkerPath(sidecarIn(root));
    writeFileSync(path, '{"schema":1,"owners":[]}');
    assert.equal(reconcileBlockedMarker(path, { sessionId: "mine", nowMs: NOW }), "removed");
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each repo's marker is reclaimed against its own path only", () => {
  const a = tmpRepo();
  const b = tmpRepo();
  try {
    const markerA = blockedMarkerPath(sidecarIn(a));
    const markerB = blockedMarkerPath(sidecarIn(b));
    recordBlockedMarker(markerA, { sessionId: "mine", nowMs: NOW });
    recordBlockedMarker(markerB, { sessionId: "live", nowMs: NOW });

    assert.equal(reconcileBlockedMarker(markerA, { sessionId: "mine", nowMs: NOW }), "removed");
    assert.equal(existsSync(markerA), false);
    assert.equal(existsSync(markerB), true,
      "a successful write in repo A says nothing about repo B's failed one");
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("marker writes never leave a temp file behind in .pi/", () => {
  const root = tmpRepo();
  try {
    const path = blockedMarkerPath(sidecarIn(root));
    recordBlockedMarker(path, { sessionId: "mine", nowMs: NOW });
    assert.equal(existsSync(`${path}.tmp-${process.pid}`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cross-cutting invariants

test("the marker is gate-owned, so writing it can never arm the gate", () => {
  const root = tmpRepo();
  try {
    assert.equal(isGateOwnedPath(blockedMarkerPath(sidecarIn(root)), root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the pre-commit hook still tests EXISTENCE only and never parses the marker", () => {
  // Load-bearing for upgrades: an OLD extension still writes the legacy
  // plain-text marker, and a hook that parsed it would have to decide what an
  // unparsable file means — the one place where guessing means fail-open.
  const hook = readFileSync(join(ROOT, "hooks", "pre-commit"), "utf8");
  assert.match(hook, /if \[\[ -f "\$\{STATE_FILE\}\.blocked" \]\]; then/,
    "the hook must keep the single fixed marker path and a bare existence test");
  const refs = hook.split("\n").filter((l) => l.includes("${STATE_FILE}.blocked"));
  assert.equal(refs.length, 1, `the hook must reference the marker path once: ${refs.join(" | ")}`);
  assert.doesNotMatch(hook, /owners/, "the hook must never read marker contents");
  assert.doesNotMatch(hook, /blocked[^\n]*\$\(cat|cat[^\n]*\.blocked/,
    "the hook must not read the marker file");
});
