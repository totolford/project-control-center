import { useCallback, useEffect, useRef, useState } from "react";
import { Clapperboard, Crosshair, Eye, GitMerge, Info, Maximize, Palette, Square, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "../../lib/api";
import { run } from "../../lib/toast";
import type { AiTownToNexus, AiTownWorld, NexusToAiTown, NexusZoneKind } from "../../lib/types";
import { useRightContext } from "../../state/context";
import { useUi } from "../../state/ui";
import { useAgents, useStore } from "../../store";
import { BUILDING_TARGET, NEXUS_ZONES, isTrustedEvent, parseAiTownMessage } from "./aitown";
import { buildTree, canDemote, canPromote, clampDepth, findNode, type TreeNode } from "../agents/hierarchy";
import { DemoteDialog } from "../agents/HierarchyView";

type CameraMode = Extract<NexusToAiTown, { type: "camera" }>["mode"];
type Outgoing = NexusToAiTown extends infer M ? (M extends { source: "nexus" } ? Omit<M, "source"> : never) : never;

/** The open project's AI Town: the real game in an iframe, the bridge both ways and the camera toolbar. */
export function AiTownHost({ world, compact, onCustomize, onSync, onAbout, onStop }: {
  world: AiTownWorld;
  /** Workspace panel: no toolbar, only the world. */
  compact?: boolean;
  onCustomize?: (agentId: string) => void;
  onSync?: () => void;
  onAbout?: () => void;
  onStop?: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [camera, setCamera] = useState<CameraMode>("free");
  const [demoting, setDemoting] = useState<TreeNode | null>(null);
  const agents = useAgents();
  const navigate = useStore((s) => s.navigate);
  const openAgent = useStore((s) => s.openAgent);
  const openContext = useRightContext((s) => s.openContext);

  const post = useCallback((msg: Outgoing) => {
    frame.current?.contentWindow?.postMessage({ source: "nexus", ...msg }, window.location.origin);
  }, []);

  const handle = useRef<(m: AiTownToNexus) => void>(() => {});
  handle.current = (m) => {
    switch (m.type) {
      case "ready":
        setReady(true);
        if (selected) post({ type: "select", nexusId: selected });
        if (camera !== "free") post({ type: "camera", mode: camera, nexusId: selected ?? undefined });
        break;
      case "select":
        setSelected(m.nexusId);
        break;
      case "camera":
        setCamera(m.mode);
        break;
      case "talk":
        openContext({ kind: "agent", agentId: m.nexusId, tab: "chat" });
        break;
      case "viewWork":
        openContext({ kind: "agent", agentId: m.nexusId, tab: "work" });
        break;
      case "openBuilding": {
        const target = BUILDING_TARGET[m.zone];
        if (target.kind === "central") openContext({ kind: "central" });
        else navigate({ name: target.view });
        break;
      }
      case "action": {
        const agent = agents.find((a) => a.id === m.nexusId);
        if (!agent) return;
        switch (m.action) {
          case "assignMission":
            useUi.getState().setNewMission(true, `${agent.name}: `);
            navigate({ name: "missions" });
            break;
          case "pause":
            void run(() => api.pauseAgent(agent.id), `${agent.name} paused: nothing is delivered until resumed`);
            break;
          case "resume":
            void run(() => api.resumeAgent(agent.id), `${agent.name} resumed`);
            break;
          case "restart":
            void run(() => api.restartAgent(agent.id), `Restarting ${agent.name}`);
            break;
          case "promote":
          case "demote": {
            const node = findNode(buildTree(agents), agent.id);
            if (!node) break;
            const settings = useStore.getState().project?.settings;
            const check = m.action === "promote" ? canPromote(node, clampDepth(settings?.maxHierarchyDepth)) : canDemote(node);
            if (!check.allowed) void run(() => Promise.reject(new Error(check.reason)));
            else if (m.action === "promote") void run(() => api.promoteAgent(agent.id), `${agent.name} promoted to lieutenant`);
            else if (node.children.length > 0) setDemoting(node);
            else void run(() => api.demoteAgent(agent.id), `${agent.name} demoted to specialist`);
            break;
          }
          case "viewTasks":
            if (agent.currentTask) useStore.getState().openTask(agent.currentTask);
            else navigate({ name: "tasks" });
            break;
          case "viewMemory":
          case "viewTools":
          case "stop":
            void run(() => api.stopAgent(agent.id), `${agent.name} stopped`);
            break;
          case "follow":
            setCamera("follow");
            post({ type: "camera", mode: "follow", nexusId: agent.id });
            break;
          case "customize":
            onCustomize?.(agent.id);
            break;
          case "inspect":
          case "changeModel":
          case "changeSkills":
          case "changeMcp":
          case "changeConnections":
            // Model, skills, MCP and connections are edited on the agent page.
            openAgent(agent.id);
            break;
        }
        break;
      }
    }
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!isTrustedEvent(e, frame.current?.contentWindow, window.location.origin)) return;
      const m = parseAiTownMessage(e.data);
      if (m) handle.current(m);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // A new world (project switch, restart) reloads the iframe.
  useEffect(() => setReady(false), [world.frontend]);

  const setMode = (mode: CameraMode) => {
    setCamera(mode);
    post({ type: "camera", mode, nexusId: mode === "follow" ? selected ?? undefined : undefined });
  };
  const selectedAgent = agents.find((a) => a.id === selected);

  return (
    <div className={`aitown-host${compact ? " compact" : ""}`}>
      {!compact && (
        <div className="aitown-toolbar" role="toolbar" aria-label="AI Town camera">
          <div className="aitown-seg" role="group" aria-label="Camera mode">
            <button className={`btn btn-sm${camera === "free" ? " active" : ""}`} aria-pressed={camera === "free"} onClick={() => setMode("free")} title="Drag and zoom freely">
              <Eye size={13} /> Observe
            </button>
            <button
              className={`btn btn-sm${camera === "follow" ? " active" : ""}`}
              aria-pressed={camera === "follow"}
              disabled={!selected}
              onClick={() => setMode("follow")}
              title={selected ? `Follow ${selectedAgent?.name ?? "the selected character"}` : "Select a character to follow it"}
            >
              <Crosshair size={13} /> Follow
            </button>
            <button className={`btn btn-sm${camera === "cinematic" ? " active" : ""}`} aria-pressed={camera === "cinematic"} onClick={() => setMode("cinematic")} title="Visits the agents and buildings where something real is happening">
              <Clapperboard size={13} /> Cinematic
            </button>
            <button className={`btn btn-sm${camera === "overview" ? " active" : ""}`} aria-pressed={camera === "overview"} onClick={() => setMode("overview")} title="The whole town">
              <Maximize size={13} /> Overview
            </button>
          </div>
          <div className="aitown-seg" role="group" aria-label="Zoom">
            <button className="icon-btn" aria-label="Zoom out" title="Zoom out" onClick={() => post({ type: "zoom", delta: -1 })}>
              <ZoomOut size={14} />
            </button>
            <button className="icon-btn" aria-label="Zoom in" title="Zoom in" onClick={() => post({ type: "zoom", delta: 1 })}>
              <ZoomIn size={14} />
            </button>
          </div>
          <select
            className="aitown-focus"
            aria-label="Focus a building"
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              setCamera("free");
              post({ type: "focusZone", zone: e.target.value as NexusZoneKind });
            }}
          >
            <option value="">Focus building…</option>
            {NEXUS_ZONES.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
          <select
            className="aitown-focus"
            aria-label="Focus an agent"
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              setSelected(e.target.value);
              post({ type: "select", nexusId: e.target.value });
            }}
          >
            <option value="">Find agent…</option>
            {agents
              .filter((a) => a.status !== "retired")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.profile.appearance?.displayName || a.name}
                </option>
              ))}
          </select>
          <span className="spacer" />
          {selectedAgent && onCustomize && (
            <button className="btn btn-sm" onClick={() => onCustomize(selectedAgent.id)} title="Customize the selected character">
              <Palette size={13} /> Customize {selectedAgent.name}
            </button>
          )}
          {onSync && (
            <button className="icon-btn" aria-label="Sync with AI Town upstream" title="Sync with AI Town upstream" onClick={onSync}>
              <GitMerge size={14} />
            </button>
          )}
          {onAbout && (
            <button className="icon-btn" aria-label="About AI Town" title="About AI Town" onClick={onAbout}>
              <Info size={14} />
            </button>
          )}
          {onStop && (
            <button className="icon-btn" aria-label="Stop AI Town" title="Stop AI Town (the local backend)" onClick={onStop}>
              <Square size={13} />
            </button>
          )}
        </div>
      )}
      <div className="aitown-frame">
        <iframe ref={frame} key={world.frontend} src={world.frontend} title="AI Town"/>
        {!ready && <div className="aitown-loading tiny muted">Loading the town…</div>}
      </div>
      {demoting && <DemoteDialog node={demoting} onClose={() => setDemoting(null)} />}
    </div>
  );
}
