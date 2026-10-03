// Right-panel view of one skill (contract: src/state/context.ts, kind "skill"):
// an installed skill (`skillId` = Skill.id) and/or its market entry (`marketId`).

import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BadgeCheck, BookOpen, ExternalLink, Store } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { run } from "../../lib/toast";
import type { MarketDetails, MarketEntry, Skill } from "../../lib/types";
import { useStore } from "../../store";
import { Loading } from "../../components/Common";
import { Chip } from "../../components/StatusBadge";
import { AnalysisView, SecurityStatus } from "./AnalysisView";
import { MarketActions } from "./MarketActions";
import { methodLabel, OFFICIAL_LABEL, originLabel, signalText, SKILL_LIMITATION_TEXT, SKILL_SCOPE_TEXT } from "./marketModel";
import { useMarket } from "./marketStore";
import "./market.css";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

const none = <span className="muted">none declared</span>;
const unknown = <span className="muted">unknown</span>;

function list(items: string[]) {
  return items.length ? items.map((i) => <code key={i}>{i}</code>) : none;
}

function ScopeNote() {
  return (
    <div className="mk-scope-note small">
      <div>{SKILL_SCOPE_TEXT}</div>
      <div className="muted">{SKILL_LIMITATION_TEXT} Agents load all enabled skills or none (agent profile: skills on/off).</div>
    </div>
  );
}

