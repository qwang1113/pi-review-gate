import { Badge } from "@/components/ui/badge";
import { STATE_LABELS } from "@/lib/types";

/** The daemon's state word → a badge. Unknown words are shown verbatim, never hidden. */
export function StatusBadge({ state, className }: { state: string; className?: string }) {
  const variant =
    state === "waiting-input"
      ? "destructive"
      : state === "working" || state === "waiting-judge"
        ? "info"
        : state === "done"
          ? "success"
          : state === "stalled" || state === "dead"
            ? "warning"
            : "secondary";
  return (
    <Badge variant={variant} className={className}>
      {STATE_LABELS[state] ?? state}
    </Badge>
  );
}
