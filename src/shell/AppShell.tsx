import type { ComponentType } from "react";
import { useStore, type ViewName } from "../store";
import { useUi } from "../state/ui";
import { SwarmWorkspace } from "../workspace/SwarmWorkspace";
import { useWorkspaceSync } from "../workspace/useWorkspaceSync";
import { Missions } from "../views/Missions";
import { AgentDetail } from "../views/AgentDetail";
import { Tasks } from "../views/Tasks";
import { Connections } from "../views/Connections";
import { Memory } from "../views/Memory";
import { Activity } from "../views/Activity";
import { Git } from "../views/Git";
import { Settings } from "../views/Settings";
import { NewAgentDialog } from "../views/agent/NewAgentDialog";
import { AddConnectionDialog } from "../views/connections/AddConnectionDialog";
import { TopBar } from "./TopBar";
import { SecondaryBar } from "./SecondaryBar";
import { StatusStrip } from "./StatusStrip";
import { MissionComposer } from "./MissionComposer";
import { MessageFlow } from "./MessageFlow";
import { MessageDetail } from "./MessageDetail";
import { CommandBar } from "./CommandBar";

const VIEWS: Record<Exclude<ViewName, "agent">, ComponentType> = {
  swarm: SwarmWorkspace,
  missions: Missions,
  memory: Memory,
  connections: Connections,
  activity: Activity,
  tasks: Tasks,
  git: Git,
  settings: Settings,
};

function DialogHost() {
  const dialog = useUi((s) => s.dialog);
  const openDialog = useUi((s) => s.openDialog);
  const close = () => openDialog(null);
  if (dialog?.type === "newAgent") return <NewAgentDialog provider={dialog.provider} onClose={close} />;
  if (dialog?.type === "addConnection") return <AddConnectionDialog onClose={close} />;
  return null;
}

/** Main window once a project is open: bars, current view, status strip + composer, overlays. */
export function AppShell({ onCloseProject, onFolder }: { onCloseProject: () => void; onFolder: (path: string) => Promise<void> }) {
  const view = useStore((s) => s.view);
  useWorkspaceSync();
  let main;
  if (view.name === "agent") main = view.agentId ? <AgentDetail key={view.agentId} agentId={view.agentId} /> : null;
  else {
    const View = VIEWS[view.name];
    main = <View />;
  }
  return (
    <div className="shell">
      <TopBar onCloseProject={onCloseProject} onFolder={onFolder} />
      <SecondaryBar />
      <main className={`shell-main${view.name === "swarm" ? " is-swarm" : ""}`}>{main}</main>
      <div className="shell-bottom">
        <StatusStrip />
        <MissionComposer />
      </div>
      <MessageFlow />
      <MessageDetail />
      <CommandBar />
      <DialogHost />
    </div>
  );
}
