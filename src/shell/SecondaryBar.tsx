import type { LucideIcon } from "lucide-react";
import { Activity, Brain, Cable, GitBranch, LayoutGrid, ListChecks, Settings, Sparkles } from "lucide-react";
import { useStore, useTasks, type ViewName } from "../store";
import { AddAgentMenu } from "./AddAgentMenu";

const PRIMARY: { name: ViewName; label: string; icon: LucideIcon }[] = [
  { name: "swarm", label: "Swarm", icon: LayoutGrid },
  { name: "missions", label: "Missions", icon: Sparkles },
  { name: "memory", label: "Memory", icon: Brain },
  { name: "connections", label: "Connections", icon: Cable },
  { name: "activity", label: "Activity", icon: Activity },
];

const SECONDARY: { name: ViewName; label: string; icon: LucideIcon }[] = [
  { name: "tasks", label: "Tasks", icon: ListChecks },
  { name: "git", label: "Git", icon: GitBranch },
  { name: "settings", label: "Settings", icon: Settings },
];

export function SecondaryBar() {
  const current = useStore((s) => s.view.name);
  const navigate = useStore((s) => s.navigate);
  const review = useTasks().filter((t) => t.status === "review").length;
  return (
    <nav className="subbar" aria-label="Views">
      {PRIMARY.map(({ name, label, icon: Icon }) => {
        const active = current === name || (name === "swarm" && current === "agent");
        return (
          <button key={name} className={`subbar-item${active ? " active" : ""}`} onClick={() => navigate({ name })} aria-current={active ? "page" : undefined} title={label}>
            <Icon size={14} />
            <span className="subbar-label">{label}</span>
          </button>
        );
      })}
      {(current === "swarm" || current === "agent") && (
        <>
          <span className="subbar-sep" />
          <AddAgentMenu />
        </>
      )}
      <span className="spacer" />
      {SECONDARY.map(({ name, label, icon: Icon }) => (
        <button
          key={name}
          className={`icon-btn subbar-icon${current === name ? " active" : ""}`}
          onClick={() => navigate({ name })}
          title={name === "tasks" && review > 0 ? `${label} (${review} to review)` : label}
          aria-label={label}
        >
          <Icon size={14} />
          {name === "tasks" && review > 0 && <span className="subbar-badge">{review}</span>}
        </button>
      ))}
    </nav>
  );
}
