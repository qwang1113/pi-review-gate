import test from "node:test";
import assert from "node:assert/strict";

import {
  ORCHESTRATION_ID_ENV,
  ORCHESTRATION_ID_PREFIX,
  supervisionTargetId,
  supervisionTarget,
  PARENT_SESSION_ENV,
  isOrchestrationTarget,
  newOrchestrationId,
  normalizeOrchestrationId,
  orchestrationIdFromEnv,
  orchestrationRepoHash,
  startupOrchestrationId,
} from "../lib/orchestration-id.ts";
import { channelDir } from "../lib/orchestrator-channel.ts";

test("a minted id names its repo and its start time", () => {
  const id = newOrchestrationId("/repo/a", 1_700_000_000_000);
  assert.ok(id.startsWith(ORCHESTRATION_ID_PREFIX));
  assert.equal(normalizeOrchestrationId(id), id, "a freshly minted id must validate");
  assert.match(id, new RegExp(`^${ORCHESTRATION_ID_PREFIX}${orchestrationRepoHash("/repo/a")}-`));
});

test("two repos never share an id, and neither do two runs of the same repo", () => {
  const a = newOrchestrationId("/repo/a", 1_700_000_000_000);
  const b = newOrchestrationId("/repo/b", 1_700_000_000_000);
  assert.notEqual(a, b, "different repos differ");
  const later = newOrchestrationId("/repo/a", 1_700_000_999_000);
  assert.notEqual(a, later,
    "a NEW orchestration of the same repo gets its own channel, so a stale child of the previous run cannot wake it");
});

