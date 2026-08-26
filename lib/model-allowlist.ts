/**
 * Provider-level model allowlist — standalone module.
 *
 * Moved here when `lib/pdw-bridge.ts` was deleted with the pdw engine (step 2
 * of `docs/parallel-execution-plan.md`): the allowlist is a USER REQUIREMENT that
 * must survive the engine, because it still guards where judges are chosen
 * (`lib/model-config.ts`), the /gate-doctor facts (`lib/gate-doctor.ts`,
 * `lib/model-diagnose.ts`) and the extension's own model-config facts
 * (`extensions/review-gate.ts`).
 */
export function isModelAllowed(model: unknown): boolean {
  if (typeof model !== "object" || model === null) return false;
  const obj = model as { provider?: unknown; id?: unknown };
  if (typeof obj.provider !== "string" || typeof obj.id !== "string") return false;
  if (obj.provider === "opencode-go") return obj.id === "deepseek-v4-flash";
  return true;
}
