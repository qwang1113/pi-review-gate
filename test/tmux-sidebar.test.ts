/**
 * THE TMUX SIDEBAR (s1, 2026-09-27): rows → tree → lines. Pure, no tmux.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildListAllPanesArgv, parsePaneRows, type PaneRow } from "../lib/tmux-sidebar-collect.ts";
import { buildSidebarTree, rowState, type SidebarNode } from "../lib/tmux-sidebar-tree.ts";
import {
  clampSelection,
  displayWidth,
  fitWidth,
  lineAtClick,
  moveSelection,
  paintLines,
  scrollFor,
  sidebarLines,
} from "../lib/tmux-sidebar-render.ts";

const NOW = 2_000_000;

function pane(over: Partial<PaneRow>): PaneRow {
  return {
    session: "0", windowId: "@1", windowIndex: "1", windowName: "zsh", paneId: "%1",
    sid: "", repo: "", kind: "", state: "", stateAt: String(NOW), scopeOwner: "", sessionName: "", sidebar: false,
    ...over,
  };
}

/** A PM in session 0, its child s1 (with its own reviewer), a stray old window, and a plain shell session. */
const ROWS: PaneRow[] = [
  pane({ paneId: "%1", sid: "pm-id", repo: "/w/pi-review-gate", kind: "orchestrator", state: "working", sessionName: "pm-main" }),
  pane({ paneId: "%2", windowName: "shell" }),
  pane({ session: "rg-pi-review-gate-pm-aaaa", windowId: "@3", windowName: "s1-tmux-sidebar", paneId: "%3",
    sid: "s1-id", repo: "/w/pi-review-gate-sb", kind: "child", state: "waiting-judge", scopeOwner: "pm-id" }),
  pane({ session: "rg-pi-review-gate-pm-aaaa", windowId: "@4", windowName: "n1-notice", paneId: "%4",
    sid: "n1-id", repo: "/w/pi-review-gate", kind: "child", state: "waiting-input", scopeOwner: "pm-id" }),
  pane({ session: "rg-pi-review-gate-sb-s1-bbbb", windowId: "@5", windowName: "reviewer", paneId: "%5",
    sid: "rev-id", repo: "/w/pi-review-gate-sb", kind: "judge", state: "working", scopeOwner: "s1-id" }),
  pane({ session: "rg-pi-review-gate-sb-s1-bbbb", windowId: "@6", windowName: "worker-x", paneId: "%6",
    scopeOwner: "s1-id" }),
  pane({ session: "rg-other-self-cccc", windowId: "@7", windowName: "reviewer", paneId: "%7",
    sid: "orphan-id", repo: "/w/other", kind: "judge", state: "idle", stateAt: String(NOW - 200), scopeOwner: "gone-id" }),
  pane({ session: "scratch", windowId: "@8", paneId: "%8" }),
  pane({ session: "scratch", windowId: "@9", paneId: "%9" }),
  pane({ paneId: "%10", sidebar: true }),
];

test("parse: the list-panes format round-trips, a tab in a window name survives, junk is skipped", () => {
  const format = buildListAllPanesArgv()[3];
  assert.equal(format.split("\t").length, 13);
  const line = ["rg-x", "@1", "0", "a\tb", "%3", "sid", "/w/r", "judge", "idle", "10", "owner", "nm", "1"].join("\t");
  const [row] = parsePaneRows(`${line}\ngarbage\n`);
  assert.equal(row.windowName, "a\tb");
  assert.equal(row.paneId, "%3");
  assert.equal(row.sidebar, true);
  assert.equal(row.scopeOwner, "owner");
  assert.equal(parsePaneRows("garbage").length, 0);
});

test("tree: repo groups, children under their opener (nested), orphans flagged, non-pi sessions in the others list", () => {
  const tree = buildSidebarTree(ROWS, NOW);
  assert.deepEqual(tree.groups.map((g) => g.repo), ["other", "pi-review-gate"]);
  const pm = tree.groups[1].nodes[0];
  assert.equal(pm.label, "pm-main");
  assert.deepEqual(pm.children.map((c) => c.label), ["s1-tmux-sidebar", "n1-notice"], "children stay with their opener, whatever their repo");
  const s1 = pm.children[0];
  assert.deepEqual(s1.children.map((c) => [c.label, c.state]), [["reviewer", "working"], ["worker-x", undefined]]);
  assert.deepEqual(s1.children[0].target, { session: "rg-pi-review-gate-sb-s1-bbbb", windowId: "@5", paneId: "%5" });
  const orphan = tree.groups[0].nodes[0];
  assert.equal(orphan.orphan, true);
  assert.equal(orphan.state, "stalled", "a reporter quiet for > 90s");
  assert.equal(tree.waiting, 1);
  assert.deepEqual(tree.others.map((o) => [o.session, o.windows]), [["scratch", 2]], "session 0 has a pi pane; the sidebar is never listed");
});

