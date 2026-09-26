/**
 * The session-start refusal a failed agents check puts into the system prompt.
 *
 * Kept apart from lib/agents-startup.ts (which decides) so the copy is a pure,
 * testable function and renders through the ONE refusal shape,
 * lib/rejection-copy.ts. Every file it names comes from the check's result:
 * the layer that declares the broken role, never a hard-coded global path.
 */

import type { StartupAgentsResult } from "./agents-startup.ts";
import { buildRejection } from "./rejection-copy.ts";

export function formatAgentsStartupRefusal(
  result: Pick<StartupAgentsResult, "checks" | "healProblems" | "configFiles" | "fixFiles">,
): string | undefined {
  const bad = Object.entries(result.checks).filter(([, c]) => c && !c.ok);
  if (bad.length === 0) return undefined;
  const details = bad
    .map(([name, c]) => `- ${name}: ${c?.reason ?? "未知原因"}（配置文件：${result.configFiles[name] ?? "未知"}）`)
    .join("\n");
  const healNote = result.healProblems.length > 0
    ? `\n启动自愈也没能补上（原因如下）：\n${result.healProblems.map((p) => `- ${p}`).join("\n")}`
    : "";
  return `\n\n## REVIEW-GATE: 配置错误，会话无法启动\n` + buildRejection({
    what: `角色模型配置不完整 —— 以下角色无法获得可派发的模型链：\n${details}${healNote}`,
    why: "每个角色都必须有一条可解析的模型链，门禁不做静默默认回退；在配置修复前，本会话拒绝执行任何工作（ship 命令仍被拦截）。",
    by: "user",
    next:
      `修复 ${result.fixFiles.join("、")} 后重开会话：` +
      `\n- 不在 agents 段里的角色（或值为空对象的）：启动时会自动补上包内默认链；` +
      `\n- 已有条目但不可用的角色（auto:true / slots 为空 / spec 不可解析）：改成明确的 auto:false + slots，` +
      `或删掉这个键让门禁补默认（worker 预设没有包内默认，删掉即不再有该预设）。`,
  });
}
