#!/usr/bin/env node
/**
 * `node scripts/validate-config.ts <kind>` — the desktop config page's validator.
 *
 * Reads a config file's full text on stdin, validates it as `<kind>`
 * (pi-settings | pi-models | gate) with prg's own rules (lib/config-validate.ts)
 * against the model registry under $HOME, and prints the verdict as one JSON
 * line: `{"ok":bool,"issues":[{"path","message"}]}`. Exit 0 whenever a verdict
 * was printed; 2 on a usage error.
 */

import { readFileSync } from "node:fs";
import { CONFIG_KINDS, validateConfigText, type ConfigKind } from "../lib/config-validate.ts";
import { loadRegistry } from "../lib/model-spec.ts";

const kind = process.argv[2];
if (!CONFIG_KINDS.includes(kind as ConfigKind)) {
  process.stderr.write(`用法：validate-config.ts <${CONFIG_KINDS.join("|")}>  (文件内容走 stdin)\n`);
  process.exit(2);
}
const text = readFileSync(0, "utf8");
process.stdout.write(JSON.stringify(validateConfigText(kind as ConfigKind, text, loadRegistry(process.env.HOME))) + "\n");
