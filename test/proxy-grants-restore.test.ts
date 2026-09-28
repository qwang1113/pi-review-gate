/**
 * Round 4: the PM's proxy grants survive the two restarts a real project
 * manager goes through — a same-session reload (pi's own session entries) and
 * a `session_handoff` successor reading the predecessor's sidecar — end to end
 * through `restore`, not only through the pure registry functions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ENTRY_TYPE, createSessionPersistence, type SessionPersistenceDeps } from "../lib/session-restore-host.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import { saveSidecarPreservingConcurrent } from "../lib/gate-state-io.ts";
import { sessionSidecarPath } from "../lib/loop-goal-host.ts";
import { hasGrant } from "../lib/orchestrator-registry.ts";
import { PREDECESSOR_SESSION_ENV } from "../lib/session-inheritance.ts";
import type { SessionCells } from "../lib/session-cells.ts";

function pmState(sessionId: string): GateState {
  const state = emptyState(sessionId, 30);
  state.taskMode = "orchestrator";
  state.orchestrator = {
    orchestrationId: "orch-abc123-def456",
    children: [],
    ownerSessionId: sessionId,
    grants: [{ scope: "tmux-access", grantedAt: "2026-09-28T00:00:00.000Z", via: "gate-grant" }],
  };
  return state;
}

function host(cwd: string) {
  const cells = { cwd, state: emptyState("x", 30), sessionRepos: new Set<string>() } as unknown as SessionCells;
  const deps = { pi: { appendEntry: () => {} } } as unknown as SessionPersistenceDeps;
  return { cells, persistence: createSessionPersistence(cells, deps) };
}

test("a same-session reload keeps the grants (session entries)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rg-grants-"));
  const { cells, persistence } = host(cwd);
  const ctx = { sessionManager: { getEntries: () => [{ customType: ENTRY_TYPE, data: { state: pmState("S1") } }] } };
  persistence.restore(ctx as never, "S1");
  assert.equal(hasGrant(cells.state.orchestrator!, "tmux-access"), true);
});

test("a handoff successor keeps the grants read back from the predecessor's sidecar; a plain new session does not", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rg-grants-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  saveSidecarPreservingConcurrent(sessionSidecarPath(cwd), pmState("S1"), () => null);
  const ctx = { sessionManager: { getEntries: () => [] } };

  const previous = process.env[PREDECESSOR_SESSION_ENV];
  try {
    process.env[PREDECESSOR_SESSION_ENV] = "S1";
    const successor = host(cwd);
    successor.persistence.restore(ctx as never, "S2");
    assert.equal(hasGrant(successor.cells.state.orchestrator!, "tmux-access"), true);

    delete process.env[PREDECESSOR_SESSION_ENV];
    const stranger = host(cwd);
    stranger.persistence.restore(ctx as never, "S3");
    assert.equal(hasGrant(stranger.cells.state.orchestrator!, "tmux-access"), false, "a takeover re-asks the user");
  } finally {
    if (previous === undefined) delete process.env[PREDECESSOR_SESSION_ENV];
    else process.env[PREDECESSOR_SESSION_ENV] = previous;
  }
});
