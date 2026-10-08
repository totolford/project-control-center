import { memo, useState } from "react";
import type { MemoryFile } from "../lib/types";
import { Loading } from "../components/Common";
import { MemoryEditor, useMemoryFiles } from "../components/MemoryEditor";
import type { PanelBodyProps } from "../workspace/registry";
import { useT } from "../i18n";

export const MemoryPanel = memo(function MemoryPanel(_: PanelBodyProps) {
  const t = useT();
  const { files, setFiles } = useMemoryFiles();
  const [key, setKey] = useState("project");
  if (files === null) return <Loading />;
  if (files.length === 0) return <div className="muted pad">{t("panel.noMemory")}</div>;
  const current = files.find((f) => f.key === key) ?? files[0];
  const onSaved = (f: MemoryFile) => setFiles((cur) => [...(cur ?? []).filter((x) => x.key !== f.key), f]);
  return (
    <div className="memory-panel">
      <select value={current.key} onChange={(e) => setKey(e.target.value)} aria-label={t("panel.memoryFile")}>
        {files.map((f) => (
          <option key={f.key} value={f.key}>
            {f.key}
          </option>
        ))}
      </select>
      <MemoryEditor key={current.key} memKey={current.key} file={current} onSaved={onSaved} />
    </div>
  );
});
