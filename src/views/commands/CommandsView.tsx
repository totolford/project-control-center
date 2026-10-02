import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useClaudeEnv } from "../../state/claude";
import { useStore } from "../../store";
import { PageHeader, Spinner } from "../../components/Common";
import { Tabs } from "../../components/Tabs";
import { CliBrowser } from "./CliBrowser";
import { SlashCommands } from "./SlashCommands";
import { CommandJournal } from "./CommandJournal";

type TabKey = "cli" | "slash" | "journal";

/** Command Center: the installed Claude Code's CLI, its slash commands & skills, and the journal of commands run. */
export function CommandsView() {
  const { env, loading, refresh } = useClaudeEnv();
  const section = useStore((s) => s.view.section);
  const [tab, setTab] = useState<TabKey>(section === "journal" ? "journal" : "cli");
  useEffect(() => {
    if (section === "journal") setTab("journal");
  }, [section]);
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
                { key: "journal", label: "Command journal" },
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
      {tab === "cli" ? <CliBrowser exe={env?.cli.path ?? null} /> : tab === "slash" ? <SlashCommands env={env} /> : <CommandJournal />}
    </div>
  );
}
