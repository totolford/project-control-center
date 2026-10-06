// NEXUS addition: the embedded world (?embed=nexus). AI Town's real engine
// and renderer (PixiGame) full-bleed, plus the NEXUS layer: buildings, agent
// decorations, profile card, observer camera and the bridge with NEXUS.
import { Stage } from '@pixi/react';
import { ConvexProvider, useConvex, useQuery } from 'convex/react';
import type { Viewport } from 'pixi-viewport';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useElementSize } from 'usehooks-ts';
import { api } from '../../convex/_generated/api';
import { GameId } from '../../convex/aiTown/ids';
import { NEXUS_ZONES, NexusZoneKind, zoneById } from '../../data/nexusZones';
import PixiGame from '../components/PixiGame';
import { useServerGame } from '../hooks/serverGame';
import { useHistoricalTime } from '../hooks/useHistoricalTime';
import { useWorldHeartbeat } from '../hooks/useWorldHeartbeat';
import {
  CAMERA_LABEL,
  CINEMATIC_MS,
  MAX_SCALE,
  cinematicShots,
  flyTo,
  followStep,
  minScale,
  overview,
  zoneCenter,
  zoomBy,
} from './camera';
import { useWorldStatus } from './embed';
import { NexusPixi, Positions, makeDecorator } from './NexusLayer';
import { ProfileCard } from './ProfileCard';
import { CameraMode, FromNexus, ToNexus, listenToNexus, postToNexus } from './protocol';
import { family, resolveCharacter, useNexusWorld } from './state';
import './nexus.css';

type Camera = { mode: CameraMode; nexusId?: string };

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
  const world = useNexusWorld(worldId, players);
  const [selected, setSelected] = useState<string | null>(null);
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

  const focusZone = useCallback((zone: NexusZoneKind) => {
    const z = zoneById(zone);
    if (z && viewportRef.current) {
      const c = zoneCenter(z);
      flyTo(viewportRef.current, c.x, c.y, 1.8);
    }
  }, []);

  // Messages from NEXUS (toolbar, agent list). Latest state through a ref.
  const handler = useRef<(m: FromNexus) => void>(() => {});
  handler.current = (m) => {
    const vp = viewportRef.current;
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
      case 'focusZone':
        setCamera({ mode: 'free' }, false);
        focusZone(m.zone);
        break;
      case 'camera': {
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
    }
  };
  useEffect(() => {
    const stop = listenToNexus((m) => handler.current(m));
    send({ type: 'ready' });
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
        if (c.mode === 'follow' || c.mode === 'cinematic') {
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
    if (camera.mode === 'follow' && camera.nexusId) {
      const p = positions.get(camera.nexusId);
      if (p) followStep(vp, p.x, p.y);
    } else if (camera.mode === 'cinematic') {
      const c = cinematic.current;
      const now = Date.now();
      if (now - c.at < CINEMATIC_MS) return;
      const shots = cinematicShots(world.state?.agents ?? [], positions, world.state?.zones ?? NEXUS_ZONES);
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

  const decorator = makeDecorator(world, selected, positions, Date.now());
  const nexus: NexusPixi = {
    decorator,
    zones: world.state?.zones ?? NEXUS_ZONES,
    counts,
    onOpenBuilding: (zone) => send({ type: 'openBuilding', zone }),
    onMapClick: () => {
      if (selected) select(null);
    },
    viewportRef,
  };

  const agent = selected ? world.byId.get(selected) : undefined;
  const following = camera.mode === 'follow' ? world.byId.get(camera.nexusId ?? '') : undefined;
  const agentCount = world.state?.agents.length;

  return (
    <div className="nexus-root" ref={wrapperRef}>
      {worldId && engineId && game ? (
        <Stage width={width} height={height} options={{ backgroundColor: 0x7ab5ff }}>
          <ConvexProvider client={convex}>
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
          </ConvexProvider>
        </Stage>
      ) : (
        <div className="nexus-empty nexus-panel font-body">Loading the world…</div>
      )}

      {agentCount === 0 && (
        <div className="nexus-empty nexus-panel font-body">
          No NEXUS agent in this project yet: characters appear when agents exist.
        </div>
      )}

      {game && (
        <div className="nexus-hud nexus-panel font-body" aria-live="polite">
          {CAMERA_LABEL[camera.mode]}
          {following ? ` ${following.name.toUpperCase()}` : ''}
          {camera.mode === 'cinematic' && cinematic.current.idle ? ' · NOTHING ACTIVE' : ''}
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
