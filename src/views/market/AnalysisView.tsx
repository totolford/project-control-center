// Security analysis and file list of a market entry, computed from its real files.

import { useState } from "react";
import { AlertOctagon, AlertTriangle, CheckCircle2, FileText, Info, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { MarketAnalysis, SecurityFinding, SecurityLevel } from "../../lib/types";
import { Chip } from "../../components/StatusBadge";
import { formatBytes, securityLabel, securityTone } from "./marketModel";

const LEVEL_ICON: Record<SecurityLevel, typeof Info> = {
  ok: CheckCircle2,
  info: Info,
  warn: AlertTriangle,
  danger: AlertOctagon,
};

function Finding({ f }: { f: SecurityFinding }) {
  const [open, setOpen] = useState(false);
  const Icon = LEVEL_ICON[f.level];
  return (
    <li className={`mk-finding lvl-${f.level}`}>
      <Icon size={14} aria-hidden="true" />
      <div className="grow">
        <div>
          <strong>{f.title}</strong> <span className="muted">{f.detail}</span>
        </div>
        {f.files.length > 0 && (
          <>
            <button className="link-btn small" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Hide" : "Show"} {f.files.length} file(s)
            </button>
            {open && (
              <ul className="mk-finding-files">
                {f.files.map((p) => (
                  <li key={p} className="mono">
                    {p}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </li>
  );
}

export function SecurityStatus({ analysis }: { analysis: MarketAnalysis }) {
  const s = analysis.security.status;
  const Icon = s === "clean" ? ShieldCheck : s === "incomplete" ? ShieldQuestion : ShieldAlert;
  return (
    <Chip tone={securityTone(s)}>
      <Icon size={12} aria-hidden="true" /> {securityLabel(s)}
    </Chip>
  );
}

export function AnalysisView({ analysis, filesTitle = "Files" }: { analysis: MarketAnalysis; filesTitle?: string }) {
  const [allFiles, setAllFiles] = useState(false);
  const sec = analysis.security;
  const files = allFiles ? analysis.files : analysis.files.slice(0, 40);
  return (
    <div className="mk-analysis">
      <div className="row mk-analysis-head">
        <SecurityStatus analysis={analysis} />
        <span className="muted small">
          {sec.inspectedFiles}/{sec.totalFiles} file(s) read · {formatBytes(sec.totalBytes)} · from{" "}
          {analysis.filesSource === "local" ? "the local copy" : "GitHub"} <code className="mk-break">{analysis.location}</code>
          {analysis.reference && (
            <>
              {" "}
              at <code>{analysis.reference.slice(0, 7)}</code>
            </>
          )}
        </span>
      </div>
      <ul className="mk-findings">
        {sec.findings.map((f) => (
          <Finding key={f.code} f={f} />
        ))}
      </ul>
      <div className="muted small">Static inspection by file type and text patterns: it shows what the files can do, it does not prove they are safe.</div>
      <h4 className="mk-subtitle">
        {filesTitle} ({analysis.files.length}
        {analysis.truncated ? "+, list truncated" : ""})
      </h4>
      <ul className="mk-files">
        {files.map((f) => (
          <li key={f.path}>
            <FileText size={12} aria-hidden="true" />
            <span className="mono grow mk-break">{f.path}</span>
            <span className={`small ${f.kind === "script" || f.kind === "binary" ? "tone-amber-fg" : "muted"}`}>{f.kind}</span>
            <span className="muted small mk-size">{formatBytes(f.size)}</span>
          </li>
        ))}
      </ul>
      {analysis.files.length > 40 && (
        <button className="link-btn small" onClick={() => setAllFiles(!allFiles)}>
          {allFiles ? "Show fewer" : `Show all ${analysis.files.length} files`}
        </button>
      )}
    </div>
  );
}