test("normalization is fail-closed: only ids we could have minted are accepted", () => {
  for (const bad of [
    "",
    "   ",
    "session-123",                       // not our prefix
    "orch-",                             // no body
    "orch-abc",                          // one segment
    "orch-abc-def-ghi",                  // three segments
    "orch-abc-de f",                     // whitespace inside
    "orch-abc-de/f",                     // path separator
    "orch-abc-de;rm -rf /",              // shell metacharacters
    "orch-" + "a".repeat(80) + "-1",     // over the length cap
    undefined,
    null,
    42,
    { toString: () => "orch-aaa-bbb" },
  ] as unknown[]) {
    assert.equal(normalizeOrchestrationId(bad), undefined, `must refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(normalizeOrchestrationId("  orch-abc123-xyz  "), "orch-abc123-xyz", "surrounding space is trimmed");
});

test("an orchestration id BEATS a parent session id — the handover guarantee", () => {
  // This is the whole point: a child spawned by orchestrator A must reach
  // whoever HOLDS the orchestration now, not the session that started it.
  assert.equal(
    supervisionTargetId({ orchestrationId: "orch-abc123-xyz", parentSessionId: "retired-session" }),
    "orch-abc123-xyz",
  );
});

test("with no orchestration, the spawning session is the address (the judge case)", () => {
  assert.equal(supervisionTargetId({ parentSessionId: "session-9" }), "session-9");
  assert.equal(supervisionTargetId({ orchestrationId: "   ", parentSessionId: "session-9" }), "session-9",
    "a blank orchestration id falls back rather than addressing nobody");
  assert.equal(supervisionTargetId({ orchestrationId: "not-an-orch-id", parentSessionId: "session-9" }), "session-9",
    "a FORGED orchestration id is ignored, not used as a channel key");
});

test("with neither, nothing is addressed — a standalone session reports nowhere", () => {
  assert.equal(supervisionTargetId({}), undefined);
  assert.equal(supervisionTargetId({ parentSessionId: "  " }), undefined);
});

test("supervisionTarget reads both variables with the same precedence", () => {
  const orch = newOrchestrationId("/repo/a", 1_700_000_000_000);
  assert.equal(
    supervisionTarget({ [ORCHESTRATION_ID_ENV]: orch, [PARENT_SESSION_ENV]: "old-session" } as NodeJS.ProcessEnv),
    orch,
  );
  assert.equal(
    supervisionTarget({ [PARENT_SESSION_ENV]: "old-session" } as NodeJS.ProcessEnv),
    "old-session",
  );
  assert.equal(supervisionTarget({} as NodeJS.ProcessEnv), undefined);
});

test("the successor opens the very directory the children are already writing to", () => {
  // The handover's core promise, expressed as an equality: the channel
  // directory is named by the orchestration id, so it does not change when
  // the holder does. There is nothing to re-stamp and nothing to restart.
  const orch = newOrchestrationId("/repo/a", 1_700_000_000_000);
  const childAddress = supervisionTarget({
    [ORCHESTRATION_ID_ENV]: orch,
    [PARENT_SESSION_ENV]: "orchestrator-1",
  } as NodeJS.ProcessEnv);
  assert.equal(channelDir(childAddress!, "/home/t"), channelDir(orch, "/home/t"),
    "no child has to be restarted or re-stamped when the role changes hands");
});


test("orchestrationIdFromEnv validates rather than trusting the environment", () => {
  assert.equal(orchestrationIdFromEnv({ [ORCHESTRATION_ID_ENV]: "orch-abc-1" } as NodeJS.ProcessEnv), "orch-abc-1");
  assert.equal(orchestrationIdFromEnv({ [ORCHESTRATION_ID_ENV]: "../../etc" } as NodeJS.ProcessEnv), undefined);
  assert.equal(orchestrationIdFromEnv({} as NodeJS.ProcessEnv), undefined);
});

test("isOrchestrationTarget tells the two address kinds apart", () => {
  assert.equal(isOrchestrationTarget("orch-abc-1"), true);
  assert.equal(isOrchestrationTarget("some-session-id"), false);
  assert.equal(isOrchestrationTarget(undefined), false);
});

/**
 * WHICH ORCHESTRATION A PROCESS HOLDS WHEN IT STARTS (2026-09-17, measured
 * defect). A reload of the gate extension re-runs this module, and it used to
 * mint a fresh id — so the session's OWN children became "another
 * orchestration's": every spawn was refused, the manager reported "本编排目前
 * 没有存活的子会话" while two children were alive, and it marked their tasks
 * back to `pending` and spawned duplicates. The runtime was on disk the whole
 * time; only this rule was missing.
 */
test("startup: inherited beats the sidecar, the sidecar beats a new id, and a STRANGER's sidecar loses", () => {
  const env = {} as NodeJS.ProcessEnv;
  const inherited = newOrchestrationId("/repo/a", 1_700_000_000_000);
  const stored = newOrchestrationId("/repo/a", 1_699_000_000_000);
  const now = 1_700_500_000_000;

  // 1. The environment is a RELAY (or a child): it wins, always.
  assert.equal(
    startupOrchestrationId({
      env: { [ORCHESTRATION_ID_ENV]: inherited } as NodeJS.ProcessEnv,
      storedId: stored,
      storedBelongsToThisSession: true,
      repoRoot: "/repo/a",
      now,
    }),
    inherited,
    "a successor inherits the address it was started with",
  );

  // 2. The session's OWN sidecar: the same orchestration, resumed. This is the
  //    line whose absence was the defect.
  assert.equal(
    startupOrchestrationId({ env, storedId: stored, storedBelongsToThisSession: true, repoRoot: "/repo/a", now }),
    stored,
    "a reload of the same session keeps its orchestration — no takeover needed",
  );

  // 3. SOMEBODY ELSE'S sidecar: never adopted implicitly. That is the takeover
  //    case, and `orchestrator_attach` is the deliberate way in.
  const stranger = startupOrchestrationId({ env, storedId: stored, storedBelongsToThisSession: false, repoRoot: "/repo/a", now });
  assert.notEqual(stranger, stored, "a runtime belonging to another session is not re-stamped onto this one");
  assert.equal(normalizeOrchestrationId(stranger), stranger, "…and what it gets instead is a real new id");

  // 4. No sidecar at all: mint.
  const fresh = startupOrchestrationId({ env, storedId: undefined, storedBelongsToThisSession: false, repoRoot: "/repo/a", now });
  assert.equal(normalizeOrchestrationId(fresh), fresh);
  assert.notEqual(fresh, stored);
  assert.notEqual(fresh, inherited);

  // A corrupted stored id cannot ride in: the value still has to look minted.
  assert.equal(
    startupOrchestrationId({ env, storedId: "../../etc", storedBelongsToThisSession: true, repoRoot: "/repo/a", now }),
    newOrchestrationId("/repo/a", now),
    "garbage in the sidecar mints a fresh id rather than becoming an address",
  );
});
