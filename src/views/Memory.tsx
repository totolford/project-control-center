import { useState } from "react";
import { Brain, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { run } from "../lib/toast";
import { formatRelative } from "../lib/format";
import type { MemoryFile } from "../lib/types";
import { useAgents } from "../store";
import { EmptyState, Loading, PageHeader } from "../components/Common";
import { MemoryEditor, useMemoryFiles } from "../components/MemoryEditor";

const ORDER = ["project", "architecture", "decisions", "conventions", "discoveries"];

function sortKey(key: string): string {
  const i = ORDER.indexOf(key);
  return i >= 0 ? `0${i}` : `1${key}`;
}

export function Memory() {
  const { files, setFiles } = useMemoryFiles();
  const agents = useAgents();
  const [selected, setSelected] = useState<string>("project");
  const [consolidating, setConsolidating] = useState(false);

  const label = (key: string) => {
    if (!key.startsWith("agent:")) return key;
    const id = key.slice(6);
    return `agent · ${agents.find((a) => a.id === id)?.name ?? id}`;
  };

  const consolidate = async () => {
    setConsolidating(true);
    await run(() => api.consolidateMemory(), "Central is consolidating memory");
    setConsolidating(false);
  };

  const onSaved = (f: MemoryFile) => setFiles((cur) => [...(cur ?? []).filter((x) => x.key !== f.key), f]);

  const sorted = files ? [...files].sort((a, b) => sortKey(a.key).localeCompare(sortKey(b.key))) : [];
  const current = sorted.find((f) => f.key === selected) ?? sorted[0];

  return (
    <div className="page page-fill">
      <PageHeader
        title="Memory"
        subtitle="The project's persistent brain in .agent-project/ — shared by Central and every agent."
        actions={
          <button className="btn" onClick={() => void consolidate()} disabled={consolidating}>
            <Sparkles size={13} /> Ask Central to consolidate memory
          </button>
        }
      />
      {files === null ? (
        <Loading />
      ) : sorted.length === 0 ? (
        <EmptyState icon={<Brain size={22} />} title="No memory files" />
      ) : (
        <div className="split">
          <div className="split-list">
            {sorted.map((f) => (
              <button key={f.key} className={`list-item${current?.key === f.key ? " active" : ""}`} onClick={() => setSelected(f.key)}>
                <span>{label(f.key)}</span>
                <span className="muted small">{f.bytes === 0 ? "empty" : formatRelative(f.modified)}</span>
              </button>
            ))}
          </div>
          <div className="split-main">{current && <MemoryEditor key={current.key} memKey={current.key} file={current} onSaved={onSaved} />}</div>
        </div>
      )}
    </div>
  );
}
