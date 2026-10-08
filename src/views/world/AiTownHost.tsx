import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Building2, Clapperboard, Crosshair, Eye, GitMerge, Info, Maximize, Palette, ShieldAlert, Square, ZoomIn, ZoomOut } from "lucide-react";
import { useT, useWorldT } from "../../i18n";
import { api, errorMessage } from "../../lib/api";
import { run } from "../../lib/toast";
import type { AiTownCameraMode, AiTownToNexus, AiTownWorld, NexusToAiTown } from "../../lib/types";
import { useRightContext } from "../../state/context";
import { useUi } from "../../state/ui";
import { useAgents, useMissions, useStore, useTasks } from "../../store";
import { isTrustedEvent, parseAiTownMessage } from "./aitown";
import { useAiTown } from "./aiTownStore";
import { BuildingPanel } from "./BuildingPanel";
import { followableMissions, frameSrc, missionAgentIds, worldStrings } from "./hq";
import { RoomPanel } from "./RoomPanel";
import { useHq, useHqSync } from "./useHq";
import { WorldCrash, type WorldCrashInfo } from "./WorldCrash";
import { buildTree, canDemote, canPromote, clampDepth, findNode, type TreeNode } from "../agents/hierarchy";
import { DemoteDialog } from "../agents/HierarchyView";

type CameraMode = AiTownCameraMode;
type Outgoing = NexusToAiTown extends infer M ? (M extends { source: "nexus" } ? Omit<M, "source"> : never) : never;
type Side = { kind: "room"; roomId: string } | { kind: "building" } | null;

