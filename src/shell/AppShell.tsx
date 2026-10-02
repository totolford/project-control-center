import type { ComponentType } from "react";
import { useStore, type ViewName } from "../store";
import { useUi } from "../state/ui";
import { SwarmWorkspace } from "../workspace/SwarmWorkspace";
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
import { FolderContext } from "../state/opsActions";
import { NewAgentDialog } from "../views/agent/NewAgentDialog";
import { AddConnectionDialog } from "../views/connections/AddConnectionDialog";
import { TopBar } from "./TopBar";
import { MainNav } from "./MainNav";
import { EmergencyBanner } from "./SafetyControls";
import { StatusStrip } from "./StatusStrip";
import { MissionComposer } from "./MissionComposer";
import { MessageFlow } from "./MessageFlow";
import { MessageDetail } from "./MessageDetail";
import { CommandBar } from "./CommandBar";
import { CompatBanner } from "./CompatBanner";
import { UserRequests } from "./UserRequests";

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
  settings: Settings,
};

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

/** Main window once a project is open: top bar, navigation, current view, status strip + composer, overlays. */
export function AppShell({ onCloseProject, onFolder }: { onCloseProject: () => void; onFolder: (path: string) => Promise<void> }) {
  const view = useStore((s) => s.view);
  useWorkspaceSync();
  useRedock();
  let main;
  if (view.name === "agent") main = view.agentId ? <AgentDetail key={view.agentId} agentId={view.agentId} /> : null;
  else {
    const View = VIEWS[view.name];
    main = <View />;
  }
  return (
    <FolderContext.Provider value={onFolder}>
      <div className="shell">
        <TopBar onCloseProject={onCloseProject} onFolder={onFolder} />
        <div>
          <EmergencyBanner />
          <CompatBanner />
        </div>
        <div className="shell-body">
          <MainNav />
          <main className={`shell-main${FILL_VIEWS.includes(view.name) ? " is-fill" : ""}`}>{main}</main>
        </div>
        <div className="shell-bottom">
          <StatusStrip />
          <MissionComposer />
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
