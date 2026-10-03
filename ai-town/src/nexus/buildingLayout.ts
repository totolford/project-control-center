// NEXUS addition: the NEXUS buildings, composed from the tilesets AI Town
// already ships (public/assets/magecity.png and rpg-tileset.png). Pure layout:
// Buildings.tsx turns the parts into PIXI sprites.
import type { NexusZone, NexusZoneKind } from '../../data/nexusZones';

export const SHEETS = {
  mage: '/ai-town/assets/magecity.png',
  rpg: '/ai-town/assets/rpg-tileset.png',
} as const;
export type Sheet = keyof typeof SHEETS;

export type Rect = { x: number; y: number; w: number; h: number };

export type Part = {
  sheet: Sheet;
  src: Rect;
  /** Destination in world pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  tint?: number;
};

const T = 32;
const r = (x: number, y: number, w = T, h = T): Rect => ({ x, y, w, h });

/** Wall materials: [top row, bottom row] x [left, middle, right]. */
const WALLS = {
  sandstone: {
    sheet: 'mage',
    rows: [
      [r(0, 128), r(32, 128), r(64, 128)],
      [r(0, 160), r(32, 160), r(64, 160)],
    ],
  },
  greybrick: {
    sheet: 'mage',
    rows: [
      [r(128, 864), r(160, 864), r(192, 864)],
      [r(128, 896), r(160, 896), r(192, 896)],
    ],
  },
  plaster: { sheet: 'rpg', rows: [[r(1184, 704)], [r(1184, 704)]] },
  brick: { sheet: 'rpg', rows: [[r(1312, 704)], [r(1312, 704)]] },
  stone: { sheet: 'rpg', rows: [[r(1440, 704)], [r(1440, 704)]] },
  bluestone: { sheet: 'rpg', rows: [[r(1344, 800)], [r(1344, 800)]] },
} satisfies Record<string, { sheet: Sheet; rows: Rect[][] }>;
type Wall = keyof typeof WALLS;

/** Hip roofs (3x3 pieces of 32px) in magecity.png. */
const ROOFS = { wood: { x: 0, y: 736 }, moss: { x: 160, y: 736 } };
type Roof = keyof typeof ROOFS;

export const PROPS = {
  doorWood: { sheet: 'rpg' as Sheet, src: r(1360, 486, 32, 54) },
  doorMetal: { sheet: 'rpg' as Sheet, src: r(1392, 486, 32, 54) },
  awning: { sheet: 'rpg' as Sheet, src: r(896, 568, 96, 48) },
  lamp: { sheet: 'rpg' as Sheet, src: r(1028, 634, 24, 72) },
  barrel: { sheet: 'rpg' as Sheet, src: r(964, 472, 26, 24) },
  flowers: { sheet: 'rpg' as Sheet, src: r(994, 504, 28, 24) },
  flowersBlue: { sheet: 'rpg' as Sheet, src: r(1026, 504, 28, 24) },
  chest: { sheet: 'rpg' as Sheet, src: r(864, 760, 32, 22) },
  statue: { sheet: 'rpg' as Sheet, src: r(928, 504, 32, 60) },
};
const WINDOWS = {
  framed: { sheet: 'mage' as Sheet, src: r(96, 685, 32, 33) },
  tall: { sheet: 'mage' as Sheet, src: r(33, 616, 31, 42) },
  double: { sheet: 'mage' as Sheet, src: r(195, 699, 28, 27) },
};

type Style = {
  wall: Wall;
  roof: Roof;
  /** Multiplied into the roof sprites, to tell buildings apart. */
  roofTint: number;
  door: 'doorWood' | 'doorMetal';
  window: keyof typeof WINDOWS;
  /** Props standing against the front wall, by side of the door. */
  props?: (keyof typeof PROPS)[];
  /** Sign color (wood plank tint). */
  sign: number;
};

export const STYLES: Record<NexusZoneKind, Style> = {
  central_hq: { wall: 'greybrick', roof: 'moss', roofTint: 0xffd27a, door: 'doorWood', window: 'framed', props: ['lamp', 'statue', 'lamp'], sign: 0xfec742 },
  coding_office: { wall: 'sandstone', roof: 'wood', roofTint: 0x9fb8ff, door: 'doorWood', window: 'tall', sign: 0xb86f50 },
  design_studio: { wall: 'plaster', roof: 'wood', roofTint: 0xffa8d8, door: 'doorWood', window: 'framed', props: ['flowers', 'flowersBlue'], sign: 0xb86f50 },
  roblox_studio: { wall: 'brick', roof: 'wood', roofTint: 0xff8a7a, door: 'doorWood', window: 'double', sign: 0xb86f50 },
  github_office: { wall: 'stone', roof: 'wood', roofTint: 0xa8a8c0, door: 'doorMetal', window: 'double', sign: 0xb86f50 },
  server_room: { wall: 'bluestone', roof: 'moss', roofTint: 0x9fd0e0, door: 'doorMetal', window: 'double', props: ['barrel'], sign: 0xb86f50 },
  mcp_lab: { wall: 'greybrick', roof: 'moss', roofTint: 0xa8f0b0, door: 'doorMetal', window: 'tall', sign: 0xb86f50 },
  skill_shop: { wall: 'plaster', roof: 'wood', roofTint: 0xffc880, door: 'doorWood', window: 'framed', props: ['barrel', 'chest'], sign: 0xfec742 },
  testing_lab: { wall: 'sandstone', roof: 'moss', roofTint: 0xeaff9a, door: 'doorMetal', window: 'tall', sign: 0xb86f50 },
  review_room: { wall: 'brick', roof: 'wood', roofTint: 0xd4b0ff, door: 'doorWood', window: 'framed', sign: 0xb86f50 },
  archive: { wall: 'bluestone', roof: 'moss', roofTint: 0xd8d8d8, door: 'doorWood', window: 'double', props: ['chest', 'barrel'], sign: 0xb86f50 },
};

export type BuildingLayout = {
  zone: NexusZone;
  /** Roof, walls, windows, props (drawn first). */
  base: Part[];
  /** Door: drawn last so it stays in front of the wall and props. */
  door: Part;
  /** Awning of the shop, between the wall and the door. */
  awning?: Part;
  /** Where the name sign hangs (center, world px). */
  sign: { x: number; y: number; color: number };
  /** Whole building, world px (click / hover area). */
  bounds: Rect;
  wallTop: number;
};

function roofParts(zone: NexusZone, roofRows: number, style: Style): Part[] {
  const parts: Part[] = [];
  const origin = ROOFS[style.roof];
  const X = zone.x * T;
  const Y = zone.y * T;
  const piece = (col: number, row: number, dy0 = 0, h = T): Rect =>
    r(origin.x + col * T, origin.y + row * T + dy0, T, h);
  for (let i = 0; i < zone.w; i++) {
    const col = i === 0 ? 0 : i === zone.w - 1 ? 2 : 1;
    if (roofRows === 1) {
      // Too low for a full hip roof: ridge half on top of the eave half.
      parts.push({ sheet: 'mage', src: piece(col, 0, 0, T / 2), x: X + i * T, y: Y, w: T, h: T / 2, tint: style.roofTint });
      parts.push({ sheet: 'mage', src: piece(col, 2, T / 2, T / 2), x: X + i * T, y: Y + T / 2, w: T, h: T / 2, tint: style.roofTint });
      continue;
    }
    for (let j = 0; j < roofRows; j++) {
      const row = j === 0 ? 0 : j === roofRows - 1 ? 2 : 1;
      parts.push({ sheet: 'mage', src: piece(col, row), x: X + i * T, y: Y + j * T, w: T, h: T, tint: style.roofTint });
    }
  }
  return parts;
}

/** Layout of a zone's building inside its rectangle (2 rows of wall, the rest roof). */
export function buildingLayout(zone: NexusZone): BuildingLayout {
  const style = STYLES[zone.id];
  const X = zone.x * T;
  const Y = zone.y * T;
  const wallRows = 2;
  const roofRows = Math.max(1, zone.h - wallRows);
  const wallTop = Y + roofRows * T;
  const base: Part[] = roofParts(zone, roofRows, style);

  const wall = WALLS[style.wall];
  for (let j = 0; j < wallRows; j++) {
    const pieces = wall.rows[j];
    for (let i = 0; i < zone.w; i++) {
      const src =
        pieces.length === 1 ? pieces[0] : i === 0 ? pieces[0] : i === zone.w - 1 ? pieces[2] : pieces[1];
      base.push({ sheet: wall.sheet, src, x: X + i * T, y: wallTop + j * T, w: T, h: T });
    }
  }

  // The door column is the zone's door tile, clamped inside the front wall.
  const doorCol = Math.min(zone.x + zone.w - 1, Math.max(zone.x, zone.door.x));
  const doorX = doorCol * T;
  const doorSrc = PROPS[style.door].src;
  const door: Part = {
    sheet: PROPS[style.door].sheet,
    src: doorSrc,
    x: doorX,
    y: Y + zone.h * T - doorSrc.h,
    w: doorSrc.w,
    h: doorSrc.h,
  };

  // Windows on the free columns (not the door, not next to it, not the edges).
  const win = WINDOWS[style.window];
  const freeCols: number[] = [];
  for (let c = zone.x + 1; c < zone.x + zone.w - 1; c++) {
    if (Math.abs(c - doorCol) >= 2) freeCols.push(c);
  }
  for (const c of freeCols.filter((_, k) => k % 2 === 0)) {
    base.push({
      sheet: win.sheet,
      src: win.src,
      x: c * T + Math.floor((T - win.src.w) / 2),
      y: wallTop + 6,
      w: win.src.w,
      h: win.src.h,
    });
  }

  // Props on the ground line, alternating around the door.
  const used = new Set([doorCol, ...freeCols.filter((_, k) => k % 2 === 0)]);
  const propCols: number[] = [];
  for (let c = zone.x; c < zone.x + zone.w; c++) {
    if (c !== doorCol && !used.has(c)) propCols.push(c);
  }
  (style.props ?? []).forEach((name, k) => {
    // Nearest free columns to the door first, alternating left / right.
    const sorted = [...propCols].sort((a, b) => Math.abs(a - doorCol) - Math.abs(b - doorCol));
    const c = sorted[k];
    if (c === undefined) return;
    const p = PROPS[name];
    base.push({
      sheet: p.sheet,
      src: p.src,
      x: c * T + Math.floor((T - p.src.w) / 2),
      y: Y + zone.h * T - p.src.h,
      w: p.src.w,
      h: p.src.h,
    });
  });

  let awning: Part | undefined;
  if (zone.id === 'skill_shop') {
    const a = PROPS.awning.src;
    awning = {
      sheet: 'rpg',
      src: a,
      x: doorX + T / 2 - a.w / 2,
      y: wallTop - 6,
      w: a.w,
      h: a.h,
    };
  }

  return {
    zone,
    base,
    door,
    awning,
    sign: { x: X + (zone.w * T) / 2, y: wallTop - 2, color: style.sign },
    bounds: r(X, Y, zone.w * T, zone.h * T),
    wallTop,
  };
}

/** Text of a building's sign: the Skill Shop advertises SKILLS. */
export function signText(zone: NexusZone): string {
  return zone.id === 'skill_shop' ? 'SKILLS' : zone.name.toUpperCase();
}
