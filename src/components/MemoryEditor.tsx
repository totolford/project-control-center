import { useCallback, useEffect, useState } from "react";
import { Pencil, Save, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { attempt } from "../lib/toast";
import { formatBytes, formatRelative } from "../lib/format";
import type { MemoryFile } from "../lib/types";
import { useStore } from "../store";
import { Spinner } from "./Common";
import { useT } from "../i18n";

/** Memory files, reloaded whenever a MemoryUpdated event arrives. */
export function useMemoryFiles() {
  const version = useStore((s) => s.project?.memoryVersion ?? 0);
  const [files, setFiles] = useState<MemoryFile[] | null>(null);
  const reload = useCallback(async () => {
    const f = await attempt(() => api.memoryFiles());
    if (f) setFiles(f);
    else setFiles((cur) => cur ?? []);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, version]);
  return { files, reload, setFiles };
}

export function MemoryEditor({ memKey, file, onSaved }: { memKey: string; file: MemoryFile | undefined; onSaved: (f: MemoryFile) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(file?.content ?? "");
  const [base, setBase] = useState(file?.content ?? "");
  const [saving, setSaving] = useState(false);
  const content = file?.content ?? "";

  useEffect(() => {
    if (!editing) {
      setDraft(content);
      setBase(content);
    }
  }, [content, editing]);

  const save = async () => {
    setSaving(true);
    const saved = await attempt(() => api.saveMemory(memKey, draft), t("comp.mem.saved"));
    setSaving(false);
    if (saved) {
      onSaved(saved);
      setEditing(false);
    }
  };

  const changedOnDisk = editing && content !== base;

  return (
    <div className="memory-editor">
      <div className="memory-toolbar">
        <code className="grow">{file?.path ?? memKey}</code>
        {file && (
          <span className="muted small">
            {formatBytes(file.bytes)} · {t("comp.mem.modified", { time: formatRelative(file.modified) })}
          </span>
        )}
        {editing ? (
          <>
            <button className="btn" onClick={() => setEditing(false)} disabled={saving}>
              {t("common.cancel")}
            </button>
            <button className="btn primary" onClick={() => void save()} disabled={saving || draft === content}>
              {saving ? <Spinner size={12} /> : <Save size={13} />} {t("common.save")}
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => setEditing(true)}>
            <Pencil size={13} /> {file ? t("common.edit") : t("common.create")}
          </button>
        )}
      </div>
      {changedOnDisk && (
        <div className="notice notice-warn">
          <TriangleAlert size={14} /> {t("comp.mem.changedOnDisk")}
        </div>
      )}
      {editing ? (
        <textarea
          className="memory-textarea mono"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void save();
            }
          }}
          aria-label={t("comp.mem.editAria", { name: memKey })}
        />
      ) : content ? (
        <div className="memory-read prewrap">{content}</div>
      ) : (
        <div className="muted pad">{file ? t("comp.mem.empty") : t("comp.mem.missing")}</div>
      )}
    </div>
  );
}