/** The open project's AI World: the real AI Town game in an iframe, the bridge both ways, the camera toolbar, the room panels. */
export function AiTownHost({ world, compact, onCustomize, onSync, onAbout, onStop }: {
  world: AiTownWorld;
  /** Workspace panel: no toolbar, only the world. */
  compact?: boolean;
  onCustomize?: (agentId: string) => void;
  onSync?: () => void;
  onAbout?: () => void;
  onStop?: () => void;
}) {
  const t = useT();
  const worldT = useWorldT();
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [camera, setCamera] = useState<CameraMode>("free");
  const [demoting, setDemoting] = useState<TreeNode | null>(null);
  const [side, setSide] = useState<Side>(null);
  const [crash, setCrash] = useState<WorldCrashInfo | null>(null);
  const [safeMode, setSafeMode] = useState(false);
  const [reloads, setReloads] = useState(0);
  const agents = useAgents();
  const tasks = useTasks();
  const missions = useMissions();
  const navigate = useStore((s) => s.navigate);
  const openAgent = useStore((s) => s.openAgent);
  const projectId = useStore((s) => s.project?.info.id ?? null);
  const openContext = useRightContext((s) => s.openContext);
  const hq = useHq((s) => s.view);
  useHqSync();

  const post = useCallback((msg: Outgoing) => {
    frame.current?.contentWindow?.postMessage({ source: "nexus", ...msg }, window.location.origin);
  }, []);

  const strings = useMemo(() => worldStrings(worldT), [worldT]);
  useEffect(() => {
    if (ready) post({ type: "strings", strings });
  }, [ready, strings, post]);

  const focusRoom = (roomId: string) => {
    setCamera("free");
    post({ type: "focusRoom", roomId });
  };

  const handle = useRef<(m: AiTownToNexus) => void>(() => {});
  handle.current = (m) => {
    switch (m.type) {
      case "ready":
        setReady(true);
        setSafeMode(m.safeMode);
        post({ type: "strings", strings });
        if (selected) post({ type: "select", nexusId: selected });
        if (camera !== "free" && camera !== "mission") post({ type: "camera", mode: camera, nexusId: selected ?? undefined });
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
      case "openRoom":
        setSide({ kind: "room", roomId: m.roomId });
        break;
      case "warning":
        // Journaled by NEXUS (AI_WORLD_CHARACTER_APPEARANCE_MISSING, ...); the world already continued.
        void api.aiWorldHqWarning(m.warning).catch(() => undefined);
        break;
      case "crash": {
        const message = m.context.message;
        setCrash({ message, reportId: null, saveError: null });
        api
          .aiWorldHqCrash(m.context)
          .then((reportId) => setCrash((c) => (c ? { ...c, reportId } : c)))
          .catch((e) => setCrash((c) => (c ? { ...c, saveError: errorMessage(e) } : c)));
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
            navigate({ name: "memory" });
            break;
          case "viewTools":
            openContext({ kind: "agent", agentId: agent.id, tab: "work" });
            break;
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
  useEffect(() => {
    setReady(false);
    setCrash(null);
  }, [world.frontend]);

  const setMode = (mode: CameraMode) => {
    setCamera(mode);
    post({ type: "camera", mode, nexusId: mode === "follow" ? selected ?? undefined : undefined });
  };
  const followMission = (missionId: string) => {
    const m = missions.find((x) => x.id === missionId);
    if (!m) return;
    setCamera("mission");
    post({ type: "followMission", missionId: m.id, label: m.title, nexusIds: missionAgentIds(m.id, tasks, agents) });
  };
  /** Reloads the iframe (the engine keeps running); `safe` switches AI World Safe Mode. */
  const reloadView = (safe: boolean) => {
    setCrash(null);
    setReady(false);
    setSafeMode(safe);
    setReloads((n) => n + 1);
  };
  const reloadWorld = async () => {
    // Re-attaches the project's world (ensures it, pushes the building again), then reloads the view.
    if (projectId) await useAiTown.getState().start(projectId);
    void useHq.getState().load();
    reloadView(safeMode);
  };

  // Follow Mission keeps following the agents really working on it as tasks change.
  const [followed, setFollowed] = useState<string | null>(null);
  const missionIds = followed ? missionAgentIds(followed, tasks, agents).join(",") : "";
  useEffect(() => {
    if (camera !== "mission") setFollowed(null);
  }, [camera]);
  useEffect(() => {
    if (followed && camera === "mission") followMission(followed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionIds]);

  const selectedAgent = agents.find((a) => a.id === selected);
  const rooms = hq?.layout.rooms ?? [];
  const live = followableMissions(missions);
  const src = frameSrc(world.frontend, safeMode);

  return (
    <div className={`aitown-host${compact ? " compact" : ""}`}>
      {!compact && (
        <div className="aitown-toolbar" role="toolbar" aria-label={t("worldhq.toolbar")}>
          <div className="aitown-seg" role="group" aria-label={t("worldhq.cam.mode")}>
            <button className={`btn btn-sm${camera === "free" ? " active" : ""}`} aria-pressed={camera === "free"} onClick={() => setMode("free")} title={t("worldhq.cam.observeTip")}>
              <Eye size={13} /> {t("worldhq.cam.observe")}
            </button>
            <button
              className={`btn btn-sm${camera === "follow" ? " active" : ""}`}
              aria-pressed={camera === "follow"}
              disabled={!selected}
              onClick={() => setMode("follow")}
              title={selected ? t("worldhq.cam.followTip", { name: selectedAgent?.name ?? selected }) : t("worldhq.cam.followNone")}
            >
              <Crosshair size={13} /> {t("worldhq.cam.follow")}
            </button>
            <button className={`btn btn-sm${camera === "cinematic" ? " active" : ""}`} aria-pressed={camera === "cinematic"} onClick={() => setMode("cinematic")} title={t("worldhq.cam.cinematicTip")}>
              <Clapperboard size={13} /> {t("worldhq.cam.cinematic")}
            </button>
            <button className={`btn btn-sm${camera === "overview" ? " active" : ""}`} aria-pressed={camera === "overview"} onClick={() => setMode("overview")} title={t("worldhq.cam.overviewTip")}>
              <Maximize size={13} /> {t("worldhq.cam.overview")}
            </button>
          </div>
          <div className="aitown-seg" role="group" aria-label={t("worldhq.cam.zoom")}>
            <button className="icon-btn" aria-label={t("worldhq.cam.zoomOut")} title={t("worldhq.cam.zoomOut")} onClick={() => post({ type: "zoom", delta: -1 })}>
              <ZoomOut size={14} />
            </button>
            <button className="icon-btn" aria-label={t("worldhq.cam.zoomIn")} title={t("worldhq.cam.zoomIn")} onClick={() => post({ type: "zoom", delta: 1 })}>
              <ZoomIn size={14} />
            </button>
          </div>
          <select
            className="aitown-focus"
            aria-label={t("worldhq.focusRoomLabel")}
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              focusRoom(e.target.value);
              setSide({ kind: "room", roomId: e.target.value });
            }}
          >
            <option value="">{t("worldhq.focusRoom")}</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <select
            className="aitown-focus"
            aria-label={t("worldhq.findAgentLabel")}
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              setSelected(e.target.value);
              post({ type: "select", nexusId: e.target.value });
            }}
          >
            <option value="">{t("worldhq.findAgent")}</option>
            {agents
              .filter((a) => a.status !== "retired")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.profile?.appearance?.displayName || a.name}
                </option>
              ))}
          </select>
          <select
            className={`aitown-focus${camera === "mission" ? " active" : ""}`}
            aria-label={t("worldhq.followMissionLabel")}
            value={camera === "mission" && followed ? followed : ""}
            disabled={live.length === 0}
            onChange={(e) => {
              if (!e.target.value) {
                setMode("free");
                return;
              }
              setFollowed(e.target.value);
              followMission(e.target.value);
            }}
          >
            <option value="">{t("worldhq.followMission")}</option>
            {live.map((m) => {
              const count = missionAgentIds(m.id, tasks, agents).length;
              return (
                <option key={m.id} value={m.id}>
                  {count === 0 ? t("worldhq.missionOptionNone", { title: m.title }) : t("worldhq.missionOption", { title: m.title, count })}
                </option>
              );
            })}
          </select>
          <span className="spacer" />
          {safeMode && (
            <button className="btn btn-sm hq-safe" title={t("worldhq.safeModeTip")} onClick={() => reloadView(false)}>
              <ShieldAlert size={13} /> {t("worldhq.leaveSafeMode")}
            </button>
          )}
          <button
            className={`btn btn-sm${side?.kind === "building" ? " active" : ""}`}
            aria-pressed={side?.kind === "building"}
            title={t("worldhq.buildingTip")}
            onClick={() => setSide(side?.kind === "building" ? null : { kind: "building" })}
          >
            <Building2 size={13} /> {t("worldhq.building")}
          </button>
          {selectedAgent && onCustomize && (
            <button className="btn btn-sm" onClick={() => onCustomize(selectedAgent.id)} title={t("worldhq.customizeTip")}>
              <Palette size={13} /> {t("worldhq.customize", { name: selectedAgent.name })}
            </button>
          )}
          {onSync && (
            <button className="icon-btn" aria-label={t("worldhq.sync")} title={t("worldhq.sync")} onClick={onSync}>
              <GitMerge size={14} />
            </button>
          )}
          {onAbout && (
            <button className="icon-btn" aria-label={t("worldhq.about")} title={t("worldhq.about")} onClick={onAbout}>
              <Info size={14} />
            </button>
          )}
          {onStop && (
            <button className="icon-btn" aria-label={t("worldhq.stop")} title={t("worldhq.stop")} onClick={onStop}>
              <Square size={13} />
            </button>
          )}
        </div>
      )}
      <div className="aitown-frame">
        <iframe ref={frame} key={`${world.frontend}#${reloads}`} src={src} title={t("worldhq.frameTitle")} />
        {!ready && !crash && <div className="aitown-loading tiny muted">{t("worldhq.loading")}</div>}
        {side?.kind === "room" && <RoomPanel roomId={side.roomId} onFocus={focusRoom} onClose={() => setSide(null)} />}
        {side?.kind === "building" && <BuildingPanel onOpenRoom={(roomId) => setSide({ kind: "room", roomId })} onClose={() => setSide(null)} />}
        {crash && (
          <WorldCrash
            crash={crash}
            safeMode={safeMode}
            onRecover={() => reloadView(safeMode)}
            onReload={() => void reloadWorld()}
            onSafeMode={() => reloadView(true)}
            onDiagnostics={() => navigate({ name: "diagnostics" })}
          />
        )}
      </div>
      {demoting && <DemoteDialog node={demoting} onClose={() => setDemoting(null)} />}
    </div>
  );
}
