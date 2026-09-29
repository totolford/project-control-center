import type { ComponentType } from "react";
import { useStore } from "../store";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { AgentsPanel } from "./AgentsPanel";
import { CentralBar } from "./CentralBar";
import { Overview } from "../views/Overview";
import { Missions } from "../views/Missions";
import { Agents } from "../views/Agents";
import { AgentDetail } from "../views/AgentDetail";
import { Tasks } from "../views/Tasks";
import { Connections } from "../views/Connections";
import { Memory } from "../views/Memory";
import { Activity } from "../views/Activity";
import { Git } from "../views/Git";
import { Settings } from "../views/Settings";
import type { ViewName } from "../store";

const VIEWS: Record<Exclude<ViewName, "agent">, ComponentType> = {
  overview: Overview,
  missions: Missions,
  agents: Agents,
  tasks: Tasks,
  connections: Connections,
  memory: Memory,
  activity: Activity,
  git: Git,
  settings: Settings,
};

export function MainLayout() {
  const view = useStore((s) => s.view);
  let main;
  if (view.name === "agent") main = view.agentId ? <AgentDetail key={view.agentId} agentId={view.agentId} /> : null;
  else {
    const View = VIEWS[view.name];
    main = <View />;
  }
  return (
    <div className="app">
      <TopBar />
      <Sidebar />
      <main className="main">{main}</main>
      <AgentsPanel />
      <CentralBar />
    </div>
  );
}
