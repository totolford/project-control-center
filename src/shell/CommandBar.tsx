import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Bot, Cable, CornerDownLeft, FlaskConical, ListChecks, OctagonX, PanelRightOpen, Plus, RefreshCw, RotateCcw, Siren, Sparkles, Target } from "lucide-react";
import { api } from "../lib/api";
import { run } from "../lib/toast";
import { fuzzyFilter } from "../lib/fuzzy";
import { useUi } from "../state/ui";
import { useStore } from "../store";
import { useClaude } from "../state/claude";
import { ALL_NAV_ITEMS } from "./navItems";
import { availableProviderId, useLayoutContext, useProviders } from "../workspace/hooks";
import { confirmResetLayout } from "../workspace/store";

interface Command {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  run: () => void;
}

function focusComposer() {
  document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
}

function buildCommands(ctx: ReturnType<typeof useLayoutContext>): Command[] {
  const s = useStore.getState();
  const ui = useUi.getState();
  const p = s.project;
  const provider = availableProviderId();
  if (!p) return [];
  return [
    { id: "cmd:mission", label: "Start mission…", group: "Command", icon: Sparkles, run: focusComposer },
    ...(provider ? [{ id: "cmd:agent", label: "Add agent…", group: "Command", icon: Plus, run: () => ui.openDialog({ type: "newAgent", provider }) }] : []),
    { id: "cmd:conn", label: "Add connection…", group: "Command", icon: Cable, run: () => ui.openDialog({ type: "addConnection" }) },
    { id: "cmd:stop", label: "Stop all agents", group: "Command", icon: OctagonX, run: () => void run(() => api.stopAll(), "Stop requested for all agents") },
    ...(p.emergency
      ? [{ id: "cmd:release", label: "Release emergency stop", group: "Safety", icon: Siren, run: () => void run(() => api.releaseEmergency(), "Emergency stop released") }]
      : []),
    { id: "cmd:improve", label: "Run an improvement cycle now", group: "Command", icon: FlaskConical, run: () => void run(() => api.startImprovementCycle(), "Improvement cycle started") },
    { id: "cmd:claude-refresh", label: "Refresh Claude Code environment", group: "Command", icon: RefreshCw, run: () => void useClaude.getState().load(true) },
    { id: "cmd:rail", label: "Toggle CONTROL rail", group: "Command", icon: PanelRightOpen, run: () => ui.toggleRail() },
    { id: "cmd:reset", label: "Reset workspace layout", group: "Command", icon: RotateCcw, run: () => void confirmResetLayout(ctx) },
    ...ALL_NAV_ITEMS.map((item) => ({ id: `view:${item.name}`, label: `Go to ${item.label}`, group: "View", icon: item.icon, run: () => s.navigate({ name: item.name }) })),
    ...p.agents.map((a) => ({ id: `agent:${a.id}`, label: `${a.name} — ${a.role}`, group: "Agent", icon: Bot, run: () => s.openAgent(a.id) })),
    ...p.missions.map((m) => ({ id: `mission:${m.id}`, label: m.title, group: "Mission", icon: Target, run: () => s.navigate({ name: "missions" }) })),
    ...p.tasks.map((t) => ({ id: `task:${t.id}`, label: t.title, group: "Task", icon: ListChecks, run: () => s.openTask(t.id) })),
    ...p.connections.map((c) => ({ id: `conn:${c.id}`, label: `${c.name} (${c.kind})`, group: "Connection", icon: Cable, run: () => s.navigate({ name: "connections" }) })),
  ];
}

/** Ctrl+K command bar: fuzzy search over agents, tasks, missions, connections, views and commands. */
export function CommandBar() {
  const open = useUi((s) => s.commandOpen);
  const setOpen = useUi((s) => s.setCommandOpen);
  const ctx = useLayoutContext();
  useProviders();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useUi.getState().commandOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  if (!open) return null;
  return <CommandPalette commands={buildCommands(ctx)} onClose={() => setOpen(false)} />;
}

function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => fuzzyFilter(commands, query, (c) => `${c.group} ${c.label}`, 60), [commands, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <div className="modal-backdrop cmd-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmd" role="dialog" aria-label="Command bar">
        <input
          autoFocus
          className="cmd-input"
          value={query}
          placeholder="Search agents, tasks, missions, connections, commands…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(results[index]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          aria-label="Search"
        />
        <div className="cmd-list" ref={listRef} role="listbox">
          {results.length === 0 && <div className="muted small pad">No match.</div>}
          {results.map((c, i) => {
            const Icon = c.icon;
            return (
              <button
                key={c.id}
                data-index={i}
                role="option"
                aria-selected={i === index}
                className={`cmd-item${i === index ? " active" : ""}`}
                onMouseMove={() => setIndex(i)}
                onClick={() => choose(c)}
              >
                <Icon size={13} />
                <span className="grow ellipsis">{c.label}</span>
                <span className="muted small">{c.group}</span>
                {i === index && <CornerDownLeft size={12} className="muted" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
