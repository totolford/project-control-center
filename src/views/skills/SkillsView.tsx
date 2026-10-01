import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Check, Plus, RefreshCw, RotateCw, Search, X } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { attempt } from "../../lib/toast";
import { fuzzyFilter } from "../../lib/fuzzy";
import type { Skill } from "../../lib/types";
import { useAgents, useConnections, useStore } from "../../store";
import { EmptyState, Loading, PageHeader, Spinner } from "../../components/Common";
import { Segmented } from "../../components/Tabs";
import { Chip } from "../../components/StatusBadge";
import { useClaudeEnvironment } from "../mcp/useClaudeEnvironment";
import { SKILL_FILTERS, isDiscovered, matchesFilter, missingCount, requirements, sourceLabel, type SkillFilter } from "./skillModel";
import { SkillDetail } from "./SkillDetail";
import { SkillWizard } from "./SkillWizard";

export function SkillsView() {
  const { env, loading: envLoading, refresh: refreshEnv } = useClaudeEnvironment();
  const connections = useConnections();
  const agents = useAgents();
  const toolsVersion = useStore((s) => s.project?.toolsVersion ?? 0);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [reloaded, setReloaded] = useState<string[] | null>(null);
  const [reloading, setReloading] = useState(false);

  const load = useCallback(async (select?: string) => {
    try {
      setSkills(await api.listSkills());
      setLoadError(null);
      if (select) setSelectedDir(select);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  // Reload when skills or plugins change (SkillChanged / McpChanged events).
  useEffect(() => {
    void load();
  }, [load, toolsVersion]);

  const commands = env ? env.commands : null;
  const visible = useMemo(
    () => fuzzyFilter((skills ?? []).filter((s) => matchesFilter(s, filter)), query, (s) => `${s.name} ${s.description} ${s.source ?? ""}`, 500),
    [skills, filter, query],
  );
  const selected = skills?.find((s) => s.dir === selectedDir) ?? null;

  const reloadSessions = async () => {
    setReloading(true);
    const ids = await attempt(() => api.reloadPlugins());
    setReloading(false);
    if (ids) setReloaded(ids.map((id) => agents.find((a) => a.id === id)?.name ?? id));
  };

  return (
    <div className="page page-fill">
      <PageHeader
        title="Skills"
        subtitle="Claude Code skills (SKILL.md folders) of this project, your user account and installed plugins."
        actions={
          <>
            <button className="btn" onClick={() => void reloadSessions()} disabled={reloading} title="Reload plugins and skills in every running agent session">
              {reloading ? <Spinner size={12} /> : <RotateCw size={14} />} Reload in sessions
            </button>
            <button className="btn" onClick={() => void Promise.all([load(), refreshEnv()])} disabled={envLoading} title="Re-read skill folders and Claude Code's command list">
              {envLoading ? <Spinner size={12} /> : <RefreshCw size={14} />} Refresh
            </button>
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> New skill
            </button>
          </>
        }
      />
      {reloaded && (
        <div className="notice">
          {reloaded.length ? `Reload requested in ${reloaded.length} session(s): ${reloaded.join(", ")}.` : "No running agent session: new sessions load skills when they start."}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setReloaded(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="filters">
        <Segmented options={SKILL_FILTERS} value={filter} onChange={setFilter} label="Filter skills" />
        <div className="tools-search">
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills" aria-label="Search skills" />
        </div>
        <span className="muted small">
          Marketplace installs are not exposed here: install plugins from the Command Center (<code>claude plugin install …</code>).
        </span>
      </div>
      {loadError && <div className="notice notice-error">Skills unavailable: {loadError}</div>}
      {!skills && !loadError ? (
        <Loading text="Reading skill folders…" />
      ) : (
        <div className="split">
          <div className="split-list tools-list tools-list-wide">
            {visible.length === 0 && <div className="muted small tools-pad">No skill matches.</div>}
            {visible.map((s) => {
              const discovered = isDiscovered(s, commands);
              const missing = missingCount(requirements(s, connections));
              const issues = s.problems.length + missing;
              return (
                <button key={s.dir} className={`list-item tools-skill${s.dir === selectedDir ? " active" : ""}${s.enabled ? "" : " is-off"}`} onClick={() => setSelectedDir(s.dir)}>
                  <span className="tools-item-main">
                    <span className="row">
                      <strong className="ellipsis">{s.name}</strong>
                      <Chip tone={s.scope === "plugin" ? "blue" : s.scope === "project" ? "accent" : "grey"}>{sourceLabel(s)}</Chip>
                    </span>
                    <span className="muted small tools-clamp">{s.description || "No description"}</span>
                    <span className="small tools-skill-meta">
                      <span className={s.enabled ? "tone-green-fg" : "muted"}>{s.enabled ? "Enabled" : "Disabled"}</span>
                      <span title="Listed by Claude Code (last refresh)">
                        {discovered === null ? (
                          <span className="muted">discovery unknown</span>
                        ) : discovered ? (
                          <>
                            <Check size={12} /> discovered
                          </>
                        ) : (
                          <span className="muted">
                            <X size={12} /> not discovered
                          </span>
                        )}
                      </span>
                      {issues > 0 && <span className="tone-amber-fg">{issues} problem(s)</span>}
                      {s.allowedTools.length > 0 && <span className="muted ellipsis">tools: {s.allowedTools.join(", ")}</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="split-main scroll">
            {selected ? (
              <SkillDetail key={selected.dir} skill={selected} env={env} onChanged={load} />
            ) : (
              <EmptyState icon={<BookOpen size={22} />} title="Select a skill">
                {skills?.length ?? 0} skill(s) found.
              </EmptyState>
            )}
          </div>
        </div>
      )}
      {creating && (
        <SkillWizard
          onClose={() => setCreating(false)}
          onCreated={(dir) => {
            void load(dir);
            void refreshEnv();
          }}
        />
      )}
    </div>
  );
}
