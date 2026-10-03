import { useState } from "react";
import { AlertTriangle, Check, FileText, HelpCircle, X } from "lucide-react";
import type { ClaudeEnvironment, Skill } from "../../lib/types";
import { useAgents, useConnections } from "../../store";
import { Section } from "../../components/Common";
import { Chip } from "../../components/StatusBadge";
import { agentsWithSkills, isDiscovered, isSynced, requirements, sourceLabel, type Requirement } from "./skillModel";
import { SkillActions } from "./SkillActions";
import { SkillFileViewer } from "./SkillFileViewer";
import { SKILL_LIMITATION_TEXT, SKILL_SCOPE_TEXT } from "../market/marketModel";

function Req({ items, unknownHint = "" }: { items: Requirement[]; unknownHint?: string }) {
  if (items.length === 0) return <span className="muted">none</span>;
  return (
    <span className="chips-row">
      {items.map((r) => (
        <span key={r.value} className={`tools-req ${r.met === true ? "tone-green-fg" : r.met === false ? "tone-red-fg" : "muted"}`} title={r.met === null ? unknownHint : r.met ? "Available in this project" : "Missing in this project"}>
          {r.met === true ? <Check size={12} /> : r.met === false ? <X size={12} /> : <HelpCircle size={12} />} {r.value}
        </span>
      ))}
    </span>
  );
}

interface Props {
  skill: Skill;
  env: ClaudeEnvironment | null;
  /** Reload the skill list, optionally selecting another folder. */
  onChanged: (selectDir?: string) => Promise<void>;
}

export function SkillDetail({ skill, env, onChanged }: Props) {
  const connections = useConnections();
  const agents = useAgents();
  const [file, setFile] = useState<string | null>(null);
  const req = requirements(skill, connections);
  const discovered = isDiscovered(skill, env ? env.commands : null);
  const withSkills = agentsWithSkills(agents);
  const fm = Object.entries(skill.frontmatter);

  return (
    <div className="tools-detail">
      <div className="tools-detail-head">
        <div className="grow">
          <div className="row">
            <h2>{skill.name}</h2>
            <Chip tone={skill.enabled ? "green" : "dim"}>{skill.enabled ? "Enabled" : "Disabled"}</Chip>
            <Chip tone={skill.scope === "plugin" ? "blue" : skill.scope === "project" ? "accent" : "grey"}>{sourceLabel(skill)}</Chip>
            {!skill.editable && <span className="muted small">read-only{isSynced(skill) ? ": managed by claude.ai" : ""}</span>}
          </div>
          <div className="tools-desc">{skill.description || <span className="muted">No description</span>}</div>
        </div>
      </div>

      <SkillActions skill={skill} env={env} onChanged={onChanged} />

      {skill.problems.length > 0 && (
        <div className="notice notice-warn tools-problems">
          <AlertTriangle size={14} />
          <ul>
            {skill.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <Section title="Overview">
        <dl className="kv">
          <dt>Folder</dt>
          <dd className="mono">{skill.dir}</dd>
          <dt>Source</dt>
          <dd>{skill.scope === "plugin" ? `Plugin ${skill.source ?? "(unknown id)"}` : isSynced(skill) ? "Synced from claude.ai (user skills)" : skill.scope === "project" ? "Project (.claude/skills)" : "User (~/.claude/skills)"}</dd>
          <dt>Discovered</dt>
          <dd>
            {discovered === null
              ? "Unknown: Claude Code's command list is unavailable"
              : discovered
                ? "Yes, Claude Code lists it"
                : skill.enabled
                  ? "No, Claude Code does not list it (run Test for details)"
                  : "No (disabled)"}
          </dd>
          <dt>Allowed tools</dt>
          <dd>{skill.allowedTools.length ? skill.allowedTools.map((t) => <code key={t}>{t}</code>) : <span className="muted">not restricted</span>}</dd>
        </dl>
      </Section>

      <Section title="Requirements">
        <dl className="kv">
          <dt>MCP servers</dt>
          <dd>
            <Req items={req.mcp} />
          </dd>
          <dt>Connections</dt>
          <dd>
            <Req items={req.connections} />
          </dd>
          <dt>Permissions</dt>
          <dd>
            <Req items={req.permissions} unknownHint="Not a NEXUS capability: cannot be checked" />
          </dd>
          <dt>Dependencies</dt>
          <dd>{req.dependencies.length ? req.dependencies.map((d) => <code key={d}>{d}</code>) : <span className="muted">none</span>}</dd>
        </dl>
        <div className="muted small">Read from metadata.requires-* in the frontmatter; MCP servers and connections are compared with this project's connections.</div>
      </Section>

      <Section title="Agents that can use it">
        {withSkills.length ? (
          <div className="chips-row">
            {withSkills.map((a) => (
              <span key={a.id} className="chip tone-grey">
                {a.name}
              </span>
            ))}
          </div>
        ) : (
          <div className="muted small">No agent has skills enabled.</div>
        )}
        <div className="small">{SKILL_SCOPE_TEXT}</div>
        <div className="muted small">
          {SKILL_LIMITATION_TEXT} Agents with skills enabled in their profile load every enabled skill Claude Code discovers.
        </div>
      </Section>

      <Section title={`Files (${skill.files.length})`}>
        <ul className="tools-files">
          {skill.files.map((f) => (
            <li key={f}>
              <button className="link-btn" onClick={() => setFile(f)}>
                <FileText size={13} /> {f}
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Frontmatter">
        {fm.length ? (
          <table className="table tools-table">
            <tbody>
              {fm.map(([k, v]) => (
                <tr key={k}>
                  <td className="mono muted">{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted small">No frontmatter.</div>
        )}
      </Section>

      {file && <SkillFileViewer dir={skill.dir} file={file} onClose={() => setFile(null)} />}
    </div>
  );
}
