import type { LucideIcon } from "lucide-react";
import { Activity, Bot, Brain, Cable, GitBranch, LayoutDashboard, ListChecks, Settings, Target } from "lucide-react";
import { useMissions, useStore, useTasks, type ViewName } from "../store";

const ITEMS: { name: ViewName; label: string; icon: LucideIcon }[] = [
  { name: "overview", label: "Overview", icon: LayoutDashboard },
  { name: "missions", label: "Missions", icon: Target },
  { name: "agents", label: "Agents", icon: Bot },
  { name: "tasks", label: "Tasks", icon: ListChecks },
  { name: "connections", label: "Connections", icon: Cable },
  { name: "memory", label: "Memory", icon: Brain },
  { name: "activity", label: "Activity", icon: Activity },
  { name: "git", label: "Git", icon: GitBranch },
  { name: "settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const current = useStore((s) => s.view.name);
  const navigate = useStore((s) => s.navigate);
  const tasks = useTasks();
  const missions = useMissions();
  const badges: Partial<Record<ViewName, number>> = {
    missions: missions.filter((m) => m.status === "active" || m.status === "planning").length,
    tasks: tasks.filter((t) => t.status === "review").length,
  };
  return (
    <nav className="sidebar" aria-label="Main">
      {ITEMS.map(({ name, label, icon: Icon }) => {
        const active = current === name || (name === "agents" && current === "agent");
        const badge = badges[name];
        return (
          <button
            key={name}
            className={`nav-item${active ? " active" : ""}`}
            onClick={() => navigate({ name })}
            aria-current={active ? "page" : undefined}
          >
            <Icon size={15} />
            <span>{label}</span>
            {badge ? (
              <span className="nav-badge" title={name === "tasks" ? "Tasks awaiting review" : "Active missions"}>
                {badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
