import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hermeticGitEnv } from "./helpers/git.ts";
import { createSessionCells } from "../lib/session-cells.ts";
import { createEditTracking } from "../lib/edit-tracking-hook.ts";
import { pendingCheckpoint } from "../lib/checkpoint-sweep.ts";

// F1 (2026-09-30): on macOS `/tmp` is a symlink to `/private/tmp`. git reports
// the repo root by realpath, so an edit written through the symlinked prefix
// was recorded under a path no root matched — the checkpoint then left the
// session's own new file out and the round reviewed an EMPTY range.
test("an edit through a symlinked directory is recorded root-relative and checkpointed", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rg-etr-")));
  try {
    const repo = join(base, "repo");
    execFileSync("git", ["init", "-q", "-b", "feat/x", repo], { env: hermeticGitEnv() });
    const link = join(base, "link");
    symlinkSync(base, link);
    const viaLink = join(link, "repo", "new.ts");
    writeFileSync(viaLink, "export const x = 1;\n");

    const cells = createSessionCells(repo);
    const track = createEditTracking(cells, {
      stateForRepo: () => cells.state,
      persist: () => {},
      persistRepo: () => {},
      repoRelative: (p) => (p.startsWith(cells.primaryRepoRoot + "/") ? p.slice(cells.primaryRepoRoot.length + 1) : p),
      log: () => {},
    });
    track({ toolName: "write", input: { path: viaLink }, isError: false, content: [] } as never, {} as never);

    assert.deepEqual(cells.state.sessionEditedFiles, ["new.ts"]);
    assert.deepEqual(pendingCheckpoint(repo, cells.state.sessionEditedFiles ?? []).paths, ["new.ts"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
