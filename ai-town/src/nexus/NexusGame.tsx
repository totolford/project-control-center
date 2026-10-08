// NEXUS addition: the embedded world (?embed=nexus). AI Town's real engine
// and renderer (PixiGame) full-bleed, plus the NEXUS layer: NEXUS HQ's room
// signs, agent decorations, profile card, observer camera, the validator /
// repair of characters, crash boundaries and the bridge with NEXUS.
import { Stage } from '@pixi/react';
import { ConvexProvider, useConvex, useQuery } from 'convex/react';
import type { Viewport } from 'pixi-viewport';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useElementSize } from 'usehooks-ts';
import { api } from '../../convex/_generated/api';
import { GameId } from '../../convex/aiTown/ids';
import PixiGame from '../components/PixiGame';
import { useServerGame } from '../hooks/serverGame';
import { useHistoricalTime } from '../hooks/useHistoricalTime';
import { useWorldHeartbeat } from '../hooks/useWorldHeartbeat';
import {
  CINEMATIC_MS,
  MAX_SCALE,
  cinematicShots,
  flyTo,
  followStep,
  groupFrame,
  minScale,
  overview,
  roomCenter,
  zoomBy,
} from './camera';
import { SAFE_MODE, useWorldStatus } from './embed';
import { FALLBACK_DECORATOR, NexusPixi, Positions, makeDecorator } from './NexusLayer';
import { WorldBoundary } from './boundaries';
import { crashContext, trace, traceEvent } from './trace';
import { REPAIR_TEXT, WarningReporter } from './validate';
import { cameraLabel, setWorldStrings, text } from './strings';
import { ProfileCard } from './ProfileCard';
import { CameraMode, FromNexus, ToNexus, listenToNexus, postToNexus } from './protocol';
import { family, resolveCharacter, useNexusWorld } from './state';
import './nexus.css';

type Camera = { mode: CameraMode; nexusId?: string; mission?: { id: string; label: string; nexusIds: string[] } };

