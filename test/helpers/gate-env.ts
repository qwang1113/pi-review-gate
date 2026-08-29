/**
 * Hermetic GATE environment for tests.
 *
 * The gate marks its own sessions with environment variables — most sharply
 * `RG_STATE_VARIANT`, which tells the hook (and the extension) that THIS
 * session owns a sidecar of its own: `.pi/review-gate-state.<variant>.json`
 * instead of the default file. An orchestrator gives every child it spawns
 * one.
 *
 * Tests that spawn the hook or a second pi process inherit `process.env`, so
 * inside such a session those variables travel into the fixture: the hook
 * looks for a variant sidecar the fixture never wrote, finds nothing, takes
 * the "no sidecar → extension not active here → allow" path, and every
 * "this must be BLOCKED" assertion fails. Measured on an unchanged tree: 55
 * failures inside an orchestrator child, 0 in a plain shell — a suite that
 * passes or fails depending on WHO runs it, which is the same correctness
 * hazard test/helpers/git.ts neutralises for the host git config.
 *
 * Stripped by PREFIX rather than by an explicit list: a variable added to the
 * gate later would otherwise reintroduce exactly this bug, silently, in the
 * one environment where nobody runs the suite by hand. A test that WANTS one
 * of these variables still passes it explicitly to the child process it
 * spawns — this only clears what leaks in by inheritance.
 */

/** Every environment variable the gate itself sets starts with one of these. */
export const GATE_ENV_PREFIXES = ["RG_", "REVIEW_GATE_"] as const;

/** The keys of `env` this helper would remove. */
export function gateEnvKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((key) => GATE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)));
}

/**
 * Remove the gate's own variables from `process.env`, once, at module load —
 * so every `spawnSync`/`execFileSync` in the file (including calls added
 * later) starts from a session-neutral environment.
 *
 * `node --test` runs each test file in its own process, so this cannot leak
 * into another file. Returns what it removed, for a test that asserts on it.
 */
export function neutraliseGateEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = gateEnvKeys(env);
  for (const key of removed) delete env[key];
  return removed;
}
