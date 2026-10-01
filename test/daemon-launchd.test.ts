/**
 * THE LAUNCHD HALF (lib/daemon/service-launchd.ts).
 *
 * Two things are worth pinning, and they fail for different reasons:
 *   - the PLIST'S CONTENT — `RunAtLoad` plus `KeepAlive.SuccessfulExit = false`
 *     is what makes "start at login, restart a crash, and let `daemon stop`
 *     actually stop it" true; and
 *   - the SEQUENCE — `bootout` before `bootstrap`, because a second install
 *     over a loaded label is refused by launchctl, and a first install's
 *     `bootout` failing is normal.
 *
 * The launchctl RUNNER is always injected: a test must never write into the
 * user's real `~/Library/LaunchAgents` or boot an agent out of their session.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildLaunchdPlist,
  installDaemonService,
  launchdPlistPath,
  uninstallDaemonService,
  LAUNCHD_LABEL,
  type LaunchctlResult,
} from "../lib/daemon/service-launchd.ts";
import { scratchHome } from "./daemon-helpers.ts";

const OK = (argv: readonly string[]): LaunchctlResult => ({ ok: true, code: 0, stdout: `ran ${argv.join(" ")}`, stderr: "" });
const FAIL = (stderr: string) => (): LaunchctlResult => ({ ok: false, code: 1, stdout: "", stderr });

test("the plist says: run at login, restart a CRASH, and let a clean stop stay stopped", () => {
  const home = "/Users/me";
  const plist = buildLaunchdPlist({
    home,
    reexec: ["/opt/homebrew/bin/node", "/Users/me/repo/scripts/pi-gate.mjs"],
    port: 4600,
    workspaceRoots: ["/Users/me/workspace"],
  });
  assert.match(plist, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/Users\/me\/repo\/scripts\/pi-gate\.mjs<\/string>\s*<string>daemon<\/string>\s*<string>run<\/string>\s*<string>--port<\/string>\s*<string>4600<\/string>\s*<string>--workspace-root<\/string>\s*<string>\/Users\/me\/workspace<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/, "a CRASH is restarted; `daemon stop` (exit 0) is not");
  assert.match(plist, /<key>RG_DAEMON_HOME<\/key>\s*<string>\/Users\/me<\/string>/, "the agent reads the same home the install wrote");
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/, "a process that cannot start is retried slowly, not in a spin");
  assert.match(plist, /\/Users\/me\/\.pi\/agent\/rg-daemon\/daemon\.log/);
});

test("a path with XML metacharacters is escaped, not pasted in", () => {
  const plist = buildLaunchdPlist({ home: "/Users/a&b/<weird>", reexec: ["/usr/bin/node", "/tmp/a&b/cli.ts"] });
  assert.match(plist, /\/Users\/a&amp;b\/&lt;weird&gt;/);
  assert.match(plist, /\/tmp\/a&amp;b\/cli\.ts/);
  assert.ok(!plist.includes("<weird>"), "the raw path must never appear as markup");
});

test("install writes the agent file and bootstraps it in the user's own domain", () => {
  const home = scratchHome();
  const calls: string[][] = [];
  const result = installDaemonService({
    home,
    reexec: ["/usr/bin/node", "/tmp/cli.ts"],
    runLaunchctl: (argv) => { calls.push([...argv]); return OK(argv); },
    platform: "darwin",
    uid: 501,
  });
  assert.equal(result.ok, true);
  const plistPath = launchdPlistPath(home);
  assert.equal(plistPath, join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`));
  assert.equal(existsSync(plistPath), true);
  assert.deepEqual(calls, [
    ["bootout", `gui/501/${LAUNCHD_LABEL}`],
    ["bootstrap", "gui/501", plistPath],
  ], "bootout first: bootstrap refuses a label that is already there");
  assert.ok(result.steps.length >= 3);
});

test("a bootstrap launchctl refuses is reported with launchctl's own words", () => {
  const home = scratchHome();
  const result = installDaemonService({
    home,
    reexec: ["/usr/bin/node", "/tmp/cli.ts"],
    runLaunchctl: (argv) => (argv[0] === "bootstrap" ? FAIL("Bootstrap failed: 5: Input/output error")() : OK(argv)),
    platform: "darwin",
    uid: 501,
  });
  assert.equal(result.ok, false);
  assert.match(result.problem!, /Bootstrap failed/);
  assert.equal(existsSync(launchdPlistPath(home)), true, "the plist stays as evidence of what was attempted");
});

test("uninstall boots the agent out and removes the plist", () => {
  const home = scratchHome();
  installDaemonService({ home, reexec: ["/usr/bin/node", "/tmp/cli.ts"], runLaunchctl: OK, platform: "darwin", uid: 501 });
  const calls: string[][] = [];
  const result = uninstallDaemonService({
    home,
    reexec: ["/usr/bin/node", "/tmp/cli.ts"],
    runLaunchctl: (argv) => { calls.push([...argv]); return OK(argv); },
    platform: "darwin",
    uid: 501,
  });
  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.deepEqual(calls, [["bootout", `gui/501/${LAUNCHD_LABEL}`]]);
  assert.equal(existsSync(launchdPlistPath(home)), false);
});

test("uninstalling what was never installed is reported as such, not as a removal", () => {
  const home = scratchHome();
  const result = uninstallDaemonService({
    home,
    reexec: ["/usr/bin/node", "/tmp/cli.ts"],
    // The shape of a real "nothing is loaded": launchctl exits non-zero.
    runLaunchctl: FAIL("Could not find service") as unknown as (argv: readonly string[]) => LaunchctlResult,
    platform: "darwin",
    uid: 501,
  });
  assert.equal(result.ok, true);
  assert.equal(result.removed, false);
  assert.match(result.problem!, /Could not find service/);
});

test("on a machine without launchd nothing is written and the reason says so", () => {
  const home = scratchHome();
  const calls: unknown[] = [];
  const installed = installDaemonService({
    home,
    reexec: ["/usr/bin/node", "/tmp/cli.ts"],
    runLaunchctl: (argv) => { calls.push(argv); return OK(argv); },
    platform: "linux",
  });
  assert.equal(installed.ok, false);
  assert.match(installed.problem!, /launchd 只在 macOS 上有（这台机器是 linux）/);
  assert.deepEqual(calls, [], "no launchctl call is even attempted");
  assert.equal(existsSync(join(home, "Library")), false);

  const uninstalled = uninstallDaemonService({ home, reexec: [], platform: "linux" });
  assert.equal(uninstalled.ok, false);
  assert.equal(uninstalled.removed, false);
});

test("the plist the CLI would write is the plist a human can read back", () => {
  const home = scratchHome();
  installDaemonService({ home, reexec: ["/usr/bin/node", "/tmp/cli.ts"], runLaunchctl: OK, platform: "darwin", uid: 501 });
  const written = readFileSync(launchdPlistPath(home), "utf8");
  assert.match(written, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(written, /<key>Label<\/key>/);
  assert.equal(written.endsWith("</plist>\n"), true, "a plist is a text file a person may read and fix");
});
