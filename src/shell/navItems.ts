// Main navigation entries, shared by the nav column and the command bar.

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  Brain,
  BrainCircuit,
  ChartColumn,
  Cable,
  Command,
  Cpu,
  Crown,
  GitPullRequest,
  Globe2,
  GitBranch,
  Grid3x3,
  HeartPulse,
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
import { t, type MessageKey } from "../i18n";

export interface NavItem {
  name: ViewName;
  /** Shown text; items built with `nav()` translate it (key nav.<name>, English fallback). */
  readonly label: string;
  icon: LucideIcon;
}

function nav(name: ViewName, label: string, icon: LucideIcon): NavItem {
  return {
    name,
    icon,
    get label() {
      return t.dynamic(`nav.${name}`, undefined, label);
    },
  };
}

function section(key: MessageKey, items: NavItem[]): { readonly label: string; items: NavItem[] } {
  return {
    items,
    get label() {
      return t(key);
    },
  };
}

/** Groups of the left navigation, in order; `label` is shown above the group when the nav is expanded. */
export const NAV_SECTIONS: { readonly label: string; items: NavItem[] }[] = [
  section("nav.section.project", [
    nav("world", "AI World", Globe2),
    nav("missions", "Missions", Sparkles),
    nav("agents", "Agents", Bot),
    nav("skills", "Skills", WandSparkles),
    nav("market", "Skill Market", Store),
    nav("mcp", "MCP", Plug),
    nav("connections", "Connections", Cable),
    nav("models", "Models", Cpu),
    nav("github", "GitHub", GitPullRequest),
  ]),
  section("nav.section.work", [
    nav("swarm", "Swarm", LayoutGrid),
    nav("tasks", "Tasks", ListChecks),
    nav("terminal", "Terminal", SquareTerminal),
    nav("git", "Git", GitBranch),
    nav("activity", "Activity", Activity),
    nav("memory", "Memory", Brain),
    nav("commands", "Commands", Command),
  ]),
  section("nav.section.system", [
    nav("claude", "Claude", Zap),
    nav("autonomy", "Unlocked", LockOpen),
    nav("master", "Master Control", Crown),
    nav("capabilities", "Capabilities", Grid3x3),
    nav("ai", "AI Engines", BrainCircuit),
    nav("usage", "AI Usage", ChartColumn),
    nav("environment", "Environment", MonitorCog),
    nav("diagnostics", "Diagnostics", HeartPulse),
  ]),
];

export const SETTINGS_ITEM: NavItem = nav("settings", "Settings", Settings);

export const ALL_NAV_ITEMS: NavItem[] = [...NAV_SECTIONS.flatMap((s) => s.items), SETTINGS_ITEM];
