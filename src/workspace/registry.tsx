// Panel registry: maps each panel type to its header and body components.
// Adding a panel type = add it to PanelType (layout.ts), panelMeta.ts, and here.

import type { ComponentType } from "react";
import { AgentActivityPanel } from "../panels/AgentActivityPanel";
import { AgentHeader } from "../panels/AgentHeader";
import { AgentTerminal } from "../panels/AgentTerminal";
import { ActivityPanel } from "../panels/ActivityPanel";
import { CentralHeader, CentralPanel } from "../panels/CentralPanel";
import { ConnectionPanel } from "../panels/ConnectionPanel";
import { DiffPanel } from "../panels/DiffPanel";
import { GithubPanelBody } from "../panels/GithubPanelBody";
import { MemoryPanel } from "../panels/MemoryPanel";
import { MissionPanel } from "../panels/MissionPanel";
import { ReviewPanel } from "../panels/ReviewPanel";
import { RobloxStudioPanel } from "../panels/RobloxStudioPanel";
import { SwarmOverview } from "../panels/SwarmOverview";
import { TaskPanel } from "../panels/TaskPanel";
import type { PanelSpec, PanelType } from "./layout";
import { GenericHeader, type PanelHeaderProps } from "./PanelHeader";

export interface PanelBodyProps {
  spec: PanelSpec;
  panelId: string;
}

export interface PanelDef {
  Header: ComponentType<PanelHeaderProps>;
  Body: ComponentType<PanelBodyProps>;
}

export const PANELS: Record<PanelType, PanelDef> = {
  AgentTerminal: { Header: AgentHeader, Body: AgentTerminal },
  AgentActivity: { Header: AgentHeader, Body: AgentActivityPanel },
  CentralAgent: { Header: CentralHeader, Body: CentralPanel },
  RobloxStudio: { Header: GenericHeader, Body: RobloxStudioPanel },
  Connection: { Header: GenericHeader, Body: ConnectionPanel },
  GitHub: { Header: GenericHeader, Body: GithubPanelBody },
  TaskBoard: { Header: GenericHeader, Body: TaskPanel },
  Mission: { Header: GenericHeader, Body: MissionPanel },
  Memory: { Header: GenericHeader, Body: MemoryPanel },
  Diff: { Header: GenericHeader, Body: DiffPanel },
  Review: { Header: GenericHeader, Body: ReviewPanel },
  Activity: { Header: GenericHeader, Body: ActivityPanel },
  SwarmOverview: { Header: GenericHeader, Body: SwarmOverview },
};
