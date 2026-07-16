/**
 * Worktree fingerprint — a stable hash of "what the code looks like right now".
 *
 * A gate pass is only valid for the exact worktree state it reviewed. Any
 * subsequent change (staged, unstaged, untracked, or a HEAD move) invalidates
 * the pass. Uses `-uall` so untracked files participate.
 *
 * Includes staged diff separately (index-only changes change the fingerprint),
 * and hashes actual content of untracked code/doc files.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CODE_EXTENSIONS, DOC_EXTENSIONS, extOf } from "./constants.ts";

const CODE_DOC_EXT = new Set([...CODE_EXTENSIONS, ...DOC_EXTENSIONS]);

export interface Fingerprint {
  digest: string;
  head: string;
  unavailable: boolean;
}

function gitOrNull(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export function computeFingerprint(cwd: string): Fingerprint {
  try {
    const head = gitOrNull(cwd, ["rev-parse", "HEAD"]) ?? "NO_HEAD";

    // P1 fix: staged diff failure → fail closed (unavailable=true).
    let stagedDiff = gitOrNull(cwd, ["diff", "--cached"]);
    if (stagedDiff === null) {
      return { digest: "__UNAVAILABLE__", head: "__UNAVAILABLE__", unavailable: true };
    }

    let trackedDiff: string | null;
    if (head === "NO_HEAD") {
      trackedDiff = stagedDiff; // fresh repo: --cached is the whole picture
    } else {
      trackedDiff = gitOrNull(cwd, ["diff", "HEAD"]);
    }
    if (trackedDiff === null) {
      return { digest: "__UNAVAILABLE__", head: "__UNAVAILABLE__", unavailable: true };
    }

    const porcelain = gitOrNull(cwd, ["status", "--porcelain", "-uall", "-z"]);
    if (porcelain === null) {
      return { digest: "__UNAVAILABLE__", head: "__UNAVAILABLE__", unavailable: true };
    }

    // Parse NUL-delimited porcelain (-z). Each entry: "XY path\0" or "XY orig\0new\0".
    const entries = porcelain.split("\0").filter(Boolean);
    const untrackedMeta: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const status = entries[i].slice(0, 2);
      if (status !== "??") continue;
      const name = entries[i].slice(3);
      if (!name) continue;
      const ext = extOf(name);
      if (CODE_DOC_EXT.has(ext)) {
        try {
          const content = readFileSync(join(cwd, name), "utf8");
          untrackedMeta.push(`${name}:sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`);
        } catch {
          untrackedMeta.push(`${name}:unstat`);
        }
      } else {
        try {
          const st = statSync(join(cwd, name));
          untrackedMeta.push(`${name}:${st.size}:${st.mtimeMs}`);
        } catch {
          untrackedMeta.push(`${name}:unstat`);
        }
      }
    }

    const digest = createHash("sha256")
      .update(head).update("\0")
      .update(stagedDiff).update("\0")
      .update(trackedDiff).update("\0")
      .update(porcelain).update("\0")
      .update(untrackedMeta.sort().join("\n"))
      .digest("hex");

    return { digest, head, unavailable: false };
  } catch {
    return { digest: "__UNAVAILABLE__", head: "__UNAVAILABLE__", unavailable: true };
  }
}

/** List changed file paths from NUL-delimited porcelain. */
export function changedFiles(cwd: string): string[] | undefined {
  try {
    const porcelain = gitOrNull(cwd, ["status", "--porcelain", "-uall", "-z"]);
    if (porcelain === null) return undefined;
    if (!porcelain) return [];
    const entries = porcelain.split("\0").filter(Boolean);
    const files: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const status = entries[i].slice(0, 2);
      const path = entries[i].slice(3);
      if (!path) continue;
      // P0-6: rename in -z format: "R  orig\0dest". Include BOTH paths
      // so a code→doc rename arms both gates, not just the destination.
      if (status.startsWith("R") && i + 1 < entries.length && entries[i + 1].length > 0 && !entries[i + 1].startsWith("?")) {
        files.push(path);            // old path
        files.push(entries[++i]);    // new path (destination)
      } else {
        files.push(path);
      }
    }
    return files;
  } catch {
    return undefined;
  }
}
