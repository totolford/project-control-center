import { RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import { useLoad } from "../../lib/useLoad";
import { useClaudeEnv, useSkills } from "../../state/claude";
import { useProviders } from "../../workspace/hooks";
import { Loading, PageHeader, Section, Spinner } from "../../components/Common";
import { DetectionList, ProjectSection, SystemSection } from "./EnvSections";

function AiSection() {
  const { env, loading } = useClaudeEnv();
  const providers = useProviders();
  const { skills } = useSkills();
  const cli = env?.cli;
  return (
    <Section title="AI">
      <dl className="kv">
        <dt>Claude Code</dt>
        <dd>
          {!env ? (loading ? "detecting…" : "Unavailable") : cli?.installed ? `${cli.version ?? "version unknown"} · ${cli.loggedIn ? "logged in" : cli.loggedIn === false ? "not logged in" : "login unknown"}` : "not installed"}
        </dd>
        <dt>MCP servers (Claude Code)</dt>
        <dd>{env ? env.mcpServers.length : "—"}</dd>
        <dt>Skills</dt>
        <dd>{skills ? `${skills.length} (${skills.filter((s) => s.enabled).length} enabled)` : "—"}</dd>
        <dt>Plugins</dt>
        <dd>{env ? env.plugins.length : "—"}</dd>
      </dl>
      <div className="section-label">Agent providers</div>
      {providers === null ? (
        <Loading text="Detecting…" />
      ) : (
        <ul className="detect-list">
          {providers.map((p) => (
            <li key={p.id}>
              <span className={p.available ? "tone-green-fg" : p.installed ? "tone-amber-fg" : "muted"}>{p.available ? "✓" : p.installed ? "~" : "✗"}</span>
              <span>{p.name}</span>
              <span className="muted tiny ellipsis" title={p.detail}>
                {p.available ? "available" : p.installed ? "installed, no adapter" : "not installed"} · {p.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Environment Inspector: this machine, its development tools, AI runtimes and the project. */
export function EnvironmentView() {
  const system = useLoad(() => api.systemReport());
  const tools = useLoad(() => api.environment());
  const insights = useLoad(() => api.projectInsights());
  const loading = system.loading || tools.loading || insights.loading;
  const reload = () => {
    void system.reload();
    void tools.reload();
    void insights.reload();
  };
  return (
    <div className="page">
      <PageHeader
        title="Environment"
        subtitle="Detected on this machine and in this project."
        actions={
          <button className="btn" onClick={reload} disabled={loading}>
            {loading ? <Spinner size={12} /> : <RefreshCw size={13} />} Re-scan
          </button>
        }
      />
      <div className="grid-2">
        <SystemSection report={system.data} loading={system.loading} error={system.error} />
        <Section title="Development">
          {tools.data ? <DetectionList items={tools.data.tools} /> : tools.error ? <div className="notice notice-error small">Unavailable: {tools.error}</div> : <Loading />}
        </Section>
      </div>
      <div className="grid-2">
        <AiSection />
        <ProjectSection insights={insights.data} loading={insights.loading} error={insights.error} />
      </div>
    </div>
  );
}
