// NEXUS addition: the overlay of NEXUS HQ's rooms — name signs with the
// number of real agents inside, hover / focus outline, purpose, and the
// connections NEXUS declared between rooms. Floors, walls and furniture are
// real map tiles (data/nexusHq.ts); this layer only labels them.
import * as PIXI from 'pixi.js';
import { Container, Graphics, Text } from '@pixi/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { HqRoom } from '../../data/nexusHq';
import { connectionLines, isRecent, roomBounds, signAnchor, signText } from './roomGeometry';
import { traceRoom } from './trace';

export const SIGN_FONT = 'VCR OSD Mono, monospace';

const signStyle = new PIXI.TextStyle({ fontFamily: SIGN_FONT, fontSize: 10, fill: 0x181425, fontWeight: 'bold' });
const purposeStyle = new PIXI.TextStyle({
  fontFamily: SIGN_FONT,
  fontSize: 9,
  fill: 0xffffff,
  stroke: 0x181425,
  strokeThickness: 3,
  wordWrap: true,
  wordWrapWidth: 220,
});

/** Brass plate on the room's top wall. */
function Sign({ room, count, highlighted }: { room: HqRoom; count: number; highlighted: boolean }) {
  const text = signText(room, count);
  const width = Math.min(room.w * 32 - 8, Math.max(40, [...text].length * 6.4 + 12));
  const { x, y } = signAnchor(room);
  const color = room.kind === 'central_hq' ? 0xfec742 : room.temporary ? 0x9ad0ff : 0xe8c690;
  const draw = useCallback(
    (g: PIXI.Graphics) => {
      g.clear();
      g.beginFill(0x3f2832);
      g.drawRect(-width / 2 - 2, -9, width + 4, 18);
      g.endFill();
      g.beginFill(highlighted ? 0xfff1b8 : color);
      g.drawRect(-width / 2, -7, width, 14);
      g.endFill();
      g.beginFill(0xffffff, 0.3);
      g.drawRect(-width / 2, -7, width, 2);
      g.endFill();
    },
    [width, color, highlighted],
  );
  return (
    <Container x={x} y={y}>
      <Graphics draw={draw} />
      <Text text={text} anchor={{ x: 0.5, y: 0.5 }} y={0} resolution={4} style={signStyle} />
    </Container>
  );
}

function Room({
  room,
  count,
  focused,
  plain,
  onOpen,
}: {
  room: HqRoom;
  count: number;
  focused: boolean;
  /** Safe Mode: no hover effects. */
  plain: boolean;
  onOpen: (roomId: string) => void;
}) {
  traceRoom(room.id);
  const [hovered, setHovered] = useState(false);
  const down = useRef<{ x: number; y: number } | null>(null);
  const b = roomBounds(room);
  const hitArea = useMemo(() => new PIXI.Rectangle(b.x, b.y, b.w, b.h), [b.x, b.y, b.w, b.h]);
  const lit = focused || (hovered && !plain);
  const drawOutline = useCallback(
    (g: PIXI.Graphics) => {
      g.clear();
      if (lit) {
        g.lineStyle(2, focused ? 0x4ade80 : 0xfec742, 0.95);
        g.drawRect(b.x - 1, b.y - 1, b.w + 2, b.h + 2);
      }
    },
    [b.x, b.y, b.w, b.h, lit, focused],
  );
  return (
    <Container
      eventMode="static"
      cursor="pointer"
      hitArea={hitArea}
      pointerover={() => setHovered(true)}
      pointerout={() => setHovered(false)}
      pointerdown={(e: PIXI.FederatedPointerEvent) => {
        down.current = { x: e.screenX, y: e.screenY };
      }}
      pointerup={(e: PIXI.FederatedPointerEvent) => {
        const d = down.current;
        down.current = null;
        // A drag of the camera is not a click.
        if (d && Math.hypot(d.x - e.screenX, d.y - e.screenY) < 10) onOpen(room.id);
      }}
    >
      <Graphics draw={drawOutline} />
      <Sign room={room} count={count} highlighted={lit} />
      {lit && room.purpose && (
        <Text
          text={room.purpose}
          anchor={{ x: 0.5, y: 0 }}
          x={b.x + b.w / 2}
          y={b.y + b.h + 4}
          resolution={4}
          style={purposeStyle}
        />
      )}
    </Container>
  );
}

function Connections({ rooms, connections }: { rooms: HqRoom[]; connections: { from: string; to: string }[] }) {
  const lines = useMemo(() => connectionLines(rooms, connections), [rooms, connections]);
  const draw = useCallback(
    (g: PIXI.Graphics) => {
      g.clear();
      for (const l of lines) {
        // Dotted line between the two doors.
        const dx = l.b.x - l.a.x;
        const dy = l.b.y - l.a.y;
        const n = Math.max(1, Math.floor(Math.hypot(dx, dy) / 12));
        g.beginFill(0x9ad0ff, 0.55);
        for (let i = 0; i <= n; i++) g.drawRect(l.a.x + (dx * i) / n - 1.5, l.a.y + (dy * i) / n - 1.5, 3, 3);
        g.endFill();
      }
    },
    [lines],
  );
  return <Graphics draw={draw} />;
}

/**
 * All rooms. `counts` = real agents currently in each room (from the agent
 * rows). Safe Mode: no connections, no hover effects, no sign on rooms
 * created in the last minutes.
 */
export function Rooms({
  rooms,
  connections,
  counts,
  focused,
  safeMode,
  onOpen,
}: {
  rooms: HqRoom[];
  connections: { from: string; to: string }[];
  counts: Map<string, number>;
  focused: string | null;
  safeMode: boolean;
  onOpen: (roomId: string) => void;
}) {
  const now = Date.now();
  const shown = safeMode ? rooms.filter((r) => !isRecent(r, now)) : rooms;
  return (
    <Container sortableChildren={false}>
      {!safeMode && <Connections rooms={rooms} connections={connections} />}
      {shown.map((r) => (
        <Room
          key={r.id}
          room={r}
          count={counts.get(r.id) ?? 0}
          focused={focused === r.id}
          plain={safeMode}
          onOpen={onOpen}
        />
      ))}
    </Container>
  );
}
