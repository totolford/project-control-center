// Icon and title of each panel type (no components, so menus can list panels cheaply).

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Cable,
  CheckCheck,
  Gamepad2,
  GitCompare,
  GitPullRequest,
  Globe2,
  LayoutGrid,
  ListChecks,
  Brain,
  Sparkles,
  SquareTerminal,
  Target,
  Terminal,
  Waves,
} from "lucide-react";
import { useT, type MessageKey } from "../i18n";
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
  RawTerminal: Terminal,
  AiWorld: Globe2,
};

const STATIC_TITLE: Partial<Record<PanelType, MessageKey>> = {
  CentralAgent: "ws.title.CentralAgent",
  RobloxStudio: "ws.title.RobloxStudio",
  GitHub: "ws.title.GitHub",
  TaskBoard: "nav.tasks",
  Memory: "nav.memory",
  Review: "panel.col.review",
  Activity: "nav.activity",
  SwarmOverview: "ws.title.SwarmOverview",
  RawTerminal: "ws.title.RawTerminal",
  AiWorld: "ws.title.AiWorld",
};

/** Human title of a panel, resolved against current project data, in the interface language. */
export function usePanelTitle(spec: PanelSpec): string {
  const t = useT();
  const title = useStore((s) => {
    const p = s.project;
    const agent = spec.agentId ? (p?.agents.find((a) => a.id === spec.agentId)?.name ?? spec.agentId) : "";
    switch (spec.type) {
      case "AgentTerminal":
        return agent;
      case "AgentActivity":
        return `\u0000activity\u0000${agent}`;
      case "Diff":
        return `\u0000diff\u0000${agent}`;
      case "Connection":
        return p?.connections.find((c) => c.id === spec.connectionId)?.name ?? "\u0000Connection";
      case "Mission":
        return spec.missionId ? (p?.missions.find((m) => m.id === spec.missionId)?.title ?? "\u0000Mission") : "\u0000activeMission";
      default:
        return `\u0000${spec.type}`;
    }
  });
  // Project data is selected above; fixed words are translated here (markers start with \0).
  if (!title.startsWith("\u0000")) return title;
  const [, kind, name] = title.split("\u0000");
  if (kind === "activity") return t("ws.item.activity", { name });
  if (kind === "diff") return t("ws.item.diff", { name });
  if (kind === "Connection") return t("ws.title.Connection");
  if (kind === "Mission") return t("ws.title.Mission");
  if (kind === "activeMission") return t("ws.title.activeMission");
  const key = STATIC_TITLE[kind as PanelType];
  return key ? t(key) : kind;
}
