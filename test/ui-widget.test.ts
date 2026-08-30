import { test } from "node:test";
import assert from "node:assert/strict";

import { buildModelConfigWidget } from "../lib/ui-widget.ts";

test("buildModelConfigWidget renders one line per entry with spec · auto state · source", () => {
  const lines = buildModelConfigWidget([
    { name: "reviewer", spec: "onekey/gpt-5.6-sol:high", auto: false, source: "project" },
    { name: "adviser", spec: "claude-fable-5:max", auto: true, source: "default" },
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^model reviewer: onekey\/gpt-5\.6-sol:high  \[auto OFF · project\]$/);
  assert.match(lines[1]!, /^model adviser: claude-fable-5:max  \[auto on · default\]$/);
});

test("buildModelConfigWidget maps every auto state and source label deterministically", () => {
  const states = [
    { auto: false, source: "project" as const, expect: "auto OFF · project" },
    { auto: false, source: "global" as const, expect: "auto OFF · global" },
    { auto: true, source: "global" as const, expect: "auto on · global" },
    { auto: true, source: "default" as const, expect: "auto on · default" },
  ];
  for (const { auto, source, expect } of states) {
    const [line] = buildModelConfigWidget([{ name: "reviewer", spec: "claude-fable-5", auto, source }]);
    assert.ok(line!.includes(`[${expect}]`), `${auto}/${source} should render [${expect}]`);
  }
});
