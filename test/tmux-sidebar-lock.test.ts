/**
 * THE SIDEBAR'S INPUT LOCK (t7): which panes get locked, what is recorded on
 * the window, and what restoring runs. Pure, no tmux.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWindowPanesArgv,
  decodeLocked,
  lockArgv,
  parseWindowPanes,
  planLock,
  readRecordArgv,
  recordArgv,
  restoreArgvs,
  SIDEBAR_LOCKED_OPTION,
  unlockArgv,
} from "../lib/tmux-sidebar-lock.ts";

test("the window read asks for input state, the sidebar marker and the window's record", () => {
  const argv = buildWindowPanesArgv("%3");
  assert.deepEqual(argv.slice(0, 4), ["list-panes", "-t", "%3", "-F"]);
  assert.equal(argv[4], `#{pane_id}\t#{pane_input_off}\t#{@rg_sidebar}\t#{${SIDEBAR_LOCKED_OPTION}}`);
});

test("parse: flags per pane, one record per window, junk lines skipped", () => {
  const window = parseWindowPanes("%9\t0\t1\t%1,%2\n%1\t1\t\t%1,%2\n%2\t0\t\t%1,%2\nnot a pane\n");
  assert.deepEqual(window, {
    panes: [
      { paneId: "%9", inputOff: false, sidebar: true },
      { paneId: "%1", inputOff: true, sidebar: false },
      { paneId: "%2", inputOff: false, sidebar: false },
    ],
    locked: ["%1", "%2"],
  });
  assert.deepEqual(parseWindowPanes(""), { panes: [], locked: [] });
  assert.deepEqual(decodeLocked("%1, bogus,%x,%22,"), ["%1", "%22"]);
});

test("first pass locks every other pane that is on, and records them", () => {
  const window = parseWindowPanes("%9\t0\t1\t\n%1\t0\t\t\n%2\t0\t\t\n");
  assert.deepEqual(planLock(window, "%9"), { lock: ["%1", "%2"], record: "%1,%2" });
});

test("a pane the user had already switched off is neither locked nor recorded", () => {
  const window = parseWindowPanes("%9\t0\t1\t\n%1\t1\t\t\n%2\t0\t\t\n");
  assert.deepEqual(planLock(window, "%9"), { lock: ["%2"], record: "%2" });
});

test("a later pass locks only a newly split pane and extends the record", () => {
  const rec = "%1,%2";
  const window = parseWindowPanes(`%9\t0\t1\t${rec}\n%1\t1\t\t${rec}\n%2\t1\t\t${rec}\n%5\t0\t\t${rec}\n`);
  assert.deepEqual(planLock(window, "%9"), { lock: ["%5"], record: "%1,%2,%5" });
});

test("nothing new ⇒ nothing to run, record untouched; a closed pane drops out", () => {
  assert.deepEqual(planLock(parseWindowPanes("%9\t0\t1\t%1\n%1\t1\t\t%1\n"), "%9"), { lock: [] });
  assert.deepEqual(planLock(parseWindowPanes("%9\t0\t1\t%1,%2\n%1\t1\t\t%1,%2\n"), "%9"), { lock: [], record: "%1" });
});

test("a second sidebar in the window is never locked", () => {
  const window = parseWindowPanes("%9\t0\t1\t\n%8\t0\t1\t\n%1\t0\t\t\n");
  assert.deepEqual(planLock(window, "%9").lock, ["%1"]);
});

test("lock / record / restore argv — the record is a window option", () => {
  assert.deepEqual(lockArgv("%1"), ["select-pane", "-d", "-t", "%1"]);
  assert.deepEqual(unlockArgv("%1"), ["select-pane", "-e", "-t", "%1"]);
  assert.deepEqual(recordArgv("%9", "%1,%2"), ["set", "-w", "-t", "%9", SIDEBAR_LOCKED_OPTION, "%1,%2"]);
  assert.deepEqual(readRecordArgv("%1"), ["display-message", "-p", "-t", "%1", `#{${SIDEBAR_LOCKED_OPTION}}`]);
  assert.deepEqual(restoreArgvs("%1", ["%1", "%2"]), [
    ["select-pane", "-e", "-t", "%1"],
    ["select-pane", "-e", "-t", "%2"],
    ["set", "-w", "-u", "-t", "%1", SIDEBAR_LOCKED_OPTION],
  ]);
  assert.deepEqual(restoreArgvs("%1", []), [["set", "-w", "-u", "-t", "%1", SIDEBAR_LOCKED_OPTION]]);
});
