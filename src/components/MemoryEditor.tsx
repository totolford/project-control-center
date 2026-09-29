import { useCallback, useEffect, useState } from "react";
import { Pencil, Save, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { attempt } from "../lib/toast";
import { formatBytes, formatRelative } from "../lib/format";
import type { MemoryFile } from "../lib/types";
import { useStore } from "../store";
import { Spinner } from "./Common";

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
    const saved = await attempt(() => api.saveMemory(memKey, draft), "Memory saved");
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
            {formatBytes(file.bytes)} · modified {formatRelative(file.modified)}
          </span>
        )}
        {editing ? (
          <>
            <button className="btn" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void save()} disabled={saving || draft === content}>
              {saving ? <Spinner size={12} /> : <Save size={13} />} Save
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => setEditing(true)}>
            <Pencil size={13} /> {file ? "Edit" : "Create"}
          </button>
        )}
      </div>
      {changedOnDisk && (
        <div className="notice notice-warn">
          <TriangleAlert size={14} /> This file was updated by an agent while you were editing. Saving will overwrite that change.
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
          aria-label={`Edit ${memKey}`}
        />
      ) : content ? (
        <div className="memory-read prewrap">{content}</div>
      ) : (
        <div className="muted pad">{file ? "This memory file is empty." : "This memory file does not exist yet."}</div>
      )}
    </div>
  );
}
