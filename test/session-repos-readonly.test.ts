/**
 * N4 (2026-09-27): a repo this session does not own is READ-ONLY.
 *
 * Measured: the acceptance session's bash-result handling (ship evidence for a
 * `git commit` it ran in a /tmp scratch repo) persisted its own state variant
 * into that repo's `.pi/`, and the scratch repo's owner then saw it as a
 * foreign file. `persistRepo` is the one write boundary every caller shares.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionRepos } from "../lib/session-repos-host.ts";
import { emptyState } from "../lib/gate-state.ts";
import { DEFAULT_MAX_ROUNDS } from "../lib/constants.ts";
import { defaultProjectConfig } from "../lib/project-config.ts";
import { git, neutraliseHostGitConfig } from "./helpers/git.ts";

neutraliseHostGitConfig();

function repo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, ["init", "-q", "-b", "feat/x"]);
  return dir;
}

test("N4: persisting an external repo writes nothing into its .pi/; a repo of this session is written", () => {
  const primary = repo("rg-n4-primary-");
  const external = repo("rg-n4-external-");
  const own = repo("rg-n4-own-");
  try {
    const cells = {
      cwd: primary,
      primaryRepoRoot: primary,
      activeRepoRoot: { current: primary },
      sessionRepos: new Set([primary, own]),
      repoStateCache: new Map(),
      state: emptyState("s-n4", DEFAULT_MAX_ROUNDS),
      projectConfig: defaultProjectConfig(),
    };
    const repos = createSessionRepos(cells as never, {
      persist: () => {},
      noteGateStatePersistSkip: () => false,
      callerIdentity: () => undefined,
      resolveJudgeLane: (() => { throw new Error("unused"); }) as never,
    });
    // What the bash handler does for a repo a command ran in: mutate, persist.
    repos.stateForRepo(external).shippedKinds = ["commit"];
    repos.persistRepo({} as never, external);
    assert.equal(existsSync(join(external, ".pi")), false,
      `the external repo's .pi/ must not appear (found: ${existsSync(join(external, ".pi")) ? readdirSync(join(external, ".pi")).join(", ") : ""})`);

    // Reverse: a secondary repo this session edited keeps its own sidecar.
    repos.stateForRepo(own).shippedKinds = ["commit"];
    repos.persistRepo({} as never, own);
    assert.ok(readdirSync(join(own, ".pi")).some((f) => f.startsWith("review-gate-state")),
      "this session's own secondary repo is still persisted");
  } finally {
    for (const d of [primary, external, own]) rmSync(d, { recursive: true, force: true });
  }
});
