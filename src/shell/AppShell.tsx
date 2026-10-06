import type { ComponentType } from "react";
import { useStore, type ViewName } from "../store";
import { useUi } from "../state/ui";
import { useRightContext } from "../state/context";
import { SwarmTools, SwarmWorkspace } from "../workspace/SwarmWorkspace";
import { WorkspaceTabs } from "../workspace/WorkspaceTabs";
import { useCenterSync } from "../workspace/useCenterSync";
import { useWorkspaceSync } from "../workspace/useWorkspaceSync";
import { useRedock } from "../workspace/detachWindow";
import { Missions } from "../views/Missions";
import { AgentDetail } from "../views/AgentDetail";
import { AgentsView } from "../views/agents/AgentsView";
import { ModelsView } from "../views/models/ModelsView";
import { McpView } from "../views/mcp/McpView";
import { SkillsView } from "../views/skills/SkillsView";
import { Tasks } from "../views/Tasks";
import { Connections } from "../views/Connections";
import { CommandsView } from "../views/commands/CommandsView";
import { Memory } from "../views/Memory";
import { Activity } from "../views/Activity";
import { EnvironmentView } from "../views/environment/EnvironmentView";
import { ClaudeOverview } from "../views/claude/ClaudeOverview";
import { AutonomyView } from "../views/autonomy/AutonomyView";
import { Capabilities } from "../views/Capabilities";
import { RawTerminalView } from "../terminal/RawTerminalView";
import { Git } from "../views/Git";
import { Settings } from "../views/Settings";
import { GithubView } from "../views/github/GithubView";
import { MasterControlView } from "../views/master/MasterControlView";
import { AiWorldView } from "../views/world";
import { MarketView } from "../views/market/MarketView";
import { DiagnosticsView } from "../views/diagnostics/DiagnosticsView";
import { AiEnginesView } from "../views/ai/AiEnginesView";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { FolderContext } from "../state/opsActions";
import { NewAgentDialog } from "../views/agent/NewAgentDialog";
import { AddConnectionDialog } from "../views/connections/AddConnectionDialog";
import { TopBar } from "./TopBar";
import { MainNav } from "./MainNav";
import { EmergencyBanner } from "./SafetyControls";
import { MessageFlow } from "./MessageFlow";
import { MessageDetail } from "./MessageDetail";
import { CommandBar } from "./CommandBar";
import { CompatBanner } from "./CompatBanner";
import { UserRequests } from "./UserRequests";
import { RightPanel } from "./RightPanel";
import { UniversalBar } from "./UniversalBar";
import { ALL_NAV_ITEMS } from "./navItems";
import "../styles/shell-03.css";

const VIEWS: Record<Exclude<ViewName, "agent">, ComponentType> = {
  swarm: SwarmWorkspace,
  missions: Missions,
  agents: AgentsView,
  models: ModelsView,
  mcp: McpView,
  skills: SkillsView,
  connections: Connections,
  commands: CommandsView,
  memory: Memory,
  activity: Activity,
  environment: EnvironmentView,
  claude: ClaudeOverview,
  autonomy: AutonomyView,
  capabilities: Capabilities,
  terminal: RawTerminalView,
  tasks: Tasks,
  git: Git,
  github: GithubView,
  master: MasterControlView,
  world: AiWorldView,
  market: MarketView,
  diagnostics: DiagnosticsView,
  ai: AiEnginesView,
  settings: Settings,
};

function viewLabel(name: ViewName): string {
  return name === "agent" ? "Agent" : (ALL_NAV_ITEMS.find((i) => i.name === name)?.label ?? name);
}

/** Views that manage their own scrolling (tiling, terminals). */
const FILL_VIEWS: ViewName[] = ["swarm", "terminal", "world"];

function DialogHost() {
  const dialog = useUi((s) => s.dialog);
  const openDialog = useUi((s) => s.openDialog);
  const close = () => openDialog(null);
  if (dialog?.type === "newAgent") return <NewAgentDialog provider={dialog.provider} onClose={close} />;
  if (dialog?.type === "addConnection") return <AddConnectionDialog onClose={close} />;
  return null;
}

/**
 * Main window once a project is open: top bar, navigation (left), the center window with its tabs,
 * the Central agent chat or selected context (right), the universal command bar (bottom), overlays.
 */
export function AppShell({ onCloseProject, onFolder }: { onCloseProject: () => void; onFolder: (path: string) => Promise<void> }) {
  const view = useStore((s) => s.view);
  const rightOpen = useRightContext((s) => s.rightOpen);
  const rightWidth = useRightContext((s) => s.rightWidth);
  useWorkspaceSync();
  useCenterSync();
  useRedock();
  let main;
  if (view.name === "agent") main = view.agentId ? <AgentDetail key={view.agentId} agentId={view.agentId} /> : null;
  else {
    const View = VIEWS[view.name];
    main = <View />;
  }
  return (
    <FolderContext.Provider value={onFolder}>
      <div className={`shell${rightOpen ? " has-right" : ""}`} style={{ "--right-w": `${rightOpen ? rightWidth : 0}px` } as React.CSSProperties}>
        <TopBar onCloseProject={onCloseProject} onFolder={onFolder} />
        <div>
          <EmergencyBanner />
          <CompatBanner />
        </div>
        <div className="shell-body">
          <MainNav />
          <div className="shell-center">
            <WorkspaceTabs>{view.name === "swarm" && <SwarmTools />}</WorkspaceTabs>
            <main className={`shell-main${FILL_VIEWS.includes(view.name) ? " is-fill" : ""}`}>
              <ErrorBoundary label={`${viewLabel(view.name)} view`} resetKey={`${view.name}:${view.agentId ?? ""}`}>
                {main}
              </ErrorBoundary>
            </main>
          </div>
          <ErrorBoundary label="Right panel" compact>
            <RightPanel />
          </ErrorBoundary>
        </div>
        <div className="shell-bottom">
          <ErrorBoundary label="Command bar" compact>
            <UniversalBar />
          </ErrorBoundary>
        </div>
        <MessageFlow />
        <MessageDetail />
        <CommandBar />
        <DialogHost />
        <UserRequests />
      </div>
    </FolderContext.Provider>
  );
}
