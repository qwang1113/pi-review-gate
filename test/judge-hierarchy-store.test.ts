/**
 * The shared `.pi/judge-hierarchy.json` survives several writers
 * (lib/judge-hierarchy-store.ts). The measured failure: a child session
 * reclaimed its last judge, persisted an empty table, and DELETED the file one
 * second before the manager's plan auditor concluded against it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeHierarchySlice, readHierarchySlice, writeHierarchySlice } from "../lib/judge-hierarchy-store.ts";
import { createJudgeRegistry, HIERARCHY_FILENAME } from "../lib/judge-registry-host.ts";
import { registerJudge, removeJudge, type JudgeEntry } from "../lib/hierarchy.ts";
import type { SessionHost } from "../lib/session-host.ts";

function entry(judgeId: string, openerId: string, repoRoot: string, over: Partial<JudgeEntry> = {}): JudgeEntry {
  return { judgeId, openerId, role: "goal-auditor", repoRoot, title: "t", sessionDir: "/tmp/s", spawnedAt: "2026-09-27T00:00:00.000Z", ...over };
}

/** One "process": its own registry instance over the shared checkout. */
function process_(root: string, sessionId: string) {
  const logs: string[] = [];
  const host = {
    state: () => ({ sessionId }),
    repos: () => ({ cwd: root, primary: root }),
    log: (m: string) => logs.push(m),
    ctx: () => undefined,
  } as unknown as SessionHost;
  const reg = createJudgeRegistry(host, {
    runTmux: () => ({ ok: true, stdout: "", stderr: "" }),
    channelIO: {} as never,
    roundBindingOf: () => ({ kind: "cursor-only" }) as never,
    copilotWaitSince: () => undefined,
  });
  reg.ensureHierarchyLoaded(root);
  const add = (id: string) => {
    const r = registerJudge(reg.judgeHierarchy(), entry(id, sessionId, root));
    assert.ok(r.ok);
    return reg.setHierarchy(r.table);
  };
  const drop = (id: string) => reg.setHierarchy(removeJudge(reg.judgeHierarchy(), id));
  return { reg, add, drop, logs };
}

const fileOf = (root: string) => join(root, ".pi", HIERARCHY_FILENAME);
const idsOnDisk = (root: string) => Object.keys(readHierarchySlice(fileOf(root))?.judges ?? {}).sort();

test("two registries interleave writes: an emptied table no longer deletes the peer's entries", () => {
  const root = mkdtempSync(join(tmpdir(), "rg-hier-"));
  const pm = process_(root, "pm");
  const child = process_(root, "child");
  assert.equal(child.add("child-reviewer"), true);
  assert.equal(pm.add("pm-auditor"), true); // pm never loaded child's entry, and must not erase it
  assert.deepEqual(idsOnDisk(root), ["child-reviewer", "pm-auditor"]);
  assert.equal(child.add("child-quality"), true);
  // The child reclaims everything it opened — its own table is empty now.
  child.drop("child-reviewer");
  child.drop("child-quality");
  assert.deepEqual(idsOnDisk(root), ["pm-auditor"], "the manager's auditor is still on file");
  // …and the manager's next write does not resurrect what the child removed.
  pm.add("pm-reviewer");
  assert.deepEqual(idsOnDisk(root), ["pm-auditor", "pm-reviewer"]);
  // The last one out still cleans up — no empty shell left behind.
  pm.drop("pm-auditor");
  pm.drop("pm-reviewer");
  assert.equal(existsSync(fileOf(root)), false);
});

test("a peer's later edit of its own entry is not rolled back by a stale copy", () => {
  const root = mkdtempSync(join(tmpdir(), "rg-hier-"));
  const a = process_(root, "a");
  a.add("a-judge");
  const b = process_(root, "b"); // loads a-judge (roundSeq absent)
  const bumped = registerJudge(a.reg.judgeHierarchy(), entry("a-judge", "a", root, { roundSeq: 7 }));
  assert.ok(bumped.ok);
  a.reg.setHierarchy(bumped.table);
  b.add("b-judge");
  const disk = readHierarchySlice(fileOf(root))!;
  assert.equal(disk.judges["a-judge"]!.roundSeq, 7);
  assert.ok(disk.judges["b-judge"]);
  // b's memory now mirrors the file, peer rows included.
  assert.equal(b.reg.judgeHierarchy()["a-judge"]!.roundSeq, 7);
});

test("merge: mine wins only where it changed since base", () => {
  const e = (id: string, seq?: number) => entry(id, "o", "/r", seq === undefined ? {} : { roundSeq: seq });
  const merged = mergeHierarchySlice(
    { judges: { x: e("x"), y: e("y") } },
    { judges: { x: e("x", 2), z: e("z") } }, // changed x, removed y, added z
    { judges: { x: e("x"), y: e("y"), w: e("w") } }, // a peer added w
  );
  assert.deepEqual(Object.keys(merged.judges).sort(), ["w", "x", "z"]);
  assert.equal(merged.judges.x!.roundSeq, 2);
});

test("lock held by a live process: nothing is written and the caller is told", () => {
  const root = mkdtempSync(join(tmpdir(), "rg-hier-"));
  const file = fileOf(root);
  writeHierarchySlice(file, undefined, { judges: {} }); // creates .pi
  writeFileSync(`${file}.lock`, String(process.pid));
  const out = writeHierarchySlice(file, undefined, { judges: { x: entry("x", "o", root) } }, { timeoutMs: 60 });
  assert.equal(out, undefined);
  assert.equal(existsSync(file), false);
  assert.equal(readFileSync(`${file}.lock`, "utf8"), String(process.pid), "a live holder's lock is left alone");
});

test("lock left by a dead process is broken and the write goes through", () => {
  const root = mkdtempSync(join(tmpdir(), "rg-hier-"));
  const file = fileOf(root);
  writeHierarchySlice(file, undefined, { judges: {} });
  writeFileSync(`${file}.lock`, "999999");
  const out = writeHierarchySlice(file, undefined, { judges: { x: entry("x", "o", root) } }, { timeoutMs: 60, pidAlive: () => false });
  assert.ok(out);
  assert.deepEqual(idsOnDisk(root), ["x"]);
  assert.equal(existsSync(`${file}.lock`), false);
});

test("registry: a write that cannot take the lock returns false and lands on the next persist", () => {
  const root = mkdtempSync(join(tmpdir(), "rg-hier-"));
  const p = process_(root, "p");
  p.add("first");
  writeFileSync(`${fileOf(root)}.lock`, String(process.pid));
  const t0 = Date.now();
  assert.equal(p.add("second"), false);
  assert.ok(Date.now() - t0 >= 4_000, "a live holder is waited for before giving up");
  assert.match(p.logs.join("\n"), /没写成/);
  assert.deepEqual(idsOnDisk(root), ["first"]);
  writeFileSync(`${fileOf(root)}.lock`, "999999999"); // holder gone
  assert.equal(p.reg.persistJudgeHierarchy(), true);
  assert.deepEqual(idsOnDisk(root), ["first", "second"]);
});
