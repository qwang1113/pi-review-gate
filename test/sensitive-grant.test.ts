import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SENSITIVE_GRANT_TTL_MS,
  addGrant,
  consumeGrant,
  findGrant,
  isGateIntegrityPath,
  normalizeSensitivePath,
  type SensitiveGrant,
} from "../lib/sensitive-grant.ts";
import { isSensitiveFile } from "../lib/constants.ts";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function grant(over: Partial<SensitiveGrant> = {}): SensitiveGrant {
  return {
    path: "/repo/.env",
    at: new Date(NOW).toISOString(),
    expiresAt: NOW + SENSITIVE_GRANT_TTL_MS,
    reason: "set API_BASE",
    ...over,
  };
}

test("normalizeSensitivePath resolves relative paths against the session cwd", () => {
  assert.equal(normalizeSensitivePath(".env", "/repo"), "/repo/.env");
  assert.equal(normalizeSensitivePath("/other/.env", "/repo"), "/other/.env");
});

test("normalizeSensitivePath collapses .. so one file cannot hold two grant keys", () => {
  // Without this, a grant for /repo/.env would not cover an edit spelled
  // /repo/sub/../.env — or, far worse, the reverse could be used to claim a
  // grant was already issued for a path the user never saw.
  assert.equal(normalizeSensitivePath("sub/../.env", "/repo"), "/repo/.env");
  assert.equal(normalizeSensitivePath("/repo/./sub/../.env", "/anywhere"), "/repo/.env");
});

test("SECURITY: gate-integrity paths are git internals only, never .gitignore/.github", () => {
  assert.equal(isGateIntegrityPath("/repo/.git/hooks/pre-commit"), true);
  assert.equal(isGateIntegrityPath("/repo/.git"), true);
  assert.equal(isGateIntegrityPath("/repo/.git/config"), true);
  assert.equal(isGateIntegrityPath("/repo/.gitignore"), false);
  assert.equal(isGateIntegrityPath("/repo/.github/workflows/ci.yml"), false);
  assert.equal(isGateIntegrityPath("/repo/.env"), false);
});

test("SECURITY: everything non-grantable is also blocked by the sensitive-file guard", () => {
  // isGateIntegrityPath only ever REMOVES the dialog option; if it ever matched
  // a path the guard lets through, it would refuse a request for a file the
  // agent can already edit — confusing, and a sign the two regexes drifted.
  for (const p of ["/repo/.git", "/repo/.git/hooks/pre-commit", "/repo/sub/.git/config"]) {
    assert.equal(isGateIntegrityPath(p), true, p);
    assert.equal(isSensitiveFile(p), true, p);
  }
});

test("SECURITY: the grant TTL stays short (canary against silently widening consent)", () => {
  assert.ok(SENSITIVE_GRANT_TTL_MS > 0);
  assert.ok(SENSITIVE_GRANT_TTL_MS <= 15 * 60 * 1000,
    "an unused sensitive-file authorization must not outlive the exchange that asked for it");
});

test("findGrant matches the exact path only", () => {
  const grants = [grant()];
  assert.ok(findGrant(grants, "/repo/.env", NOW));
  assert.equal(findGrant(grants, "/repo/.env.local", NOW), undefined);
  assert.equal(findGrant(grants, "/other/.env", NOW), undefined);
  assert.equal(findGrant([], "/repo/.env", NOW), undefined);
});

test("SECURITY: an expired grant never matches, including exactly at the deadline", () => {
  const grants = [grant({ expiresAt: NOW })];
  assert.equal(findGrant(grants, "/repo/.env", NOW), undefined);
  assert.equal(findGrant(grants, "/repo/.env", NOW + 1), undefined);
  assert.ok(findGrant(grants, "/repo/.env", NOW - 1));
});

test("addGrant replaces the grant for the same path and prunes expired ones", () => {
  const stale = grant({ path: "/repo/old.pem", expiresAt: NOW - 1 });
  const previous = grant({ reason: "first ask", expiresAt: NOW + 1000 });
  const fresh = grant({ reason: "second ask" });

  const next = addGrant([stale, previous], fresh, NOW);

  assert.deepEqual(next.map((g) => g.path), ["/repo/.env"]);
  assert.equal(next[0].reason, "second ask");
});

test("addGrant keeps live grants for other paths", () => {
  const other = grant({ path: "/repo/credentials.json" });
  const next = addGrant([other], grant(), NOW);
  assert.deepEqual(next.map((g) => g.path).sort(), ["/repo/.env", "/repo/credentials.json"]);
});

test("SECURITY: consumeGrant is single-use — one dialog buys exactly one landed edit", () => {
  const first = consumeGrant([grant()], "/repo/.env", NOW);
  assert.ok(first.consumed);
  assert.deepEqual(first.remaining, []);

  const second = consumeGrant(first.remaining, "/repo/.env", NOW);
  assert.equal(second.consumed, undefined);
});

test("consumeGrant leaves other paths' grants alone", () => {
  const keep = grant({ path: "/repo/credentials.json" });
  const { consumed, remaining } = consumeGrant([grant(), keep], "/repo/.env", NOW);
  assert.equal(consumed?.path, "/repo/.env");
  assert.deepEqual(remaining, [keep]);
});

test("consumeGrant on an unrelated path consumes nothing but still prunes expired entries", () => {
  const live = grant();
  const dead = grant({ path: "/repo/old.pem", expiresAt: NOW - 1 });
  const { consumed, remaining } = consumeGrant([live, dead], "/repo/src/index.ts", NOW);
  assert.equal(consumed, undefined);
  assert.deepEqual(remaining, [live]);
});

test("the grant list is never mutated in place", () => {
  const original = [grant()];
  const snapshot = [...original];
  addGrant(original, grant({ path: "/repo/id_rsa" }), NOW);
  consumeGrant(original, "/repo/.env", NOW);
  assert.deepEqual(original, snapshot);
});