function EntryDetails({ entry }: { entry: MarketEntry }) {
  const [details, setDetails] = useState<MarketDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toolsVersion = useStore((s) => s.project?.toolsVersion ?? 0);

  useEffect(() => {
    let live = true;
    setDetails(null);
    setError(null);
    api.marketDetails(entry.id).then(
      (d) => live && setDetails(d),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [entry.id, entry.installed, entry.enabled, toolsVersion]);

  const a = details?.analysis ?? null;
  const tools = [...new Set([...(a?.security.allowedTools ?? []), ...entry.permissions])];
  const mcp = [...new Set([...entry.requiredMcp, ...(a?.security.requiredMcp ?? [])])];
  const deps = [...new Set([...entry.dependencies, ...(a?.security.dependencies ?? [])])];
  const signal = signalText(entry.signal);

  return (
    <div className="mk-panel">
      <div className="mk-panel-head">
        <h2>{entry.name}</h2>
        <div className="mk-card-badges">
          {entry.official ? (
            <Chip tone="accent">
              <BadgeCheck size={11} aria-hidden="true" /> {OFFICIAL_LABEL}
            </Chip>
          ) : (
            <Chip tone="dim">{originLabel(entry)}</Chip>
          )}
          {entry.installed ? <Chip tone={entry.enabled === false ? "grey" : "green"}>{entry.enabled === false ? "Installed, disabled" : "Installed, enabled"}</Chip> : <Chip tone="grey">Not installed</Chip>}
          {signal && <span className="mk-signal" title={entry.signal!.label}>{signal}</span>}
        </div>
        <p className="mk-panel-desc">{entry.description || <span className="muted">No description</span>}</p>
      </div>

      <MarketActions entry={entry} />

      <dl className="kv mk-kv">
        <Row label="Author">{entry.author ?? unknown}</Row>
        <Row label="Repository">
          {entry.repository ? (
            <button className="link-btn mk-break" onClick={() => void run(() => openUrl(entry.homepage ?? `https://github.com/${entry.repository}`))}>
              {entry.repository}
              {entry.path ? `/${entry.path}` : ""} <ExternalLink size={11} aria-hidden="true" />
            </button>
          ) : (
            unknown
          )}
        </Row>
        <Row label="Version">
          {entry.installedVersion && entry.version && entry.installedVersion !== entry.version
            ? `${entry.installedVersion} installed, ${entry.version} available`
            : (entry.installedVersion ?? entry.version ?? <span className="muted">not published</span>)}
        </Row>
        <Row label="License">{entry.license ?? unknown}</Row>
        <Row label="Last update">{entry.lastUpdated ? entry.lastUpdated.slice(0, 10) : unknown}</Row>
        <Row label="Kind">{methodLabel(entry)}</Row>
        <Row label="Sources">{entry.sources.map((s) => s.label).join(", ")}</Row>
        <Row label="Discovery">{entry.discovery === "installed" ? "Installed (known origin)" : entry.discovery === "discovered" ? "Discovered (on disk, origin unknown)" : "Not on this machine"}</Row>
        {entry.installedScope && <Row label="Installed for">{entry.installedScope}</Row>}
        <Row label="Compatibility">{entry.compatibility || unknown}</Row>
        <Row label="Dependencies">{list(deps)}</Row>
        <Row label="Required MCP">{list(mcp)}</Row>
        <Row label="Required tools">{tools.length ? list(tools) : <span className="muted">not restricted (allowed-tools not set)</span>}</Row>
        <Row label="Security">{a ? <SecurityStatus analysis={a} /> : details ? <span className="muted">not analyzed: {details.analysisError}</span> : unknown}</Row>
        {details?.updateAvailable !== null && details?.updateAvailable !== undefined && (
          <Row label="Updates">{details.updateAvailable ? <span className="tone-amber-fg">A newer commit changes this skill</span> : "Up to date"}</Row>
        )}
      </dl>

      <ScopeNote />

      {entry.skills.length > 0 && (
        <>
          <h4 className="mk-subtitle">Skills ({entry.skills.length})</h4>
          <ul className="mk-skill-list">
            {entry.skills.map((s) => (
              <li key={`${s.name}:${s.path}`}>
                <strong>{s.name}</strong> {s.description && <span className="muted small">{s.description}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4 className="mk-subtitle">{entry.installed ? "Files" : "Files to be installed"}</h4>
      {error && <div className="notice notice-error">{error}</div>}
      {!details && !error && <Loading text="Reading and analyzing the files…" />}
      {details && !a && <div className="notice notice-warn">Files could not be inspected: {details.analysisError}</div>}
      {a && <AnalysisView analysis={a} filesTitle={entry.installed ? "Files" : "Files to be installed"} />}
    </div>
  );
}

function InstalledSkill({ skill, entry }: { skill: Skill; entry: MarketEntry | null }) {
  const navigate = useStore((s) => s.navigate);
  return (
    <div className="mk-panel">
      <div className="mk-panel-head">
        <h2>{skill.name}</h2>
        <div className="mk-card-badges">
          <Chip tone={skill.enabled ? "green" : "grey"}>{skill.enabled ? "Enabled" : "Disabled"}</Chip>
          <Chip tone="blue">{skill.scope === "plugin" ? `Plugin ${skill.source ?? ""}` : skill.source === "synced" ? "Synced (claude.ai)" : skill.scope === "project" ? "Project" : "Global"}</Chip>
        </div>
        <p className="mk-panel-desc">{skill.description || <span className="muted">No description</span>}</p>
      </div>
      <div className="tools-actions">
        <button className="btn" onClick={() => navigate({ name: "skills" })}>
          <BookOpen size={14} /> Open in Skills
        </button>
        {!entry && (
          <button className="btn" onClick={() => navigate({ name: "market" })}>
            <Store size={14} /> Skill Market
          </button>
        )}
      </div>
      <dl className="kv mk-kv">
        <Row label="Folder">
          <span className="mono mk-break">{skill.dir}</span>
        </Row>
        <Row label="Allowed tools">{skill.allowedTools.length ? list(skill.allowedTools) : <span className="muted">not restricted</span>}</Row>
        <Row label="Files">{skill.files.length}</Row>
      </dl>
      <ScopeNote />
      {entry && (
        <>
          <h4 className="mk-subtitle">From the Skill Market</h4>
          <EntryDetails entry={entry} />
        </>
      )}
    </div>
  );
}

export function SkillPanel({ skillId, marketId }: { skillId?: string; marketId?: string }) {
  const { index, load, error } = useMarket();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);

  useEffect(() => {
    if (!index) void load();
  }, [index, load]);
  useEffect(() => {
    if (!skillId) return;
    api.listSkills().then(setSkills, (e) => setSkillsError(errorMessage(e)));
  }, [skillId]);

  const entry = index?.entries.find((e) => (marketId ? e.id === marketId : skillId ? e.installedSkillIds.includes(skillId) : false)) ?? null;

  if (skillId) {
    if (skillsError) return <div className="notice notice-error">Skills unavailable: {skillsError}</div>;
    if (!skills) return <Loading text="Reading skills…" />;
    const skill = skills.find((s) => s.id === skillId);
    if (!skill) return <div className="notice notice-warn">This skill is no longer on disk.</div>;
    return <InstalledSkill skill={skill} entry={entry} />;
  }
  if (error) return <div className="notice notice-error">Market unavailable: {error}</div>;
  if (!index) return <Loading text="Reading the market…" />;
  if (!entry) return <div className="notice notice-warn">This market entry is no longer listed (refresh the market).</div>;
  return <EntryDetails key={entry.id} entry={entry} />;
}
