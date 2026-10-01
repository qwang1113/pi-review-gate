#!/usr/bin/env node
/**
 * `pi-gate` — the launcher for the standalone daemon CLI.
 *
 * It exists as a `.mjs` shim so `bin.pi-gate` is a real executable file that
 * derives its own path (`import.meta.url`): the detached daemon child is
 * re-executed through THIS entry point, which keeps working when the package is
 * installed and the bin is reached through a symlink.
 *
 * The CLI itself lives in lib/daemon/cli.ts and is imported directly — node
 * runs TypeScript sources without a build step (the same reason every hook and
 * script in this repository can import lib/*.ts).
 */
import { fileURLToPath } from "node:url";

import { runDaemonCli } from "../lib/daemon/cli.ts";

const code = await runDaemonCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  reexec: [process.execPath, fileURLToPath(import.meta.url)],
});
process.exit(code);
