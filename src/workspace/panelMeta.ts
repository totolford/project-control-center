// Icon and title of each panel type (no components, so menus can list panels cheaply).

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Cable,
  CheckCheck,
  Gamepad2,
  GitCompare,
  GitPullRequest,
  LayoutGrid,
  ListChecks,
  Brain,
  Sparkles,
  SquareTerminal,
  Target,
  Waves,
} from "lucide-react";
import { useStore } from "../store";
import type { PanelSpec, PanelType } from "./layout";

export const PANEL_ICON: Record<PanelType, LucideIcon> = {
  AgentTerminal: SquareTerminal,
  AgentActivity: Waves,
  CentralAgent: Sparkles,
  RobloxStudio: Gamepad2,
  Connection: Cable,
  GitHub: GitPullRequest,
  TaskBoard: ListChecks,
  Mission: Target,
  Memory: Brain,
  Diff: GitCompare,
  Review: CheckCheck,
  Activity: Activity,
  SwarmOverview: LayoutGrid,
};

const STATIC_TITLE: Partial<Record<PanelType, string>> = {
  CentralAgent: "Central agent",
  RobloxStudio: "Roblox Studio",
  GitHub: "GitHub",
  TaskBoard: "Tasks",
  Memory: "Memory",
  Review: "Review",
  Activity: "Activity",
  SwarmOverview: "Swarm overview",
};

/** Human title of a panel, resolved against current project data. */
export function usePanelTitle(spec: PanelSpec): string {
  return useStore((s) => {
    const p = s.project;
    const agent = spec.agentId ? p?.agents.find((a) => a.id === spec.agentId)?.name ?? spec.agentId : "";
    switch (spec.type) {
      case "AgentTerminal":
        return agent;
      case "AgentActivity":
        return `${agent} · activity`;
      case "Diff":
        return `${agent} · diff`;
      case "Connection":
        return p?.connections.find((c) => c.id === spec.connectionId)?.name ?? "Connection";
      case "Mission":
        return spec.missionId ? (p?.missions.find((m) => m.id === spec.missionId)?.title ?? "Mission") : "Active mission";
      default:
        return STATIC_TITLE[spec.type] ?? spec.type;
    }
  });
}
