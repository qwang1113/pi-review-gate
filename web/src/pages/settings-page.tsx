import { FolderOpenIcon, SaveIcon, ShieldAlertIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ConfigFieldEditor } from "@/components/config-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { api, describeError } from "@/lib/api";
import type { ConfigField, ConfigTarget, ConfigView } from "@/lib/types";
import { cn } from "@/lib/utils";

const TARGET_GROUPS: { label: string; items: { value: ConfigTarget; label: string }[] }[] = [
  {
    label: "pi 设置",
    items: [
      { value: "settings", label: "settings.json" },
      { value: "models", label: "models.json" },
    ],
  },
  {
    label: "门禁配置",
    items: [
      { value: "gate-global", label: "全局 review-gate.json" },
      { value: "gate-project", label: "项目 review-gate.json" },
    ],
  },
];

interface SaveResult {
  path: string;
  ok: boolean;
  message: string;
}

/**
 * Configuration for pi and for the gate, read and written through the daemon —
 * the browser never touches a file. Secrets come back masked and are only sent
 * back when the user types a new value; a masked placeholder is never a value.
 */
export default function SettingsPage() {
  const [target, setTarget] = useState<ConfigTarget>("settings");
  const [repo, setRepo] = useState("");
  const [repoDraft, setRepoDraft] = useState("");
  const [view, setView] = useState<ConfigView | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<SaveResult[]>([]);

  const needsRepo = target === "gate-project";

  const load = useCallback(
    async (clearResults = true) => {
      if (needsRepo && repo === "") {
        setView(null);
        return;
      }
      setLoading(true);
      setError(null);
      // A reload after a write keeps the write's receipts on screen; only a
      // fresh read (target switch, manual refresh) starts from a clean slate.
      if (clearResults) setResults([]);
      try {
        const query = new URLSearchParams({ target });
        if (needsRepo) query.set("repo", repo);
        const payload = await api<ConfigView>(`/api/config?${query.toString()}`);
        setView(payload);
        const initial: Record<string, unknown> = {};
        for (const field of payload.fields) initial[field.path] = field.current ?? (field.kind === "boolean" ? false : "");
        setValues(initial);
        setDirty([]);
      } catch (failure) {
        setError(describeError(failure));
        setView(null);
      } finally {
        setLoading(false);
      }
    },
    [target, repo, needsRepo],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const setValue = (path: string, next: unknown) => {
    setValues((current) => ({ ...current, [path]: next }));
    setDirty((current) => (current.includes(path) ? current : [...current, path]));
  };

  const save = async () => {
    if (view === null || dirty.length === 0) return;
    setSaving(true);
    setResults([]);
    const collected: SaveResult[] = [];
    for (const path of dirty) {
      const field = view.fields.find((candidate) => candidate.path === path);
      if (field === undefined) continue;
      let value = values[path];
      // An untouched secret stays untouched: the mask is not a value, and the
      // daemon refuses it anyway (`docs/daemon/api.md` §6.3).
      if (field.sensitive && typeof value === "string" && value.trim() === "") {
        collected.push({ path, ok: true, message: "未改动 —— 保留原值" });
        continue;
      }
      if (field.kind === "json" && typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch (failure) {
          collected.push({ path, ok: false, message: `不是合法 JSON：${describeError(failure)}` });
          continue;
        }
      }
      try {
        const receipt = await api<{ backup?: string; path?: string }>("/api/config", {
          method: "PUT",
          body: { target, ...(needsRepo ? { repo } : {}), path, value },
        });
        collected.push({
          path,
          ok: true,
          message: receipt.backup === undefined ? "已写入（原文件不存在，没有备份）" : `已写入，备份：${receipt.backup}`,
        });
      } catch (failure) {
        collected.push({ path, ok: false, message: describeError(failure) });
      }
    }
    setResults(collected);
    setSaving(false);
    // Re-read: the daemon echoes the masked file, and a rejected write changed nothing.
    await load(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold tracking-tight">设置</h1>

      <div className="flex flex-wrap gap-4">
        {TARGET_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">{group.label}</span>
            <div className="flex rounded-md border p-0.5">
              {group.items.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setTarget(item.value)}
                  className={cn(
                    "rounded-[5px] px-2.5 py-1 text-[12px] transition-colors",
                    target === item.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {needsRepo && (
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <label className="text-xs font-medium" htmlFor="config-repo">
              仓库绝对路径
            </label>
            <Input
              id="config-repo"
              value={repoDraft}
              onChange={(event) => setRepoDraft(event.target.value)}
              placeholder="/Users/me/workspace/project"
              className="font-mono text-[12px]"
            />
          </div>
          <Button variant="outline" onClick={() => setRepo(repoDraft.trim())}>
            <FolderOpenIcon className="size-3.5" />
            读取这个仓库
          </Button>
        </div>
      )}

      {error !== null && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {view !== null && (
        <Card>
          <CardHeader className="flex-col gap-0.5">
            <CardTitle className="font-mono text-[12px]">{view.path}</CardTitle>
            <span className="text-[11px] text-muted-foreground">
              {view.exists ? "文件存在" : "文件还不存在 —— 写入时会新建"}
              {view.backups.length > 0 ? ` · 已有 ${view.backups.length} 份备份` : ""}
            </span>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {view.problems.length > 0 && (
              <div className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
                <ShieldAlertIcon className="mt-px size-3.5 shrink-0" />
                <div>
                  {view.problems.map((problem) => (
                    <div key={problem}>{problem}</div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
              <ShieldAlertIcon className="mt-px size-3.5 shrink-0" />
              <span>
                每次写入前 daemon 会把原文件复制成 <code className="rounded bg-muted px-1">&lt;文件名&gt;.bak-&lt;UTC 时间戳&gt;</code>
                （与原文件同目录，只保留最新 10 份）。敏感字段只显示掩码，不填就是保留原值。
              </span>
            </div>

            {view.fields.length === 0 && (
              <p className="text-xs text-muted-foreground">这个目标目前没有可编辑字段。</p>
            )}

            {view.fields.map((field, index) => (
              <FieldRow
                key={field.path}
                field={field}
                value={values[field.path]}
                dirty={dirty.includes(field.path)}
                onChange={(next) => setValue(field.path, next)}
                disabled={saving}
                last={index === view.fields.length - 1}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {results.length > 0 && (
        <Card className="py-3">
          <CardHeader className="pb-1">
            <CardTitle className="text-[13px]">写入结果</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-[11px]">
            {results.map((result) => (
              <div key={result.path} className={result.ok ? "text-success" : "text-destructive"}>
                <span className="font-mono">{result.path}</span> —— {result.message}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-3">
        <Button disabled={dirty.length === 0 || saving} onClick={() => void save()}>
          <SaveIcon className="size-4" />
          保存改动{dirty.length > 0 ? `（${dirty.length} 项）` : ""}
        </Button>
        <Button variant="outline" disabled={loading} onClick={() => void load()}>
          重新读取
        </Button>
        {loading && <span className="text-[11px] text-muted-foreground">读取中…</span>}
      </div>
    </div>
  );
}

function FieldRow({
  field,
  value,
  dirty,
  onChange,
  disabled,
  last,
}: {
  field: ConfigField;
  value: unknown;
  dirty: boolean;
  onChange: (next: unknown) => void;
  disabled: boolean;
  last: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-4">
        <div className="w-72 shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[12px] break-all">{field.path}</span>
            {field.sensitive && <span className="rounded bg-warning/15 px-1 text-[10px] text-warning">敏感</span>}
            {dirty && <span className="rounded bg-info/15 px-1 text-[10px] text-info">已改</span>}
          </div>
          <span className="text-[11px] text-muted-foreground">
            {field.kind}
            {field.note !== undefined ? ` · ${field.note}` : ""}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <ConfigFieldEditor field={field} value={value} onChange={onChange} disabled={disabled} />
        </div>
      </div>
      {!last && <Separator className="mt-2" />}
    </div>
  );
}
