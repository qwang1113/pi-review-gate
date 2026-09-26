import { readFileSync } from "node:fs";

/**
 * The parsed JSON at `path`, or undefined when it is absent, unreadable or not
 * JSON. For the best-effort readers only — a caller that must tell "missing"
 * from "corrupt" (and report it) reads the file itself.
 */
export function readJsonIfExists(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