test("tree: a top-level session without a name shows kind and place; a cycle does not lose rows", () => {
  const tree = buildSidebarTree([
    pane({ paneId: "%1", sid: "a", repo: "/w/r", kind: "loop", state: "idle", scopeOwner: "b" }),
    pane({ paneId: "%2", sid: "b", repo: "/w/r", kind: "loop", state: "idle", scopeOwner: "a" }),
    pane({ paneId: "%3", sid: "c", repo: "/w/r", kind: "loop", state: "bogus" }),
  ], NOW);
  const labels: string[] = [];
  const walk = (node: SidebarNode): void => {
    labels.push(node.label);
    node.children.forEach(walk);
  };
  tree.groups[0].nodes.forEach(walk);
  assert.equal(labels.length, 3, "every row is placed once");
  assert.ok(labels.includes("loop 0:1"));
  assert.equal(rowState(pane({ state: "bogus" }), NOW), undefined);
});

test("lines: header alert, group headings, indentation, state words, targets", () => {
  const lines = sidebarLines(buildSidebarTree(ROWS, NOW), 30);
  assert.equal(lines[0].tone, "alert");
  assert.match(lines[0].text, /等你回答 1/);
  const texts = lines.map((l) => l.text);
  assert.ok(texts.some((t) => /^─ pi-review-gate/.test(t)));
  assert.ok(texts.some((t) => /^─ 其他/.test(t)));
  const s1 = lines.find((l) => l.text.includes("s1-tmux"))!;
  assert.match(s1.text, /^ {3}s1-tmux.*等 judge$/);
  const reviewer = lines.find((l) => l.target?.paneId === "%5")!;
  assert.match(reviewer.text, /^ {5}reviewer +working$/);
  assert.ok(lines.every((l) => displayWidth(l.text) <= 30), "nothing wider than the pane");
  assert.equal(lines.find((l) => l.text.includes("n1-notice"))!.tone, "waiting");
  assert.match(lines.find((l) => l.target?.paneId === "%7")!.text, /⚠/);
  const calm = sidebarLines(buildSidebarTree([], NOW), 30);
  assert.equal(calm[0].tone, "header");
});

test("selection, scrolling and clicks map onto selectable lines only", () => {
  const lines = sidebarLines(buildSidebarTree(ROWS, NOW), 30);
  const first = clampSelection(lines, 0);
  assert.ok(lines[first].target, "the header is skipped");
  const next = moveSelection(lines, first, 1);
  assert.ok(next > first && lines[next].target);
  assert.equal(moveSelection(lines, first, -1), first, "stays put at the top");
  assert.equal(clampSelection(lines, 999), moveSelection(lines, lines.length, -1), "past the end means the last row");
  assert.equal(scrollFor(10, 0, 5), 6);
  assert.equal(scrollFor(2, 5, 5), 2);
  assert.equal(lineAtClick(lines, 1, 0), undefined, "the header is not a target");
  assert.equal(lineAtClick(lines, first + 1, 0), first);
  assert.equal(lineAtClick(lines, 2, first - 1), first, "clicks honour the scroll");
  assert.equal(lineAtClick(lines, 500, 0), undefined);
  const painted = paintLines(lines, { width: 30, height: 3, selected: first, scroll: 0 });
  assert.equal(painted.length, 3);
  assert.match(painted[first], /\x1b\[7m/, "the selection is reversed");
});

test("width: CJK counts double and cuts end in an ellipsis", () => {
  assert.equal(displayWidth("等你回答"), 8);
  assert.equal(fitWidth("abcdef", 4), "abc…");
  assert.equal(displayWidth(fitWidth("等你回答等你回答", 7)) <= 7, true);
  assert.equal(fitWidth("ab", 0), "");
});
