/**
 * ONE gate for every EXTERNAL side effect the gate can fire.
 *
 * Desktop notifications, tmux commands that change something, terminal escape
 * sequences — all of them are things a test run, a CI job or a headless
 * `pi -p` must never emit. The P0 report that produced this rule measured
 * real side effects escaping from a unit-test run.
 *
 * It lives in its own module (rather than inside whichever feature happened
 * to need it first) because it is a property of the PROCESS, not of any one
 * feature: notification, orchestration and the child channel all ask the same
 * question, and a second copy of this predicate is a second place to forget a
 * case.
 *
 * Pure module: environment in, a boolean out.
 */

/**
 * May this process touch the outside world?
 *
 * Fail-closed in every ambiguous case: a missing TTY, a test runner, CI, or
 * an explicit opt-out all mean no.
 */
export function sideEffectsEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean | undefined = process.stdout.isTTY,
): boolean {
  if (env.RG_NO_SIDE_EFFECTS === "1") return false;
  if (env.NODE_ENV === "test") return false;
  // `node --test` does NOT set NODE_ENV — it sets NODE_TEST_CONTEXT
  // ("child-v8" / "top-level"). Without this branch, test silence rested on
  // the incidental isTTY check alone.
  if (env.NODE_TEST_CONTEXT) return false;
  if (env.CI) return false;
  return isTTY === true;
}
