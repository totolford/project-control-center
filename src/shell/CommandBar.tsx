import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Cable,
  CornerDownLeft,
  FlaskConical,
  Globe2,
  Hand,
  ListChecks,
  LogIn,
  MessageSquare,
  OctagonX,
  PanelRight,
  PanelRightOpen,
  Plus,
  MonitorUp,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Siren,
  Sparkles,
  SquareTerminal,
  Target,
} from "lucide-react";
import { githubSignIn } from "../state/opsActions";
import { api } from "../lib/api";
import { run } from "../lib/toast";
import { fuzzyFilter } from "../lib/fuzzy";
import { useRightContext } from "../state/context";
import { useUi } from "../state/ui";
import { useStore } from "../store";
import { useClaude } from "../state/claude";
import { ALL_NAV_ITEMS } from "./navItems";
import { useHealth } from "./health/health";
import { focusCommandBar } from "./UniversalBar";
import { availableProviderId, useLayoutContext, useProviders } from "../workspace/hooks";
import { confirmResetLayout } from "../workspace/store";
import { t } from "../i18n";

interface Command {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  run: () => void;
}

/** Opens the structured "+ New Mission" flow of the Missions view. */
function newMission() {
  useUi.getState().setNewMission(true);
  useStore.getState().navigate({ name: "missions" });
}

function buildCommands(ctx: ReturnType<typeof useLayoutContext>): Command[] {
  const s = useStore.getState();
  const ui = useUi.getState();
  const p = s.project;
  const provider = availableProviderId();
  if (!p) return [];
  const CMD = t("cmd.group.command");
  return [
    { id: "cmd:mission", label: t("cmd.mission"), group: CMD, icon: Sparkles, run: newMission },
    { id: "cmd:ask", label: t("cmd.ask"), group: CMD, icon: MessageSquare, run: () => focusCommandBar("") },
    { id: "cmd:interpret", label: t("cmd.interpret"), group: CMD, icon: SquareTerminal, run: () => focusCommandBar("/run ") },
    {
      id: "cmd:right",
      label: t("cmd.right"),
      group: CMD,
      icon: PanelRight,
      run: () => {
        const r = useRightContext.getState();
        r.setRightOpen(!r.rightOpen);
      },
    },
    { id: "cmd:journal", label: t("cmd.journal"), group: CMD, icon: ScrollText, run: () => s.navigate({ name: "commands", section: "journal" }) },
    { id: "cmd:world", label: t("cmd.world"), group: CMD, icon: Globe2, run: () => s.navigate({ name: "world" }) },
    {
      id: "cmd:ai-town",
      label: t("cmd.aiTown"),
      group: CMD,
      icon: Globe2,
      run: () => {
        ui.setAiWorldWizard(true);
        s.navigate({ name: "world" });
      },
    },
    { id: "cmd:gh-login", label: t("cmd.ghLogin"), group: CMD, icon: LogIn, run: () => void githubSignIn() },
    ...(p.userRequests.length > 0
      ? [{ id: "cmd:requests", label: t("cmd.requests", { count: p.userRequests.length }), group: CMD, icon: Hand, run: () => ui.setRequestsCollapsed(false) }]
      : []),
    ...(provider ? [{ id: "cmd:agent", label: t("cmd.agent"), group: CMD, icon: Plus, run: () => ui.openDialog({ type: "newAgent", provider }) }] : []),
    { id: "cmd:conn", label: t("cmd.conn"), group: CMD, icon: Cable, run: () => ui.openDialog({ type: "addConnection" }) },
    { id: "cmd:stop", label: t("cmd.stop"), group: CMD, icon: OctagonX, run: () => void run(() => api.stopAll(), t("cmd.stopDone")) },
    ...(p.emergency
      ? [{ id: "cmd:release", label: t("cmd.release"), group: t("cmd.group.safety"), icon: Siren, run: () => void run(() => api.releaseEmergency(), t("cmd.releaseDone")) }]
      : []),
    { id: "cmd:improve", label: t("cmd.improve"), group: CMD, icon: FlaskConical, run: () => void run(() => api.startImprovementCycle(), t("cmd.improveDone")) },
    { id: "cmd:claude-refresh", label: t("cmd.claudeRefresh"), group: CMD, icon: RefreshCw, run: () => void useClaude.getState().load(true) },
    { id: "cmd:rail", label: t("cmd.rail"), group: CMD, icon: PanelRightOpen, run: () => ui.toggleRail() },
    {
      id: "cmd:reload-ui",
      label: t("cmd.reloadUi"),
      group: CMD,
      icon: MonitorUp,
      run: () => useHealth.getState().openOverlay({ reason: t("cmd.reloadReason"), auto: false, forced: true, immediate: true }),
    },
    { id: "cmd:reset", label: t("cmd.reset"), group: CMD, icon: RotateCcw, run: () => void confirmResetLayout(ctx) },
    ...ALL_NAV_ITEMS.map((item) => ({ id: `view:${item.name}`, label: t("cmd.goTo", { name: item.label }), group: t("cmd.group.view"), icon: item.icon, run: () => s.navigate({ name: item.name }) })),
    ...p.agents.map((a) => ({ id: `agent:${a.id}`, label: `${a.name} — ${a.role}`, group: t("cmd.group.agent"), icon: Bot, run: () => s.openAgent(a.id) })),
    ...p.agents
      .filter((a) => a.status !== "retired")
      .map((a) => ({
        id: `talk:${a.id}`,
        label: t("cmd.talkTo", { name: a.name }),
        group: t("cmd.group.chat"),
        icon: MessageSquare,
        run: () => useRightContext.getState().openContext(a.id === "central" ? { kind: "central" } : { kind: "agent", agentId: a.id, tab: "chat" }),
      })),
    ...p.missions.map((m) => ({
      id: `mission:${m.id}`,
      label: m.title,
      group: t("cmd.group.mission"),
      icon: Target,
      run: () => {
        s.navigate({ name: "missions" });
        useRightContext.getState().openContext({ kind: "mission", missionId: m.id });
      },
    })),
    ...p.tasks.map((task) => ({ id: `task:${task.id}`, label: task.title, group: t("cmd.group.task"), icon: ListChecks, run: () => s.openTask(task.id) })),
    ...p.connections.map((c) => ({ id: `conn:${c.id}`, label: `${c.name} (${c.kind})`, group: t("cmd.group.connection"), icon: Cable, run: () => s.navigate({ name: "connections" }) })),
  ];
}

/** Ctrl+K palette: fuzzy search over agents, tasks, missions, connections, views and commands. */
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
      <div className="cmd" role="dialog" aria-label={t("shell.commandBar")}>
        <input
          autoFocus
          className="cmd-input"
          value={query}
          placeholder={t("cmd.placeholder")}
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
          aria-label={t("common.search")}
        />
        <div className="cmd-list" ref={listRef} role="listbox">
          {results.length === 0 && <div className="muted small pad">{t("cmd.noMatch")}</div>}
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
