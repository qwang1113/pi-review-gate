import { createHash } from "node:crypto";

/** Hex sha256 of a string (UTF-8). The gate's one content hash. */
export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
