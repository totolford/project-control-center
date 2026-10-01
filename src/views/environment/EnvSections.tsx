import { CONNECTION_STATUS } from "../../lib/labels";
import { formatBytes, ratio } from "../../lib/format";
import type { Detection, ProjectInsights, SystemReport } from "../../lib/types";
import { useConnections, useStore } from "../../store";
import { Loading, Section } from "../../components/Common";
import { ProgressBar } from "../../components/ProgressBar";

function State({ loading, error }: { loading: boolean; error: string | null }) {
  if (error) return <div className="notice notice-error small">Unavailable: {error}</div>;
  return loading ? <Loading /> : null;
}

export function SystemSection({ report, loading, error }: { report: SystemReport | null; loading: boolean; error: string | null }) {
  return (
    <Section title="System">
      {!report ? (
        <State loading={loading} error={error} />
      ) : (
        <>
          <dl className="kv">
            <dt>OS</dt>
            <dd>
              {report.os} {report.osVersion} <span className="muted">({report.arch})</span>
            </dd>
            <dt>CPU</dt>
            <dd>
              {report.cpu} <span className="muted">· {report.cpuCores} cores</span>
            </dd>
            <dt>Memory</dt>
            <dd>
              <ProgressBar value={ratio(report.memoryUsedBytes, report.memoryTotalBytes)} label={`${formatBytes(report.memoryUsedBytes)} / ${formatBytes(report.memoryTotalBytes)}`} />
            </dd>
            <dt>GPU</dt>
            <dd>{report.gpus.length === 0 ? "—" : report.gpus.join(", ")}</dd>
          </dl>
          <div className="section-label">Disks</div>
          {report.disks.map((d) => (
            <div key={d.mount} className="disk-row">
              <span className="mono">{d.mount}</span>
              <ProgressBar value={ratio(d.totalBytes - d.availableBytes, d.totalBytes)} label={`${formatBytes(d.availableBytes)} free of ${formatBytes(d.totalBytes)}`} />
            </div>
          ))}
        </>
      )}
    </Section>
  );
}

export function DetectionList({ items }: { items: Detection[] }) {
  return (
    <ul className="detect-list">
      {items.map((d) => (
        <li key={d.key}>
          <span className={d.detected ? "tone-green-fg" : "muted"}>{d.detected ? "✓" : "✗"}</span>
          <span className={d.detected ? "" : "muted"}>{d.label}</span>
          <span className="mono tiny muted ellipsis" title={d.detail ?? undefined}>
            {d.detail ?? (d.detected ? "" : "not found")}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ProjectSection({ insights, loading, error }: { insights: ProjectInsights | null; loading: boolean; error: string | null }) {
  const repo = useStore((s) => s.project?.repo ?? null);
  const connections = useConnections();
  const maxFiles = Math.max(1, ...(insights?.languages.map((l) => l.files) ?? [1]));
  return (
    <Section title="Project">
      {!insights ? (
        <State loading={loading} error={error} />
      ) : (
        <>
          <div className="section-label">Languages ({insights.filesScanned.toLocaleString()} files scanned)</div>
          {insights.languages.length === 0 && <div className="muted small">No source file recognised.</div>}
          {insights.languages.map((l) => (
            <div key={l.language} className="disk-row">
              <span>{l.language}</span>
              <ProgressBar value={l.files / maxFiles} label={`${l.files} files`} />
            </div>
          ))}
          <div className="section-label">Frameworks</div>
          <div className="chips-row">{insights.frameworks.length === 0 ? <span className="muted small">None detected</span> : insights.frameworks.map((f) => <span key={f} className="chip tone-grey">{f}</span>)}</div>
          <div className="section-label">Dependencies</div>
          {Object.keys(insights.dependencies).length === 0 && <div className="muted small">No manifest found.</div>}
          {Object.entries(insights.dependencies).map(([manifest, deps]) => (
            <details key={manifest}>
              <summary className="mono small">
                {manifest} <span className="muted">({deps.length})</span>
              </summary>
              <div className="chips-row dep-chips">
                {deps.map((d) => (
                  <span key={d} className="chip tone-dim mono">
                    {d}
                  </span>
                ))}
              </div>
            </details>
          ))}
        </>
      )}
      <div className="section-label">Git</div>
      {!repo ? (
        <div className="muted small">Unavailable</div>
      ) : !repo.isRepo ? (
        <div className="muted small">Not a git repository</div>
      ) : (
        <dl className="kv">
          <dt>Branch</dt>
          <dd className="mono">{repo.branch ?? "—"}</dd>
          <dt>Changes</dt>
          <dd>{repo.dirtyFiles.length} uncommitted files</dd>
          <dt>Remote</dt>
          <dd className="mono small">
            {repo.remoteUrl ?? "—"}
            {repo.ahead !== null && ` · ↑${repo.ahead} ↓${repo.behind ?? 0}`}
          </dd>
        </dl>
      )}
      <div className="section-label">Connections</div>
      {connections.length === 0 ? (
        <div className="muted small">None</div>
      ) : (
        <ul className="detect-list">
          {connections.map((c) => (
            <li key={c.id}>
              <span className={`dot tone-${c.enabled ? CONNECTION_STATUS[c.status].tone : "dim"}`} />
              <span>{c.name}</span>
              <span className="muted tiny">
                {c.kind} · {c.enabled ? CONNECTION_STATUS[c.status].label : "disabled"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
