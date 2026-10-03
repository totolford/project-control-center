// NEXUS addition: draws the NEXUS buildings over AI Town's map.
import * as PIXI from 'pixi.js';
import { Container, Graphics, Sprite, Text } from '@pixi/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { NexusZone, NexusZoneKind } from '../../data/nexusZones';
import { BuildingLayout, Part, SHEETS, Sheet, buildingLayout, signText } from './buildingLayout';

const textures = new Map<string, PIXI.Texture>();

function texture(sheet: Sheet, src: Part['src']): PIXI.Texture {
  const key = `${sheet}:${src.x},${src.y},${src.w},${src.h}`;
  let t = textures.get(key);
  if (!t) {
    const base = PIXI.BaseTexture.from(SHEETS[sheet], { scaleMode: PIXI.SCALE_MODES.NEAREST });
    t = new PIXI.Texture(base, new PIXI.Rectangle(src.x, src.y, src.w, src.h));
    textures.set(key, t);
  }
  return t;
}

function PartSprite({ part }: { part: Part }) {
  return (
    <Sprite
      texture={texture(part.sheet, part.src)}
      x={part.x}
      y={part.y}
      width={part.w}
      height={part.h}
      tint={part.tint ?? 0xffffff}
    />
  );
}

export const SIGN_FONT = 'VCR OSD Mono, monospace';

const signStyle = new PIXI.TextStyle({ fontFamily: SIGN_FONT, fontSize: 10, fill: 0x181425, fontWeight: 'bold' });
const purposeStyle = new PIXI.TextStyle({
  fontFamily: SIGN_FONT,
  fontSize: 9,
  fill: 0xffffff,
  stroke: 0x181425,
  strokeThickness: 3,
});

/** Pixel name sign: a wooden plank with the building's name. */
function Sign({ layout, label, count, hovered }: { layout: BuildingLayout; label: string; count: number; hovered: boolean }) {
  const text = count > 0 ? `${label} · ${count}` : label;
  const width = Math.max(40, text.length * 6.2 + 12);
  const { x, y, color } = layout.sign;
  const draw = useCallback(
    (g: PIXI.Graphics) => {
      g.clear();
      // Posts, plank, darker rim and a highlight line: flat pixel shapes only.
      g.beginFill(0x3f2832);
      g.drawRect(-width / 2 - 2, -12, width + 4, 16);
      g.endFill();
      g.beginFill(hovered ? 0xffe39a : color);
      g.drawRect(-width / 2, -10, width, 12);
      g.endFill();
      g.beginFill(0xffffff, 0.25);
      g.drawRect(-width / 2, -10, width, 2);
      g.endFill();
    },
    [width, color, hovered],
  );
  return (
    <Container x={x} y={y}>
      <Graphics draw={draw} />
      <Text
        text={text}
        anchor={{ x: 0.5, y: 0.5 }}
        y={-4}
        resolution={4}
        style={signStyle}
      />
    </Container>
  );
}

function Building({
  layout,
  count,
  onOpen,
}: {
  layout: BuildingLayout;
  count: number;
  onOpen: (zone: NexusZoneKind) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const down = useRef<{ x: number; y: number } | null>(null);
  const { bounds } = layout;
  const hitArea = useMemo(() => new PIXI.Rectangle(bounds.x, bounds.y, bounds.w, bounds.h), [bounds]);
  const drawOutline = useCallback(
    (g: PIXI.Graphics) => {
      g.clear();
      // Ground shadow under the front wall, and a highlight when hovered.
      g.beginFill(0x000000, 0.18);
      g.drawRect(bounds.x + 4, bounds.y + bounds.h - 2, bounds.w, 6);
      g.endFill();
      if (hovered) {
        g.lineStyle(2, 0xfec742, 0.9);
        g.drawRect(bounds.x - 1, bounds.y - 1, bounds.w + 2, bounds.h + 2);
      }
    },
    [bounds, hovered],
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
        if (d && Math.hypot(d.x - e.screenX, d.y - e.screenY) < 10) onOpen(layout.zone.id);
      }}
    >
      <Graphics draw={drawOutline} />
      {layout.base.map((p, i) => (
        <PartSprite key={i} part={p} />
      ))}
      {layout.awning && <PartSprite part={layout.awning} />}
      <PartSprite part={layout.door} />
      <Sign layout={layout} label={signText(layout.zone)} count={count} hovered={hovered} />
      {hovered && (
        <Text
          text={layout.zone.purpose}
          anchor={{ x: 0.5, y: 0 }}
          x={bounds.x + bounds.w / 2}
          y={bounds.y + bounds.h + 6}
          resolution={4}
          style={purposeStyle}
        />
      )}
    </Container>
  );
}

/**
 * All buildings. `counts` = real agents currently in each zone (from the
 * agent rows), shown on the sign.
 */
export function Buildings({
  zones,
  counts,
  onOpen,
}: {
  zones: NexusZone[];
  counts: Map<string, number>;
  onOpen: (zone: NexusZoneKind) => void;
}) {
  const layouts = useMemo(() => zones.map(buildingLayout), [zones]);
  return (
    <Container sortableChildren={false}>
      {layouts.map((l) => (
        <Building key={l.zone.id} layout={l} count={counts.get(l.zone.id) ?? 0} onOpen={onOpen} />
      ))}
    </Container>
  );
}
