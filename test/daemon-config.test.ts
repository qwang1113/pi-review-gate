/**
 * Configuration read/write (lib/daemon/config.ts): masking, the editable
 * whitelist, refusal-without-touching-the-file, backups, and the gate's own
 * validators being the ones that judge a model chain.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONFIG_MASK,
  configPath,
  maskSecrets,
  parseFieldPath,
  readConfig,
  readPath,
  validateConfigValue,
  validateSlotList,
  withPath,
  writeConfig,
} from "../lib/daemon/config.ts";
import { agentHome, scratchHome } from "./daemon-helpers.ts";

function seedSettings(home: string, value: unknown): string {
  const path = join(agentHome(home), "settings.json");
  mkdirSync(agentHome(home), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function seedModels(home: string): void {
  mkdirSync(agentHome(home), { recursive: true });
  writeFileSync(join(agentHome(home), "models.json"), `${JSON.stringify({
    providers: {
      acme: {
        baseUrl: "https://acme.test/v1",
        api: "openai-completions",
        apiKey: "sk-super-secret-value",
        models: [{ id: "fast", name: "Fast", reasoning: true }],
      },
    },
  }, null, 2)}\n`);
}

test("maskSecrets replaces secrets at any depth and leaves everything else alone", () => {
  const masked = maskSecrets({
    providers: { acme: { apiKey: "sk-x", baseUrl: "https://acme" } },
    nested: [{ token: "t0ken" }, { name: "visible" }],
    theme: "dark",
  }) as Record<string, unknown>;
  const providers = masked.providers as { acme: Record<string, unknown> };
  assert.equal(providers.acme.apiKey, CONFIG_MASK);
  assert.equal(providers.acme.baseUrl, "https://acme");
  const nested = masked.nested as Record<string, unknown>[];
  assert.equal(nested[0]?.token, CONFIG_MASK);
  assert.equal(nested[1]?.name, "visible");
  assert.equal(masked.theme, "dark");
  assert.equal(maskSecrets("a-secret", "apiKey"), CONFIG_MASK);
  assert.equal(maskSecrets("plain", "name"), "plain");
});

test("parseFieldPath refuses prototype hops and malformed paths", () => {
  assert.deepEqual(parseFieldPath("agents.reviewer.slots"), ["agents", "reviewer", "slots"]);
  assert.equal(parseFieldPath("__proto__.polluted"), undefined);
  assert.equal(parseFieldPath("a.constructor.b"), undefined);
  assert.equal(parseFieldPath("a..b"), undefined);
  assert.equal(parseFieldPath(""), undefined);
  assert.equal(parseFieldPath("a.b.c.d.e.f.g.h.i"), undefined);
});

test("withPath copies the tree instead of mutating it", () => {
  const original = { a: { b: 1 } };
  const next = withPath(original, ["a", "b"], 2);
  assert.deepEqual(original, { a: { b: 1 } });
  assert.deepEqual(next, { a: { b: 2 } });
  assert.deepEqual(withPath({ a: 1, b: 2 }, ["a"], undefined), { b: 2 });
  assert.deepEqual(readPath(next, ["a", "b"]), 2);
  assert.equal(readPath(next, ["a", "zzz"]), undefined);
});

test("a sensitive key masks every value it can hold, not just a string", () => {
  const masked = maskSecrets({ apiTokens: { text: "sk-x", numeric: 12345, flag: true }, theme: "dark" }, "") as {
    apiTokens: Record<string, unknown>;
    theme: string;
  };
  assert.equal(masked.apiTokens.text, CONFIG_MASK);
  assert.equal(masked.apiTokens.numeric, CONFIG_MASK, "a number under a credential name is still a credential");
  assert.equal(masked.apiTokens.flag, CONFIG_MASK);
  assert.equal(masked.theme, "dark");
});

test("settings: reads are masked, writes are whitelisted and typed", () => {
  const home = scratchHome();
  seedSettings(home, {
    theme: "dark",
    defaultModel: "acme/fast",
    nested: { apiKey: "sk-hidden" },
  });
  const view = readConfig("settings", { home });
  assert.equal(view.exists, true);
  const value = view.value as Record<string, unknown>;
  assert.equal((value.nested as Record<string, unknown>).apiKey, CONFIG_MASK);
  assert.ok(view.fields.some((field) => field.path === "defaultModel" && field.kind === "string"));
  assert.ok(view.fields.some((field) => field.path === "quietStartup" && field.current === undefined));

  assert.equal(validateConfigValue("settings", "theme", "light", { home }), undefined);
  assert.match(validateConfigValue("settings", "theme", 5, { home }) ?? "", /需要字符串/);
  assert.match(validateConfigValue("settings", "quietStartup", "yes", { home }) ?? "", /需要布尔值/);
  assert.match(validateConfigValue("settings", "defaultThinkingLevel", "extreme", { home }) ?? "", /不支持/);
  assert.match(validateConfigValue("settings", "nested.apiKey", "sk-new", { home }) ?? "", /不在可编辑清单/);
});

test("a refused write leaves the file byte-for-byte untouched and makes no backup", () => {
  const home = scratchHome();
  const path = seedSettings(home, { theme: "dark" });
  const before = readFileSync(path, "utf8");
  const outcome = writeConfig("settings", "theme", 42, { home });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem ?? "", /需要字符串/);
  assert.equal(readFileSync(path, "utf8"), before, "a refused write is a no-op");
  assert.deepEqual(readdirSync(agentHome(home)).filter((file) => file.includes(".bak-")), []);
});

test("an accepted write lands atomically, after a timestamped backup of the previous bytes", () => {
  const home = scratchHome();
  const path = seedSettings(home, { theme: "dark", quietStartup: false });
  const outcome = writeConfig("settings", "theme", "light", { home, now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });
  assert.equal(outcome.ok, true);
  assert.ok(outcome.backup?.includes(".bak-20260102T030405Z"), `unexpected backup name: ${outcome.backup}`);
  assert.equal(readFileSync(outcome.backup!, "utf8"), `${JSON.stringify({ theme: "dark", quietStartup: false }, null, 2)}\n`);
  const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(written.theme, "light");
  assert.equal(written.quietStartup, false, "an unrelated key is preserved");
  assert.equal((outcome.value as Record<string, unknown>).theme, "light");
});

test("value null deletes a key; a missing file is created without a backup", () => {
  const home = scratchHome();
  const path = configPath("settings", home);
  const created = writeConfig("settings", "theme", "dark", { home });
  assert.equal(created.ok, true);
  assert.equal(created.backup, undefined, "there was nothing to back up");
  const removed = writeConfig("settings", "theme", null, { home });
  assert.equal(removed.ok, true);
  assert.equal((JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>).theme, undefined);
});

test("models: an apiKey is masked on read and writable by path", () => {
  const home = scratchHome();
  seedModels(home);
  const view = readConfig("models", { home });
  const providers = (view.value as { providers: { acme: Record<string, unknown> } }).providers;
  assert.equal(providers.acme.apiKey, CONFIG_MASK);
  assert.ok(view.fields.some((field) => field.path === "providers.acme.apiKey" && field.sensitive));

  const outcome = writeConfig("models", "providers.acme.apiKey", "sk-new-value", { home });
  assert.equal(outcome.ok, true);
  const raw = readFileSync(configPath("models", home), "utf8");
  assert.ok(raw.includes("sk-new-value"));
  assert.equal((outcome.value as { providers: { acme: Record<string, unknown> } }).providers.acme.apiKey, CONFIG_MASK, "the response is masked");

  assert.match(validateConfigValue("models", "providers.acme.models", [], { home }) ?? "", /不在可编辑清单/);
  assert.match(validateConfigValue("models", "providers", "x", { home }) ?? "", /不在可编辑清单/);
});

test("a config file the daemon creates is private, and an existing mode is kept", () => {
  const home = scratchHome();
  const settings = configPath("settings", home);
  assert.equal(writeConfig("settings", "theme", "dark", { home }).ok, true);
  assert.equal(statSync(settings).mode & 0o777, 0o600, "a file we create may hold a credential — 0600");

  // An existing mode is PRESERVED, not tightened behind the user's back.
  chmodSync(settings, 0o644);
  assert.equal(writeConfig("settings", "theme", "light", { home }).ok, true);
  assert.equal(statSync(settings).mode & 0o777, 0o644);
});

test("a delete may not touch a field the whitelist does not list", () => {
  const home = scratchHome();
  const path = seedSettings(home, { theme: "dark", packages: ["npm:something"] });
  const refused = writeConfig("settings", "packages", null, { home });
  assert.equal(refused.ok, false);
  assert.match(refused.problem ?? "", /不在可编辑清单里/);
  assert.deepEqual((JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>).packages, ["npm:something"]);
  assert.equal(writeConfig("settings", "theme", null, { home }).ok, true, "a listed field can still be deleted");
});

test("models: a provider the file does not have cannot be created through this endpoint", () => {
  const home = scratchHome();
  seedModels(home);
  const madeUp = writeConfig("models", "providers.invented.apiKey", "sk-new", { home });
  assert.equal(madeUp.ok, false);
  assert.match(madeUp.problem ?? "", /不在现有配置里/);
  const raw = JSON.parse(readFileSync(configPath("models", home), "utf8")) as { providers: Record<string, unknown> };
  assert.equal(raw.providers.invented, undefined);
  // The provider that IS there stays editable.
  assert.equal(writeConfig("models", "providers.acme.baseUrl", "https://other.test/v1", { home }).ok, true);
});

test("gate: a slot list is judged by the gate's own validateSlots", () => {
  const home = scratchHome();
  seedModels(home);
  const repo = join(home, "project");
  mkdirSync(join(repo, ".pi"), { recursive: true });
  writeFileSync(configPath("gate-project", home, repo), `${JSON.stringify({ agents: { reviewer: { auto: false, slots: ["acme/fast"] } } }, null, 2)}\n`);

  assert.equal(validateSlotList(home, ["acme/fast"]), undefined);
  assert.match(validateSlotList(home, []) ?? "", /非空数组/);
  assert.match(validateSlotList(home, ["nope/missing"]) ?? "", /not in the registry/);
  assert.match(validateSlotList(home, ["acme/fast", "a", "b", "c", "d"]) ?? "", /最多 4 项/);
  assert.match(validateSlotList(home, ["acme/fast\nbogus: x"]) ?? "", /不是合法字符串/);

  const refused = writeConfig("gate-project", "agents.reviewer.slots", ["nope/missing"], { home, repo });
  assert.equal(refused.ok, false);
  assert.match(refused.problem ?? "", /not in the registry/);

  const accepted = writeConfig("gate-project", "agents.reviewer.slots", ["acme/fast"], { home, repo });
  assert.equal(accepted.ok, true, accepted.problem ?? "");
  const written = JSON.parse(readFileSync(configPath("gate-project", home, repo), "utf8")) as {
    agents: { reviewer: { slots: string[] } };
  };
  assert.deepEqual(written.agents.reviewer.slots, ["acme/fast"]);

  assert.match(validateConfigValue("gate-project", "agents.unknown-role.slots", [], { home }) ?? "", /不是门禁认识的角色名/);
  assert.equal(validateConfigValue("gate-project", "agents.worker-fast.prompt", "you are fast", { home }), undefined);
  assert.match(validateConfigValue("gate-project", "agents.reviewer.prompt", "x", { home }) ?? "", /只有 worker 预设/);
  assert.match(validateConfigValue("gate-project", "precommit.steps", [], { home }) ?? "", /不在可编辑清单/);
});

test("gate-project without a repo is a refusal, not a guess", () => {
  const home = scratchHome();
  assert.throws(() => configPath("gate-project", home), /必须带 repo/);
  const outcome = writeConfig("gate-project", "agents.reviewer.auto", false, { home });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem ?? "", /必须带 repo/);
});

test("a mask can never be written back over a secret", () => {
  const home = scratchHome();
  seedModels(home);
  const outcome = writeConfig("models", "providers.acme.apiKey", CONFIG_MASK, { home });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem ?? "", /掩码不能写回/);
});

test("a corrupt config file is never overwritten", () => {
  const home = scratchHome();
  const path = configPath("settings", home);
  mkdirSync(agentHome(home), { recursive: true });
  writeFileSync(path, "{ half a json");
  const view = readConfig("settings", { home });
  assert.equal(view.exists, true);
  assert.ok(view.problems.some((problem) => problem.includes("不是合法 JSON")));
  const outcome = writeConfig("settings", "theme", "dark", { home });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem ?? "", /不是合法 JSON/);
  assert.equal(readFileSync(path, "utf8"), "{ half a json");
});
