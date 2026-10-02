import { useState } from "react";
import { ArchiveRestore, DatabaseBackup, RefreshCw } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../../lib/api";
import { COMPAT_STATUS, compatRows } from "../../lib/compat";
import { formatDateTime } from "../../lib/format";
import { attempt, run } from "../../lib/toast";
import { useLoad } from "../../lib/useLoad";
import type { BackupInfo } from "../../lib/types";
import { rollbackAndClose } from "../../state/opsActions";
import { useStore } from "../../store";
import { Loading, Section, Spinner } from "../../components/Common";
import { Chip } from "../../components/StatusBadge";

function Report({ root }: { root: string }) {
  const { data, error, loading, reload } = useLoad(() => api.compatibilityReport(root));
  return (
    <div>
      <div className="row">
        <div className="section-label grow">Report</div>
        <button className="icon-btn" onClick={() => void reload()} disabled={loading} aria-label="Reload report">
          {loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
        </button>
      </div>
      {error && <div className="notice notice-error small">{error}</div>}
      {!data && loading && <Loading />}
      {data && (
        <>
          <Chip tone={COMPAT_STATUS[data.status].tone}>{COMPAT_STATUS[data.status].label}</Chip>
          {data.readOnly && <Chip tone="amber">read-only</Chip>}
          <table className="table compact-table compat-table">
            <tbody>
              {compatRows(data).map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td className={`mono${r.warn ? " tone-amber-fg" : ""}`}>{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.plan.length > 0 && (
            <>
              <div className="section-label">Pending migration</div>
              <ul className="bullet-list small">
                {data.plan.map((s) => (
                  <li key={`${s.from}-${s.to}`}>
                    {s.from} → {s.to}: <strong>{s.title}</strong> — {s.description}
                  </li>
                ))}
              </ul>
            </>
          )}
          {data.notes.length > 0 && (
            <ul className="bullet-list small muted">
              {data.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Backups({ root }: { root: string }) {
  const { data, error, loading, reload } = useLoad(() => api.projectBackups(root));
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const backup = async () => {
    setBusy("new");
    const made = await attempt(() => api.backupProject(label.trim() || "manual"), "Backup created");
    setBusy(null);
    if (made) {
      setLabel("");
      void reload();
    }
  };

  const restore = async (b: BackupInfo) => {
    const ok = await ask(
      `Restore the backup of ${formatDateTime(b.createdAt)} (${b.reason})? The project is closed, its current state is backed up first, and you return to the welcome screen.`,
      { title: "Restore backup", kind: "warning", okLabel: "Restore" },
    );
    if (!ok) return;
    setBusy(b.id);
    if (!(await rollbackAndClose(root, b.id))) setBusy(null);
  };

  return (
    <div>
      <div className="section-label">Backups</div>
      <div className="row">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" aria-label="Backup label" />
        <button className="btn btn-sm" onClick={() => void backup()} disabled={busy !== null}>
          {busy === "new" ? <Spinner size={11} /> : <DatabaseBackup size={12} />} Back up now
        </button>
      </div>
      {error && <div className="notice notice-error small">{error}</div>}
      {!data && loading && <Loading />}
      {data?.length === 0 && <div className="muted small">No backup yet.</div>}
      {data && data.length > 0 && (
        <table className="table compact-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Reason</th>
              <th>Format</th>
              <th>Path</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((b) => (
              <tr key={b.id}>
                <td className="mono">{formatDateTime(b.createdAt)}</td>
                <td>{b.reason}</td>
                <td className="mono">{b.formatVersion ?? "unknown"}</td>
                <td>
                  <button className="link-btn mono small ellipsis" onClick={() => void run(() => api.revealPath(b.path))} title={b.path}>
                    {b.path}
                  </button>
                </td>
                <td>
                  <button className="btn btn-sm" onClick={() => void restore(b)} disabled={busy !== null}>
                    {busy === b.id ? <Spinner size={11} /> : <ArchiveRestore size={12} />} Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Settings → Compatibility: format report, manual backups and restore. */
export function CompatibilitySettings() {
  const root = useStore((s) => s.project?.info.root);
  if (!root) return null;
  return (
    <Section title="Compatibility">
      <div className="grid-2">
        <Report root={root} />
        <Backups root={root} />
      </div>
    </Section>
  );
}