export default function NexusGame() {
  const convex = useConvex();
  const worldStatus = useWorldStatus();
  const worldId = worldStatus?.worldId;
  const engineId = worldStatus?.engineId;
  const game = useServerGame(worldId);
  useWorldHeartbeat();
  const worldState = useQuery(api.world.worldState, worldId ? { worldId } : 'skip');
  const { historicalTime } = useHistoricalTime(worldState?.engine);
  const [wrapperRef, { width, height }] = useElementSize();

  const players = useMemo(
    () => (game ? [...game.world.players.values()].map((p) => ({ id: p.id as string, human: p.human })) : []),
    [game],
  );
  const world = useNexusWorld(worldId, players, SAFE_MODE);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusedRoom, setFocusedRoom] = useState<string | null>(null);
  const [crashed, setCrashed] = useState<string | null>(null);
  const [viewKey, setViewKey] = useState(0);
  const [, setStringsVersion] = useState(0);
  const [camera, setCameraState] = useState<Camera>({ mode: 'free' });
  const positions = useRef<Positions>(new Map()).current;
  const viewportRef = useRef<Viewport | undefined>();
  const cinematic = useRef({ index: -1, at: 0, idle: false });

  const tileDim = game?.worldMap.tileDim ?? 32;
  const worldWidth = (game?.worldMap.width ?? 0) * tileDim;
  const worldHeight = (game?.worldMap.height ?? 0) * tileDim;
  const size = { width, height, worldWidth, worldHeight };

  const send = useCallback((msg: ToNexus) => postToNexus(msg), []);

  const setCamera = useCallback(
    (c: Camera, notify = true) => {
      cinematic.current = { index: -1, at: 0, idle: false };
      setCameraState(c);
      if (notify) send({ type: 'camera', mode: c.mode, nexusId: c.nexusId });
    },
    [send],
  );

  const select = useCallback(
    (nexusId: string | null) => {
      setSelected(nexusId);
      send({ type: 'select', nexusId });
    },
    [send],
  );

  const focusAgent = useCallback(
    (nexusId: string) => {
      const p = positions.get(nexusId);
      if (p && viewportRef.current) flyTo(viewportRef.current, p.x, p.y, 2);
    },
    [positions],
  );

  const rooms = world.state?.rooms ?? [];
  const focusRoom = useCallback(
    (roomId: string) => {
      const r = rooms.find((x) => x.id === roomId);
      setFocusedRoom(r ? r.id : null);
      if (r && viewportRef.current) {
        const c = roomCenter(r);
        flyTo(viewportRef.current, c.x, c.y, 1.8);
      }
    },
    [rooms],
  );

  // Repairs of the validator: journaled by NEXUS, once per agent and problem.
  const reporter = useRef(new WarningReporter((warning) => send({ type: 'warning', warning }))).current;
  useEffect(() => reporter.report(world.warnings), [world.warnings, reporter]);

  const onCrash = useCallback(
    (error: unknown, componentStack: string) => {
      const context = crashContext(
        error,
        componentStack,
        {
          worldId: worldId ?? null,
          agents: world.state?.agents.length ?? 0,
          rooms: world.state?.rooms.length ?? 0,
          revision: world.state?.building.revision ?? null,
        },
        SAFE_MODE,
      );
      send({ type: 'crash', context });
      setCrashed(context.message || 'rendering error');
    },
    [send, worldId, world.state],
  );
  const onCharacterError = useCallback(
    (playerId: string, error: unknown) => {
      const agent = world.byPlayer.get(playerId);
      const message = error instanceof Error ? error.message : String(error);
      send({
        type: 'warning',
        warning: {
          code: 'AI_WORLD_CHARACTER_RENDER_FAILED',
          nexusId: agent?.nexusId ?? playerId,
          detail: `${message.slice(0, 200)} (${trace.lastRenderOp})`,
          repair: REPAIR_TEXT.AI_WORLD_CHARACTER_RENDER_FAILED,
        },
      });
    },
    [send, world.byPlayer],
  );

  // Messages from NEXUS (toolbar, agent list). Latest state through a ref.
  const handler = useRef<(m: FromNexus) => void>(() => {});
  handler.current = (m) => {
    const vp = viewportRef.current;
    traceEvent(`nexus:${m.type}`);
    switch (m.type) {
      case 'select':
        setSelected(m.nexusId);
        if (m.nexusId && camera.mode !== 'follow') {
          if (camera.mode !== 'free') setCamera({ mode: 'free' });
          focusAgent(m.nexusId);
        }
        break;
      case 'focus':
        setCamera({ mode: 'free' }, false);
        focusAgent(m.nexusId);
        break;
      case 'focusRoom':
        setCamera({ mode: 'free' }, false);
        focusRoom(m.roomId);
        break;
      case 'followMission':
        setCamera({ mode: 'mission', mission: { id: m.missionId, label: m.label, nexusIds: m.nexusIds } }, false);
        break;
      case 'camera': {
        if (m.mode === 'mission') break;
        const nexusId = m.mode === 'follow' ? m.nexusId ?? selected ?? undefined : undefined;
        if (m.mode === 'follow' && !nexusId) {
          // Nothing to follow: stay free and tell NEXUS.
          setCamera({ mode: 'free' });
          break;
        }
        setCamera({ mode: m.mode, nexusId }, false);
        if (m.mode === 'overview' && vp) overview(vp, size);
        if (nexusId) {
          setSelected(nexusId);
          focusAgent(nexusId);
        }
        break;
      }
      case 'zoom':
        if (vp) zoomBy(vp, m.delta, size);
        break;
      case 'strings':
        if (setWorldStrings(m.strings) > 0) setStringsVersion((n) => n + 1);
        break;
    }
  };
  useEffect(() => {
    const stop = listenToNexus((m) => handler.current(m));
    send({ type: 'ready', safeMode: SAFE_MODE });
    return stop;
  }, [send]);

  // Overview needs the whole town: lower AI Town's zoom bound (half the map).
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || !worldWidth || !width) return;
    vp.clampZoom({ minScale: minScale({ width, height, worldWidth, worldHeight }), maxScale: MAX_SCALE });
  }, [viewportRef.current, width, height, worldWidth, worldHeight]);

  // A drag of the map gives the camera back to the user.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onDrag = () => {
      setCameraState((c) => {
        if (c.mode === 'follow' || c.mode === 'cinematic' || c.mode === 'mission') {
          send({ type: 'camera', mode: 'free' });
          return { mode: 'free' };
        }
        return c;
      });
    };
    vp.on('drag-start', onDrag);
    vp.on('pinch-start', onDrag);
    return () => {
      vp.off('drag-start', onDrag);
      vp.off('pinch-start', onDrag);
    };
  }, [viewportRef.current, send]);

  // Camera step, once per rendered frame (useHistoricalTime re-renders on rAF).
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    trace.camera = { mode: camera.mode, x: vp.center.x, y: vp.center.y, scale: vp.scale.x };
    if (camera.mode === 'follow' && camera.nexusId) {
      const p = positions.get(camera.nexusId);
      if (p) followStep(vp, p.x, p.y);
    } else if (camera.mode === 'mission' && camera.mission) {
      // Only the agents NEXUS reports as working on the mission; nothing else is invented.
      const f = groupFrame(camera.mission.nexusIds, positions, size);
      if (f) {
        followStep(vp, f.x, f.y);
        if (!vp.plugins.get('animate') && Math.abs(vp.scale.x - f.scale) > 0.05) {
          vp.setZoom(vp.scale.x + (f.scale - vp.scale.x) * 0.08, true);
        }
      }
    } else if (camera.mode === 'cinematic') {
      const c = cinematic.current;
      const now = Date.now();
      if (now - c.at < CINEMATIC_MS) return;
      const shots = cinematicShots(world.state?.agents ?? [], positions, rooms);
      c.at = now;
      if (shots.length === 0) {
        // Nothing real is happening: show the whole town instead of inventing a subject.
        if (!c.idle) overview(vp, size);
        c.idle = true;
        return;
      }
      c.idle = false;
      c.index = (c.index + 1) % shots.length;
      const shot = shots[c.index];
      flyTo(vp, shot.x, shot.y, shot.kind === 'agent' ? 2.2 : 1.6, 1400);
    }
  });

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of world.state?.agents ?? []) m.set(a.zone, (m.get(a.zone) ?? 0) + 1);
    return m;
  }, [world.state]);

  const decorator = makeDecorator(world, selected, positions, Date.now(), SAFE_MODE);
  const nexus: NexusPixi = {
    decorator,
    fallbackDecorator: FALLBACK_DECORATOR,
    rooms,
    connections: world.state?.connections ?? [],
    counts,
    focusedRoom,
    safeMode: SAFE_MODE,
    onCharacterError,
    onOpenRoom: (roomId) => {
      setFocusedRoom(roomId);
      if (selected) select(null);
      send({ type: 'openRoom', roomId });
    },
    onMapClick: () => {
      if (selected) select(null);
    },
    viewportRef,
  };

  const agent = selected ? world.byId.get(selected) : undefined;
  const following = camera.mode === 'follow' ? world.byId.get(camera.nexusId ?? '') : undefined;
  const agentCount = world.state?.agents.length;

  const missionAgents = camera.mode === 'mission' ? camera.mission?.nexusIds.filter((id) => positions.has(id)).length ?? 0 : 0;

  return (
    <div className="nexus-root" ref={wrapperRef}>
      {crashed ? (
        <div className="nexus-empty nexus-panel font-body" role="alert">
          {text('crashed')}
          <button
            className="nexus-btn"
            onClick={() => {
              setCrashed(null);
              setViewKey((k) => k + 1);
            }}
          >
            {text('recoverView')}
          </button>
        </div>
      ) : worldId && engineId && game ? (
        <WorldBoundary key={viewKey} onCrash={onCrash} crashed={null}>
          <Stage
            width={width}
            height={height}
            options={{ backgroundColor: 0x181425 }}
            onMount={(app) => {
              trace.renderer = app.renderer.type === 1 ? 'webgl' : 'canvas';
              app.view.addEventListener?.('webglcontextlost', () => {
                trace.renderer = 'webgl context lost';
                onCrash(new Error('The WebGL context was lost (GPU driver reset or out of memory).'), '');
              });
            }}
          >
            <ConvexProvider client={convex}>
              <WorldBoundary onCrash={onCrash} crashed={null}>
                <PixiGame
                  game={game}
                  worldId={worldId}
                  engineId={engineId}
                  width={width}
                  height={height}
                  historicalTime={historicalTime}
                  setSelectedElement={(el?: { kind: 'player'; id: GameId<'players'> }) => {
                    const a = el ? world.byPlayer.get(el.id) : undefined;
                    select(a?.nexusId ?? null);
                  }}
                  nexus={nexus}
                />
              </WorldBoundary>
            </ConvexProvider>
          </Stage>
        </WorldBoundary>
      ) : (
        <div className="nexus-empty nexus-panel font-body">{text('loading')}</div>
      )}

      {agentCount === 0 && !crashed && (
        <div className="nexus-empty nexus-panel font-body">{text('noAgents')}</div>
      )}

      {game && !crashed && (
        <div className="nexus-hud nexus-panel font-body" aria-live="polite">
          {SAFE_MODE ? `${text('safeMode')} · ` : ''}
          {cameraLabel(camera.mode)}
          {following ? ` ${following.name.toUpperCase()}` : ''}
          {camera.mode === 'mission' && camera.mission
            ? ` ${camera.mission.label.toUpperCase()}${missionAgents === 0 ? ` · ${text('nobodyOnMission')}` : ` · ${missionAgents}`}`
            : ''}
          {camera.mode === 'cinematic' && cinematic.current.idle ? ` · ${text('nothingActive')}` : ''}
        </div>
      )}

      {agent && (
        <ProfileCard
          agent={agent}
          look={resolveCharacter(agent.character, world.state?.skins)}
          following={camera.mode === 'follow' && camera.nexusId === agent.nexusId}
          family={family(agent, world.state?.agents ?? [])}
          onSelect={(id) => select(id)}
          onClose={() => select(null)}
          send={(msg) => {
            if (msg.type === 'action' && msg.action === 'follow') {
              const on = !(camera.mode === 'follow' && camera.nexusId === msg.nexusId);
              setCamera(on ? { mode: 'follow', nexusId: msg.nexusId } : { mode: 'free' });
              if (on) focusAgent(msg.nexusId);
              return;
            }
            send(msg);
          }}
        />
      )}
    </div>
  );
}
