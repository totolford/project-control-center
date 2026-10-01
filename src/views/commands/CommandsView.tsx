import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useClaudeEnv } from "../../state/claude";
import { PageHeader, Spinner } from "../../components/Common";
import { Tabs } from "../../components/Tabs";
import { CliBrowser } from "./CliBrowser";
import { SlashCommands } from "./SlashCommands";

type TabKey = "cli" | "slash";

/** Command Center: the installed Claude Code's CLI and its slash commands & skills. */
export function CommandsView() {
  const { env, loading, refresh } = useClaudeEnv();
  const [tab, setTab] = useState<TabKey>("cli");
  const version = env?.cli.version;
  return (
    <div className="page page-fill">
      <PageHeader
        title="Command Center"
        subtitle={
          <>
            Claude Code <strong className="mono">{version ?? (loading ? "…" : "version unknown")}</strong>
            {env?.cli.path && <span className="muted mono small"> · {env.cli.path}</span>}
          </>
        }
        actions={
          <>
            <Tabs
              tabs={[
                { key: "cli", label: "CLI commands" },
                { key: "slash", label: "Slash commands & skills" },
              ]}
              active={tab}
              onChange={setTab}
            />
            <button className="btn" onClick={refresh} disabled={loading} title="Ask Claude Code again (takes a few seconds)">
              {loading ? <Spinner size={12} /> : <RefreshCw size={13} />} Refresh
            </button>
          </>
        }
      />
      {tab === "cli" ? <CliBrowser exe={env?.cli.path ?? null} /> : <SlashCommands env={env} />}
    </div>
  );
}
