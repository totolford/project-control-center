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
  WandSparkles,
  Zap,
} from "lucide-react";
import type { ViewName } from "../store";

export interface NavItem {
  name: ViewName;
  label: string;
  icon: LucideIcon;
}

export const NAV_GROUPS: NavItem[][] = [
  [
    { name: "swarm", label: "Swarm", icon: LayoutGrid },
    { name: "missions", label: "Missions", icon: Sparkles },
    { name: "agents", label: "Agents", icon: Bot },
    { name: "models", label: "Models", icon: Cpu },
    { name: "mcp", label: "MCP", icon: Plug },
    { name: "skills", label: "Skills", icon: WandSparkles },
    { name: "connections", label: "Connections", icon: Cable },
    { name: "commands", label: "Commands", icon: Command },
    { name: "memory", label: "Memory", icon: Brain },
    { name: "activity", label: "Activity", icon: Activity },
    { name: "environment", label: "Environment", icon: MonitorCog },
    { name: "world", label: "AI World", icon: Globe2 },
  ],
  [
    { name: "claude", label: "Claude", icon: Zap },
    { name: "autonomy", label: "Unlocked", icon: LockOpen },
    { name: "master", label: "Master Control", icon: Crown },
    { name: "capabilities", label: "Capabilities", icon: Grid3x3 },
    { name: "terminal", label: "Terminal", icon: SquareTerminal },
  ],
  [
    { name: "tasks", label: "Tasks", icon: ListChecks },
    { name: "git", label: "Git", icon: GitBranch },
    { name: "github", label: "GitHub", icon: GitPullRequest },
  ],
];

export const SETTINGS_ITEM: NavItem = { name: "settings", label: "Settings", icon: Settings };

export const ALL_NAV_ITEMS: NavItem[] = [...NAV_GROUPS.flat(), SETTINGS_ITEM];
