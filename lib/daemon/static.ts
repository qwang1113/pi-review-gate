/**
 * THE STATIC HALF — serving the web panel's build output.
 *
 * ── WHAT IT IS ──
 *
 * Everything outside `/api/` is a file from `web/dist` (the web workspace's
 * build output). It is intentionally boring: a path that resolves inside the
 * root is served, an unknown path falls back to `index.html` so a single-page
 * app's own routes survive a reload, and a path that tries to climb out of the
 * root is just an unknown path.
 *
 * ── WHY A MISSING BUILD IS A PAGE, NOT A 500 ──
 *
 * "The panel has not been built yet" is the NORMAL state of a source checkout —
 * the daemon can be started long before anyone runs `npm run build:web`, and an
 * API that answers every call must not look broken because of it. So the
 * fallback explains itself and names the command, with a 200: nothing failed.
 *
 * Split out of lib/daemon/server.ts (which owns the API and its routing): the
 * two answer different questions, and a file that grows past what one reviewer
 * can hold is how the gate's own size rule is earned.
 */

import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

/** The web workspace's build output, relative to the package root. */
export const DEFAULT_WEB_DIR = resolve(new URL("../../web/dist", import.meta.url).pathname);

export interface StaticReply {
  status: number;
  buffer?: Buffer;
  text?: string;
  contentType?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * A path under `root`, or undefined when it would escape it.
 *
 * The check is on the RESOLVED path, not on the string: `%2e%2e%2f` decodes to
 * `../` and `normalize` folds it away, so the comparison decides on what the
 * file system would actually open. A NUL byte is refused outright — it is how a
 * path is truncated at a lower layer, and there is no panel file with one.
 */
export function safeJoin(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\u0000")) return undefined;
  const candidate = normalize(join(root, decoded));
  const base = normalize(root);
  return candidate === base || candidate.startsWith(base.endsWith(sep) ? base : `${base}${sep}`) ? candidate : undefined;
}

function serveFile(path: string): StaticReply | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    return {
      status: 200,
      buffer: readFileSync(path),
      contentType: CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    };
  } catch {
    return undefined;
  }
}

/** Shown when the panel has not been built — a page, not an error. */
export function missingBuildPage(webDir: string): string {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>pi-gate 面板尚未构建</title>
<style>body{font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:46rem;margin:4rem auto;padding:0 1.5rem;color:#222}
code{background:#f2f2f2;padding:.1rem .35rem;border-radius:4px}h1{font-size:1.3rem}</style></head>
<body><h1>面板还没构建</h1>
<p>daemon 在跑，但它找不到静态产物：<code>${webDir}</code></p>
<p>在仓库根目录执行 <code>npm run build:web</code> 之后刷新本页即可。API 不受影响，
<code>/api/*</code> 一直是可用的。</p></body></html>`;
}

/** The three-way answer: the file, the SPA fallback, or the explanation page. */
export function servePanel(webDir: string, pathname: string): StaticReply {
  const requested = safeJoin(webDir, pathname === "/" ? "/index.html" : pathname);
  if (requested !== undefined) {
    const file = serveFile(requested);
    if (file !== undefined) return file;
  }
  const fallback = serveFile(join(webDir, "index.html"));
  if (fallback !== undefined) return { ...fallback, contentType: "text/html; charset=utf-8" };
  return { status: 200, text: missingBuildPage(webDir), contentType: "text/html; charset=utf-8" };
}
