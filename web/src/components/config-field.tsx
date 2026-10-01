import { PlusIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ConfigField } from "@/lib/types";

/**
 * One editable field. The control is chosen from the field's declared kind —
 * never guessed from the current value, because an unset key has no value to
 * guess from and the daemon validates by kind.
 */
export function ConfigFieldEditor({
  field,
  value,
  onChange,
  disabled,
}: {
  field: ConfigField;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
}) {
  const masked = field.sensitive;  if (field.kind === "boolean") {
    return (
      <Switch
        checked={value === true}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked)}
        aria-label={field.path}
      />
    );
  }

  if (field.kind === "string[]") {
    // A slot chain: one line per slot, exactly as `validateSlots` reads it.
    const list = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="flex flex-col gap-1">
        {list.map((item, index) => (
          <div key={`${field.path}-${index}`} className="flex items-center gap-1">
            <Input
              value={item}
              disabled={disabled}
              onChange={(event) => {
                const next = [...list];
                next[index] = event.target.value;
                onChange(next);
              }}
              className="h-8 font-mono text-[12px]"
            />
            <Button
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              disabled={disabled}
              onClick={() => onChange(list.filter((_, at) => at !== index))}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-fit text-[11px]"
          disabled={disabled}
          onClick={() => onChange([...list, ""])}
        >
          <PlusIcon className="size-3.5" />
          加一个槽位
        </Button>
      </div>
    );
  }

  if (field.kind === "number") {
    return (
      <Input
        type="number"
        value={value === undefined || value === null ? "" : String(value)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
        className="h-8"
      />
    );
  }

  if (field.kind === "json") {
    return (
      <Textarea
        value={typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-24 font-mono text-[12px]"
      />
    );
  }

  const long = field.path.endsWith(".prompt");
  if (long) {
    return (
      <Textarea
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-32 font-mono text-[12px]"
      />
    );
  }

  return (
    <Input
      value={typeof value === "string" ? value : ""}
      disabled={disabled}
      placeholder={masked && field.current !== undefined ? String(field.current) : undefined}
      onChange={(event) => onChange(event.target.value)}
      className="h-8"
      type="text"
    />
  );
}
