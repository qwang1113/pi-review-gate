/** Small presentation helpers — no domain logic lives here. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3 分钟前" — relative to now, coarse on purpose: this is a status strip, not a clock. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (iso === null || iso === undefined || iso === "") return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const delta = now - at;
  if (delta < 0) return "刚刚";
  if (delta < MINUTE) return "刚刚";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分钟前`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时前`;
  return `${Math.floor(delta / DAY)} 天前`;
}

/** "17:04:11" — the time an output entry happened, for the live stream. */
export function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "--:--:--";
  return at.toLocaleTimeString("zh-CN", { hour12: false });
}

/** "/Users/me/x/y" → "~/x/y". Only a display affordance — the daemon keeps absolute paths. */
export function tildePath(path: string | null | undefined): string {
  if (typeof path !== "string") return "—";
  const match = /^\/Users\/[^/]+/.exec(path);
  if (match === null) return path;
  return `~${path.slice(match[0].length)}`;
}

/** The last two segments, enough to recognise a directory in a narrow column. */
export function shortPath(path: string | null | undefined): string {
  if (typeof path !== "string" || path === "") return "—";
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}
