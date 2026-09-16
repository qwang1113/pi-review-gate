import test from "node:test";
import assert from "node:assert/strict";

import { rendererModeNoticeDue, RENDERER_MODE_NOTICE } from "../lib/renderer-mode.ts";

test("a session is told only when it is on the renderer that cannot scroll a tall dialog", () => {
  assert.equal(rendererModeNoticeDue("regular", false), true, "the one case that speaks");
  assert.equal(rendererModeNoticeDue("fullscreen", false), false,
    "the renderer the user actually runs: silence");
  // NOT the same as "regular": a host that reports no mode (RPC, headless) has
  // no renderer to warn about, and reading its silence as `regular` would nag
  // every non-interactive run.
  assert.equal(rendererModeNoticeDue(undefined, false), false);
  assert.equal(rendererModeNoticeDue("regular", true), false,
    "once per session — the widget factory runs on every install, not just the first");
});

test("the notice names BOTH ways out, why, and that it is not a gate", () => {
  assert.match(RENDERER_MODE_NOTICE, /--tui-mode fullscreen/, "the launch flag");
  assert.match(RENDERER_MODE_NOTICE, /tuiMode/, "…and the setting, for the habit that is not the flag");
  assert.match(RENDERER_MODE_NOTICE, /清屏|滚回/, "WHY — otherwise it reads as an unexplained rule");
  assert.match(RENDERER_MODE_NOTICE, /不拦任何操作/,
    "advice about a terminal, not a block: nothing in the gate depends on it");
});
