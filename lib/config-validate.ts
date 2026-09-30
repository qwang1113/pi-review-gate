/**
 * Config-file validation for the desktop client's config page (r4, 2026-09-30).
 *
 * The client edits five JSON files (pi's `settings.json` / `models.json`, the
 * gate's global and project `review-gate.json`) and must not save one the gate
 * or pi would read differently from what the user sees. Every SEMANTIC rule
 * here is prg's own, reused rather than restated: an agent chain is judged by
 * `validateAgentsForStartup` (the session-start hard check) against the same
 * registry, a precommit step by `parsePrecommitStep`. pi's settings get JSON +
 * known-field TYPE checks only (pi owns their meaning).
 *
 * Pure over injected facts (the registry); `scripts/validate-config.ts` is the
 * process boundary the client calls.
 */

import { effectiveAgentsConfig, parseAgentsSection } from "./agents-config.ts";
import { validateAgentsForStartup } from "./agents-startup.ts";
import { isWorkerRoleName, KNOWN_AGENTS } from "./model-config.ts";
import { KNOWN_THINKING_LEVELS, type ModelRegistry } from "./model-spec.ts";
import { parsePrecommitStep } from "./project-config.ts";

export const CONFIG_KINDS = ["pi-settings", "pi-models", "gate"] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];

/** One problem, addressed by a dotted JSON path (`agents.reviewer`); `""` = the whole file. */
export interface ConfigIssue {
  path: string;
  message: string;
}

export interface ConfigVerdict {
  ok: boolean;
  issues: ConfigIssue[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate one file's full text as `kind`. */
export function validateConfigText(kind: ConfigKind, text: string, registry: ModelRegistry): ConfigVerdict {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return verdict([{ path: "", message: `JSON 语法错误：${e instanceof Error ? e.message : String(e)}` }]);
  }
  if (!isObj(root)) return verdict([{ path: "", message: "顶层必须是一个 JSON 对象" }]);
  switch (kind) {
    case "gate":
      return verdict([...gateAgentIssues(root.agents, registry), ...gatePrecommitIssues(root.precommit)]);
    case "pi-settings":
      return verdict(piSettingsIssues(root));
    case "pi-models":
      return verdict(piModelsIssues(root));
  }
}

function verdict(issues: ConfigIssue[]): ConfigVerdict {
  return { ok: issues.length === 0, issues };
}

/** Every role THIS file declares must resolve on its own — the same check a session start runs. */
function gateAgentIssues(agents: unknown, registry: ModelRegistry): ConfigIssue[] {
  if (agents === undefined) return [];
  if (!isObj(agents)) return [{ path: "agents", message: "agents 必须是对象" }];
  const issues: ConfigIssue[] = parseAgentsSection(agents).diagnostics.map((d) => ({
    path: /^agents\.([\w-]+)/.exec(d)?.[0] ?? "agents",
    message: d,
  }));
  const declared = Object.keys(agents).filter((n) => KNOWN_AGENTS.includes(n) || isWorkerRoleName(n));
  const flagged = new Set(issues.map((i) => i.path));
  // A role this file leaves out is filled by the start-up self-heal; only a
  // role it DOES declare has to stand on its own.
  const { map } = effectiveAgentsConfig(agents, undefined, KNOWN_AGENTS);
  for (const [name, check] of Object.entries(validateAgentsForStartup(map, registry, declared))) {
    if (!check.ok && !flagged.has(`agents.${name}`)) issues.push({ path: `agents.${name}`, message: check.reason ?? "invalid" });
  }
  return issues;
}

function gatePrecommitIssues(precommit: unknown): ConfigIssue[] {
  if (precommit === undefined) return [];
  if (!isObj(precommit)) return [{ path: "precommit", message: "precommit 必须是对象" }];
  const bad = (path: string, v: unknown): ConfigIssue[] =>
    v !== undefined && parsePrecommitStep(v) === undefined
      ? [{ path, message: `${path} 不是合法的步骤（null、脚本名、{script}、{command} 或 {skip:true}）` }]
      : [];
  const issues = (["lint", "typecheck", "build"] as const).flatMap((k) => bad(`precommit.${k}`, precommit[k]));
  const test = precommit.test;
  if (isObj(test) && (test.fast !== undefined || test.full !== undefined)) {
    issues.push(...bad("precommit.test.fast", test.fast), ...bad("precommit.test.full", test.full));
  } else {
    issues.push(...bad("precommit.test", test));
  }
  return issues;
}

// pi's own `Settings` interface (pi-coding-agent settings-manager.d.ts): the
// fields whose type is plain enough to check. pi owns their meaning.
const PI_STRING = ["defaultProvider", "defaultModel", "theme", "externalEditor", "shellPath", "shellCommandPrefix", "sessionDir", "httpProxy", "lastChangelogVersion"];
const PI_BOOL = ["hideThinkingBlock", "quietStartup", "collapseChangelog", "enableSkillCommands", "showHardwareCursor", "enableInstallTelemetry", "enableAnalytics"];
const PI_STRINGS = ["extensions", "skills", "prompts", "themes", "enabledModels", "defaultTools", "npmCommand"];
const PI_NUMBER = ["editorPaddingX", "autocompleteMaxVisible", "httpIdleTimeoutMs", "websocketConnectTimeoutMs"];

function piSettingsIssues(root: Obj): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const check = (keys: string[], ok: (v: unknown) => boolean, what: string) => {
    for (const k of keys) if (root[k] !== undefined && !ok(root[k])) issues.push({ path: k, message: `${k} 必须是${what}` });
  };
  check(PI_STRING, (v) => typeof v === "string", "字符串");
  check(PI_BOOL, (v) => typeof v === "boolean", "布尔值");
  check(PI_NUMBER, (v) => typeof v === "number" && Number.isFinite(v), "数字");
  check(PI_STRINGS, (v) => Array.isArray(v) && v.every((s) => typeof s === "string"), "字符串数组");
  const levels = [...KNOWN_THINKING_LEVELS].join(" / ");
  const level = root.defaultThinkingLevel;
  if (level !== undefined && !(typeof level === "string" && KNOWN_THINKING_LEVELS.has(level))) {
    issues.push({ path: "defaultThinkingLevel", message: `defaultThinkingLevel 必须是 ${levels} 之一` });
  }
  const per = root.modelThinkingLevels;
  if (per !== undefined) {
    if (!isObj(per)) issues.push({ path: "modelThinkingLevels", message: "modelThinkingLevels 必须是对象" });
    else for (const [m, v] of Object.entries(per)) {
      if (!(typeof v === "string" && KNOWN_THINKING_LEVELS.has(v))) issues.push({ path: `modelThinkingLevels.${m}`, message: `必须是 ${levels} 之一` });
    }
  }
  return issues;
}

function piModelsIssues(root: Obj): ConfigIssue[] {
  const providers = root.providers;
  if (providers === undefined) return [];
  if (!isObj(providers)) return [{ path: "providers", message: "providers 必须是对象" }];
  const issues: ConfigIssue[] = [];
  for (const [name, p] of Object.entries(providers)) {
    const at = `providers.${name}`;
    if (!isObj(p)) {
      issues.push({ path: at, message: `${at} 必须是对象` });
      continue;
    }
    if (p.models === undefined) continue;
    if (!Array.isArray(p.models)) {
      issues.push({ path: `${at}.models`, message: "models 必须是数组" });
      continue;
    }
    p.models.forEach((m, i) => {
      if (!isObj(m) || typeof m.id !== "string" || !m.id) issues.push({ path: `${at}.models.${i}`, message: "每个模型必须是带非空字符串 id 的对象" });
    });
  }
  return issues;
}
