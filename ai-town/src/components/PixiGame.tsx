import * as PIXI from 'pixi.js';
import { useApp } from '@pixi/react';
import { Player, SelectElement } from './Player.tsx';
import { useEffect, useRef, useState } from 'react';
import { PixiStaticMap } from './PixiStaticMap.tsx';
import PixiViewport from './PixiViewport.tsx';
import { Viewport } from 'pixi-viewport';
import { Id } from '../../convex/_generated/dataModel';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api.js';
import { useSendInput } from '../hooks/sendInput.ts';
import { toastOnError } from '../toasts.ts';
import { DebugPath } from './DebugPath.tsx';
import { PositionIndicator } from './PositionIndicator.tsx';
import { SHOW_DEBUG_UI } from './Game.tsx';
import { ServerGame } from '../hooks/serverGame.ts';
import type { NexusPixi } from '../nexus/NexusLayer.tsx';
import { Rooms } from '../nexus/Rooms.tsx';
import { CharacterBoundary } from '../nexus/boundaries.tsx';
import { mapSignature } from '../nexus/mapKey.ts';

export const PixiGame = (props: {
  worldId: Id<'worlds'>;
  engineId: Id<'engines'>;
  game: ServerGame;
  historicalTime: number | undefined;
  width: number;
  height: number;
  setSelectedElement: SelectElement;
  // NEXUS: rooms, decorations and camera of the embedded world.
  nexus?: NexusPixi;
}) => {
  // PIXI setup.
  const pixiApp = useApp();
  const ownViewportRef = useRef<Viewport | undefined>();
  const viewportRef = props.nexus?.viewportRef ?? ownViewportRef;

  const humanTokenIdentifier = useQuery(api.world.userStatus, { worldId: props.worldId }) ?? null;
  const humanPlayerId = [...props.game.world.players.values()].find(
    (p) => p.human === humanTokenIdentifier,
  )?.id;

  const moveTo = useSendInput(props.engineId, 'moveTo');

  // Interaction for clicking on the world to navigate.
  const dragStart = useRef<{ screenX: number; screenY: number } | null>(null);
  const onMapPointerDown = (e: any) => {
    // https://pixijs.download/dev/docs/PIXI.FederatedPointerEvent.html
    dragStart.current = { screenX: e.screenX, screenY: e.screenY };
  };

  const [lastDestination, setLastDestination] = useState<{
    x: number;
    y: number;
    t: number;
  } | null>(null);
  const onMapPointerUp = async (e: any) => {
    if (dragStart.current) {
      const { screenX, screenY } = dragStart.current;
      dragStart.current = null;
      const [dx, dy] = [screenX - e.screenX, screenY - e.screenY];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 10) {
        console.log(`Skipping navigation on drag event (${dist}px)`);
        return;
      }
    }
    // NEXUS: a click on the ground closes the profile card.
    props.nexus?.onMapClick();
    if (!humanPlayerId) {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const gameSpacePx = viewport.toWorld(e.screenX, e.screenY);
    const tileDim = props.game.worldMap.tileDim;
    const gameSpaceTiles = {
      x: gameSpacePx.x / tileDim,
      y: gameSpacePx.y / tileDim,
    };
    setLastDestination({ t: Date.now(), ...gameSpaceTiles });
    const roundedTiles = {
      x: Math.floor(gameSpaceTiles.x),
      y: Math.floor(gameSpaceTiles.y),
    };
    console.log(`Moving to ${JSON.stringify(roundedTiles)}`);
    await toastOnError(moveTo({ playerId: humanPlayerId, destination: roundedTiles }));
  };
  const { width, height, tileDim } = props.game.worldMap;
  const players = [...props.game.world.players.values()];

  // Zoom on the user’s avatar when it is created
  useEffect(() => {
    if (!viewportRef.current || humanPlayerId === undefined) return;

    const humanPlayer = props.game.world.players.get(humanPlayerId)!;
    viewportRef.current.animate({
      position: new PIXI.Point(humanPlayer.position.x * tileDim, humanPlayer.position.y * tileDim),
      scale: 1.5,
    });
  }, [humanPlayerId]);

  return (
    <PixiViewport
      app={pixiApp}
      screenWidth={props.width}
      screenHeight={props.height}
      worldWidth={width * tileDim}
      worldHeight={height * tileDim}
      viewportRef={viewportRef}
    >
      <PixiStaticMap
        // NEXUS: the static map is drawn once; a new building (rooms added,
        // moved, archived) gives it a new key so it is drawn again.
        key={props.nexus ? mapSignature(props.game.worldMap) : 'map'}
        map={props.game.worldMap}
        onpointerup={onMapPointerUp}
        onpointerdown={onMapPointerDown}
      />
      {props.nexus && (
        <Rooms
          rooms={props.nexus.rooms}
          connections={props.nexus.connections}
          counts={props.nexus.counts}
          focused={props.nexus.focusedRoom}
          safeMode={props.nexus.safeMode}
          onOpen={props.nexus.onOpenRoom}
        />
      )}
      {players.map(
        (p) =>
          // Only show the path for the human player in non-debug mode.
          (SHOW_DEBUG_UI || p.id === humanPlayerId) && (
            <DebugPath key={`path-${p.id}`} player={p} tileDim={tileDim} />
          ),
      )}
      {lastDestination && <PositionIndicator destination={lastDestination} tileDim={tileDim} />}
      {players.map((p) => {
        const player = (
          <Player
            key={`player-${p.id}`}
            game={props.game}
            player={p}
            isViewer={p.id === humanPlayerId}
            onClick={props.setSelectedElement}
            historicalTime={props.historicalTime}
            nexus={props.nexus?.decorator}
          />
        );
        if (!props.nexus) return player;
        // NEXUS: one character that fails to render falls back to the plain
        // default sprite; the rest of the world keeps rendering.
        const fallback = (
          <Player
            game={props.game}
            player={p}
            isViewer={false}
            onClick={props.setSelectedElement}
            historicalTime={props.historicalTime}
            nexus={props.nexus.fallbackDecorator}
          />
        );
        return (
          <CharacterBoundary
            key={`player-${p.id}`}
            playerId={p.id}
            fallback={fallback}
            onError={props.nexus.onCharacterError}
          >
            {player}
          </CharacterBoundary>
        );
      })}
    </PixiViewport>
  );
};
export default PixiGame;
