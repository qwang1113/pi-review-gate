import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASH_WRITE_NUDGE,
  EDIT_DISCIPLINE_DIRECTIVE,
  EDIT_FAILURE_NUDGE,
  looksLikeBashFileWrite,
} from "../lib/edit-discipline.ts";

// ---------------------------------------------------------------------------
// looksLikeBashFileWrite — real workaround commands from session logs

test("detects REAL bypass commands found in session logs", () => {
  const real = [
    // mixpanel-to-posthog 07-30: edits serialized as string → cat >> heredoc
    "cat >> /Users/qwang/workspace/mixpanel-to-posthog/cmd/tosupload/filter_test.go <<'GOEOF'\n\n// The real export contains lines that repeat the \"time\" key",
    // onchain 07-12: invalid edit fields → sed -i batch replace
    "cd /Users/qwang/workspace/onchain && sed -i '' \\\n  -e 's/LogSource\\.ANALYTICS_CLIENT/LogSource.MIXPANEL_CLIENT/g' \\\n  -e 's/\\bIAnalyticsEvent\\b/IMixpanelEvent/g' src/service/mixpanel/mixpanel-client.service.ts",
    // onchain 07-14: Tool Write not found → cat > heredoc
    "cat > /tmp/fable-final.md << 'FABLE_EOF'\n# AUM Whitelist Skill Verification",
    // onchain 07-15: oldText mismatch → python re.sub rewrite
    "cd ~/workspace/pi-review-gate && python3 -c \"\nimport re\nt = open('test/extension-structure.test.ts').read()\nt = re.sub(r\\\"from [\\\"'\\]\\.\\.\\/lib\\/constants\\\", 'from \\\"./lib/constants.ts\\\"', t)\nopen('test/extension-structure.test.ts', 'w').write(t)\n\"",
    // onchain 07-27: oldText mismatch → python heredoc rewrite
    "cd /Users/qwang/workspace/onchain && python3 - <<'PYEOF'\nimport io\np='docs/features/aum-mongo-tos/0-design.md'\ns=io.open(p,encoding='utf-8').read()\nold_row='| **历史曲线要等 3 年** | TOS 从上线第一周起累积全量明细。'\ns=s.replace(old_row, '| **历史曲线要等 3 年** | 新方案')\nio.open(p,'w',encoding='utf-8').write(s)\nPYEOF",
    // pi-review-gate 07-16: Tool Edit not found → python pathlib write
    "cd /Users/qwang/workspace/pi-review-gate && python3 - <<'PYEOF'\nimport pathlib\np = pathlib.Path(\"scripts/scan-test-labels.cjs\")\nsrc = p.read_text()\nold_cpbefore = '...'\nsrc = src.replace(old_cpbefore, 'new')\np.write_text(src)\nPYEOF",
    // node -e writeFileSync
    "node -e \"require('fs').writeFileSync('x.ts', 'content')\"",
    // printf redirection
    "printf '%s\\n' 'line' > src/config.json",
    // echo redirection
    "echo 'export const V=1' >> lib/env.ts",
    // base64 decode into file
    "echo 'cHJpbnQoImhpIikK' | base64 -d > gen.py",
    // tee write
    "echo 'hello' | tee notes.md",
  ];
  for (const cmd of real) {
    assert.equal(looksLikeBashFileWrite(cmd), true, cmd.slice(0, 80));
  }
});

test("read-only / non-editing commands are NOT flagged", () => {
  const benign = [
    "ls -la /Users/qwang/workspace/pi-review-gate/",
    "git status --porcelain -uall",
    "git diff --stat",
    "cat package.json",
    "grep -rn 'taskMode' lib/ | head",
    "npm test",
    "git log --oneline -5",
    'git commit -m "feat: add > support"',
    "echo 'no redirect here'",
    "cd /tmp && pwd && date",
    "curl -s https://example.com/api",
    "node --version",
    "python3 -c \"print('just computing', 1+1)\"",
    // output suppression is not file editing
    "grep -r foo . > /dev/null 2>&1",
    "npm run build > /dev/null",
    // piped reads with a > inside a string literal
    "grep -o 'a>b' file.txt",
  ];
  for (const cmd of benign) {
    assert.equal(looksLikeBashFileWrite(cmd), false, cmd.slice(0, 80));
  }
});

// ---------------------------------------------------------------------------
// nudge copy — prompt-only guidance, never enforcement wording

test("nudges instruct fixing the tool call, not blocking", () => {
  assert.match(EDIT_FAILURE_NUDGE, /do NOT fall back to bash\/python/);
  assert.match(EDIT_FAILURE_NUDGE, /Fix the tool call/);
  assert.match(BASH_WRITE_NUDGE, /retry the edit\/write tool/);
  assert.match(BASH_WRITE_NUDGE, /genuinely need bash/);
  // No blocking/enforcement language in the nudges.
  for (const t of [EDIT_FAILURE_NUDGE, BASH_WRITE_NUDGE]) {
    assert.doesNotMatch(t, /\bblock(ed|ing)?\b/i, "nudges must not claim to block");
  }
});

test("the discipline directive is injected as guidance (not enforcement)", () => {
  assert.match(EDIT_DISCIPLINE_DIRECTIVE, /edit\/write tools/);
  assert.match(EDIT_DISCIPLINE_DIRECTIVE, /never fall back to bash\/python/);
  assert.match(EDIT_DISCIPLINE_DIRECTIVE, /FIX THE CALL/);
  assert.doesNotMatch(EDIT_DISCIPLINE_DIRECTIVE, /\bblock(ed|ing)?\b/i);
});
