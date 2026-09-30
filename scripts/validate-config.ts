#!/usr/bin/env node
/**
 * `node scripts/validate-config.ts` — the desktop config page's validator.
 *
 * stdin: `{"kind": "pi-settings" | "pi-models" | "gate", "text": <the file's full text>}`.
 * stdout: one JSON line `{"ok": bool, "errors": [{"path", "message"}]}`, judged with
 * prg's own rules (lib/config-validate.ts) against the model registry under $HOME.
 * Exit 0 whenever a verdict was printed; 2 on a malformed request.
 */

import { readFileSync } from "node:fs";
import { CONFIG_KINDS, validateConfigText, type ConfigKind } from "../lib/config-validate.ts";
import { loadRegistry } from "../lib/model-spec.ts";

let req: { kind?: unknown; text?: unknown } = {};
try {
  req = JSON.parse(readFileSync(0, "utf8"));
} catch {
  // falls through to the usage error below
}
if (!CONFIG_KINDS.includes(req?.kind as ConfigKind) || typeof req?.text !== "string") {
  process.stderr.write(`用法：stdin 写 {"kind": "${CONFIG_KINDS.join("|")}", "text": "<文件全文>"}\n`);
  process.exit(2);
}
process.stdout.write(JSON.stringify(validateConfigText(req.kind as ConfigKind, req.text, loadRegistry(process.env.HOME))) + "\n");
