// Main navigation entries, shared by the nav column and the command bar.

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  Brain,
  Cable,
  Command,
  Cpu,
  Crown,
  GitPullRequest,
  Globe2,
  GitBranch,
  Grid3x3,
  LayoutGrid,
  ListChecks,
  LockOpen,
  MonitorCog,
  Plug,
  Settings,
  Sparkles,
  SquareTerminal,
  Store,
  WandSparkles,
  Zap,
} from "lucide-react";
import type { ViewName } from "../store";

export interface NavItem {
  name: ViewName;
  label: string;
  icon: LucideIcon;
}

/** Groups of the left navigation, in order; `label` is shown above the group when the nav is expanded. */
export const NAV_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Project",
    items: [
      { name: "world", label: "AI World", icon: Globe2 },
      { name: "missions", label: "Missions", icon: Sparkles },
      { name: "agents", label: "Agents", icon: Bot },
      { name: "skills", label: "Skills", icon: WandSparkles },
      { name: "market", label: "Skill Market", icon: Store },
      { name: "mcp", label: "MCP", icon: Plug },
      { name: "connections", label: "Connections", icon: Cable },
      { name: "models", label: "Models", icon: Cpu },
      { name: "github", label: "GitHub", icon: GitPullRequest },
    ],
  },
  {
    label: "Work",
    items: [
      { name: "swarm", label: "Swarm", icon: LayoutGrid },
      { name: "tasks", label: "Tasks", icon: ListChecks },
      { name: "terminal", label: "Terminal", icon: SquareTerminal },
      { name: "git", label: "Git", icon: GitBranch },
      { name: "activity", label: "Activity", icon: Activity },
      { name: "memory", label: "Memory", icon: Brain },
      { name: "commands", label: "Commands", icon: Command },
    ],
  },
  {
    label: "System",
    items: [
      { name: "claude", label: "Claude", icon: Zap },
      { name: "autonomy", label: "Unlocked", icon: LockOpen },
      { name: "master", label: "Master Control", icon: Crown },
      { name: "capabilities", label: "Capabilities", icon: Grid3x3 },
      { name: "environment", label: "Environment", icon: MonitorCog },
    ],
  },
];

export const SETTINGS_ITEM: NavItem = { name: "settings", label: "Settings", icon: Settings };

export const ALL_NAV_ITEMS: NavItem[] = [...NAV_SECTIONS.flatMap((s) => s.items), SETTINGS_ITEM];
