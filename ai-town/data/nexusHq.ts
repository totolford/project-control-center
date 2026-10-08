// NEXUS addition: the AI World as ONE building, NEXUS HQ.
//
// NEXUS (crates/pcc-world/src/hq) owns the layout: rooms (rectangles in
// tiles, walls included), one door per room, functional furniture. This file
// turns that layout into a real AI Town map (bg / object tile layers): floors
// everywhere, room walls and furniture in the object layer — the engine
// blocks every object tile (convex/aiTown/movement.ts `blockedWithPositions`),
// so characters walk through doors and corridors, never through walls.
//
// Tiles come from public/assets/nexus-hq.png, built from AI Town's own
// rpg-tileset.png by scripts/nexus_hq_tileset.py (same order as HQ_TILES).

export const HQ_TILESET = {
  url: '/ai-town/assets/nexus-hq.png',
  width: 512,
  height: 96,
  tileDim: 32,
};

/** Tile indices in nexus-hq.png (16 columns). Never reorder: append. */
export const HQ_TILES = {
  floor_wood: 0,
  floor_darkwood: 1,
  floor_stone: 2,
  floor_carpet: 3,
  floor_tiles: 4,
  floor_grate: 5,
  floor_corridor: 6,
  floor_threshold: 7,
  wall_plaster_face: 8,
  wall_plaster_top: 9,
  wall_brick_face: 10,
  wall_brick_top: 11,
  wall_stone_face: 12,
  wall_stone_top: 13,
  wall_dark_face: 14,
  wall_dark_top: 15,
  workstation: 16,
  server_rack: 17,
  bookshelf: 19,
  shelf: 21,
  table: 23,
  shop_counter: 27,
  chest: 33,
  command_chair: 34,
  mission_board: 36,
} as const;

/** Functional furniture: footprint in tiles; tiles are laid out row by row from `HQ_TILES[id]`. */
export const HQ_FURNITURE: Record<string, { w: number; h: number }> = {
  workstation: { w: 1, h: 1 },
  server_rack: { w: 1, h: 2 },
  bookshelf: { w: 1, h: 2 },
  shelf: { w: 1, h: 2 },
  table: { w: 2, h: 2 },
  shop_counter: { w: 3, h: 2 },
  chest: { w: 1, h: 1 },
  command_chair: { w: 1, h: 2 },
  mission_board: { w: 1, h: 1 },
};

export const HQ_FLOORS = ['wood', 'darkwood', 'stone', 'carpet', 'tiles', 'grate'] as const;
export const HQ_WALLS = ['plaster', 'brick', 'stone', 'dark'] as const;

export type DoorSide = 'bottom' | 'top' | 'left' | 'right';

/** A room as NEXUS sends it (crates/pcc-world/src/hq/mod.rs `LayoutRoom`). */
export type HqRoom = {
  id: string;
  name: string;
  kind: string;
  purpose: string;
  x: number;
  y: number;
  w: number;
  h: number;
  door: { x: number; y: number; side: DoorSide };
  decor: string[];
  floor?: string;
  wall?: string;
  temporary?: boolean;
  createdAt?: string;
};

export type HqLayout = {
  version: number;
  revision: number;
  locale: string;
  width: number;
  height: number;
  rooms: HqRoom[];
  connections: { from: string; to: string }[];
};

export type Point = { x: number; y: number };

export type HqMap = {
  width: number;
  height: number;
  tileSetUrl: string;
  tileSetDimX: number;
  tileSetDimY: number;
  tileDim: number;
  /** `layer[x][y]` (AI Town's convention). */
  bgTiles: number[][][];
  objectTiles: number[][][];
  animatedSprites: never[];
};

export type HqPlan = {
  map: HqMap;
  /** Room id → interior tiles where characters may stand, best first. */
  spots: Record<string, Point[]>;
  /** Furniture that did not fit (room id → ids), reported, never drawn half. */
  skipped: Record<string, string[]>;
  /** Rooms dropped because they were invalid (outside the map, overlapping). */
  dropped: string[];
};

export const MAX_SIZE = { w: 128, h: 96 };
const MIN_SIZE = { w: 12, h: 10 };

function grid(w: number, h: number, v: number): number[][] {
  return Array.from({ length: w }, () => new Array<number>(h).fill(v));
}

/** Interior bounds, walls excluded: x0 <= x < x1, y0 <= y < y1. */
export function interior(r: Pick<HqRoom, 'x' | 'y' | 'w' | 'h'>) {
  return { x0: r.x + 1, y0: r.y + 1, x1: r.x + r.w - 1, y1: r.y + r.h - 1 };
}

/** The door, forced onto the room's wall (bottom middle when the given one is not on it). */
export function doorOf(r: HqRoom): { x: number; y: number; side: DoorSide } {
  const d = r.door;
  const onWall =
    d &&
    ((d.side === 'bottom' && d.y === r.y + r.h - 1 && d.x > r.x && d.x < r.x + r.w - 1) ||
      (d.side === 'top' && d.y === r.y && d.x > r.x && d.x < r.x + r.w - 1) ||
      (d.side === 'left' && d.x === r.x && d.y > r.y && d.y < r.y + r.h - 1) ||
      (d.side === 'right' && d.x === r.x + r.w - 1 && d.y > r.y && d.y < r.y + r.h - 1));
  return onWall ? d : { x: r.x + Math.floor(r.w / 2), y: r.y + r.h - 1, side: 'bottom' };
}

/** The interior tile just inside the door. */
export function insideDoor(r: HqRoom): Point {
  const d = doorOf(r);
  switch (d.side) {
    case 'bottom':
      return { x: d.x, y: d.y - 1 };
    case 'top':
      return { x: d.x, y: d.y + 1 };
    case 'left':
      return { x: d.x + 1, y: d.y };
    case 'right':
      return { x: d.x - 1, y: d.y };
  }
}

/** Rooms that can be drawn: inside the map (outer wall excluded), at least 5x5, not overlapping. */
export function drawableRooms(layout: HqLayout): { rooms: HqRoom[]; dropped: string[] } {
  const rooms: HqRoom[] = [];
  const dropped: string[] = [];
  const W = layout.width;
  const H = layout.height;
  for (const r of layout.rooms) {
    const ok =
      Number.isInteger(r.x) &&
      Number.isInteger(r.y) &&
      Number.isInteger(r.w) &&
      Number.isInteger(r.h) &&
      r.w >= 5 &&
      r.h >= 5 &&
      r.x >= 1 &&
      r.y >= 1 &&
      r.x + r.w <= W - 1 &&
      r.y + r.h <= H - 1 &&
      !rooms.some((o) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h);
    if (ok) rooms.push(r);
    else dropped.push(r.id);
  }
  return { rooms, dropped };
}

function floorTile(floor: string | undefined): number {
  const key = `floor_${floor}` as keyof typeof HQ_TILES;
  return (HQ_FLOORS as readonly string[]).includes(floor ?? '') ? HQ_TILES[key] : HQ_TILES.floor_wood;
}

function wallTiles(wall: string | undefined): { face: number; top: number } {
  const w = (HQ_WALLS as readonly string[]).includes(wall ?? '') ? wall : 'plaster';
  return {
    face: HQ_TILES[`wall_${w}_face` as keyof typeof HQ_TILES],
    top: HQ_TILES[`wall_${w}_top` as keyof typeof HQ_TILES],
  };
}

/**
 * Builds the AI Town map of the building.
 *
 * Furniture stands against the room's back wall (top interior rows), never
 * in front of the door and never in the first / last interior column, so the
 * interior always stays one connected walkable area.
 */
export function generateHqMap(layout: HqLayout): HqPlan {
  const W = Math.max(MIN_SIZE.w, Math.min(MAX_SIZE.w, Math.floor(layout.width) || 0));
  const H = Math.max(MIN_SIZE.h, Math.min(MAX_SIZE.h, Math.floor(layout.height) || 0));
  const { rooms, dropped } = drawableRooms({ ...layout, width: W, height: H });

  const bg = grid(W, H, HQ_TILES.floor_corridor);
  const walls = grid(W, H, -1);
  const furniture = grid(W, H, -1);
  /** Wall material per tile, to pick face / top afterwards. */
  const wallOf: (({ face: number; top: number }) | null)[][] = Array.from({ length: W }, () => new Array(H).fill(null));
  const outer = wallTiles('stone');

  for (let x = 0; x < W; x++) {
    wallOf[x][0] = outer;
    wallOf[x][H - 1] = outer;
  }
  for (let y = 0; y < H; y++) {
    wallOf[0][y] = outer;
    wallOf[W - 1][y] = outer;
  }

  const spots: Record<string, Point[]> = {};
  const skipped: Record<string, string[]> = {};
  for (const r of rooms) {
    const floor = floorTile(r.floor);
    const material = wallTiles(r.wall);
    for (let x = r.x; x < r.x + r.w; x++) {
      for (let y = r.y; y < r.y + r.h; y++) {
        bg[x][y] = floor;
        const edge = x === r.x || y === r.y || x === r.x + r.w - 1 || y === r.y + r.h - 1;
        if (edge) wallOf[x][y] = material;
      }
    }
    const door = doorOf(r);
    wallOf[door.x][door.y] = null;
    bg[door.x][door.y] = HQ_TILES.floor_threshold;

    // Furniture along the back wall.
    const inn = interior(r);
    const keepFree = new Set<number>([inn.x0, inn.x1 - 1]);
    if (door.side === 'top') keepFree.add(door.x);
    const maxH = Math.max(1, inn.y1 - inn.y0 - 1);
    let cx = inn.x0 + 1;
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const id of r.decor) {
      const f = HQ_FURNITURE[id];
      const base = HQ_TILES[id as keyof typeof HQ_TILES];
      if (!f || base === undefined || f.h > maxH) {
        (skipped[r.id] ??= []).push(id);
        continue;
      }
      // Next run of `f.w` columns not reserved.
      while (cx + f.w <= inn.x1 && [...Array(f.w).keys()].some((i) => keepFree.has(cx + i))) cx++;
      if (cx + f.w > inn.x1) {
        (skipped[r.id] ??= []).push(id);
        continue;
      }
      for (let j = 0; j < f.h; j++) {
        for (let i = 0; i < f.w; i++) {
          furniture[cx + i][inn.y0 + j] = base + j * f.w + i;
        }
      }
      placed.push({ x: cx, y: inn.y0, w: f.w, h: f.h });
      cx += f.w;
    }

    // Standing spots: free interior tiles, nearest to the room's center
    // first, the tile inside the door last (keep the doorway clear).
    const center = { x: (inn.x0 + inn.x1 - 1) / 2, y: (inn.y0 + inn.y1 - 1) / 2 + 0.5 };
    const entry = insideDoor(r);
    const free: Point[] = [];
    for (let x = inn.x0; x < inn.x1; x++) {
      for (let y = inn.y0; y < inn.y1; y++) {
        if (furniture[x][y] !== -1) continue;
        if (x === entry.x && y === entry.y) continue;
        free.push({ x, y });
      }
    }
    free.sort(
      (a, b) =>
        Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y) ||
        a.y - b.y ||
        a.x - b.x,
    );
    spots[r.id] = free.length > 0 ? free : [entry];
  }

  // Walls seen from the front (a walkable tile below) show their face.
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const m = wallOf[x][y];
      if (!m) continue;
      const below = y + 1 < H ? wallOf[x][y + 1] : outer;
      walls[x][y] = below ? m.top : m.face;
    }
  }

  return {
    map: {
      width: W,
      height: H,
      tileSetUrl: HQ_TILESET.url,
      tileSetDimX: HQ_TILESET.width,
      tileSetDimY: HQ_TILESET.height,
      tileDim: HQ_TILESET.tileDim,
      bgTiles: [bg],
      objectTiles: [walls, furniture],
      animatedSprites: [],
    },
    spots,
    skipped,
    dropped,
  };
}

/** Walkable = no object tile (exactly the engine's rule, without characters). */
export function walkable(map: Pick<HqMap, 'width' | 'height' | 'objectTiles'>, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  return map.objectTiles.every((layer) => layer[x][y] === -1);
}

/** Tiles reachable from `start` (4-connected), as "x,y" keys. */
export function reachable(map: Pick<HqMap, 'width' | 'height' | 'objectTiles'>, start: Point): Set<string> {
  const seen = new Set<string>();
  if (!walkable(map, start.x, start.y)) return seen;
  const queue: Point[] = [start];
  seen.add(`${start.x},${start.y}`);
  while (queue.length > 0) {
    const p = queue.shift()!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const n = { x: p.x + dx, y: p.y + dy };
      const k = `${n.x},${n.y}`;
      if (!seen.has(k) && walkable(map, n.x, n.y)) {
        seen.add(k);
        queue.push(n);
      }
    }
  }
  return seen;
}

/** The nearest walkable tile to `p` (itself when walkable), for characters left inside a new wall. */
export function nearestWalkable(map: Pick<HqMap, 'width' | 'height' | 'objectTiles'>, p: Point): Point | null {
  const sx = Math.round(p.x);
  const sy = Math.round(p.y);
  for (let r = 0; r < Math.max(map.width, map.height); r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (walkable(map, sx + dx, sy + dy)) return { x: sx + dx, y: sy + dy };
      }
    }
  }
  return null;
}

/**
 * The building used before NEXUS sends its own layout (a fresh world): NEXUS
 * HQ only. NEXUS replaces it with the project's rooms on its first sync.
 */
export function initialLayout(name = 'NEXUS HQ'): HqLayout {
  return {
    version: 1,
    revision: 0,
    locale: 'en',
    width: 36,
    height: 22,
    rooms: [
      {
        id: 'central_hq',
        name,
        kind: 'central_hq',
        purpose: 'Central plans and orchestrates missions',
        x: 2,
        y: 2,
        w: 12,
        h: 8,
        door: { x: 8, y: 9, side: 'bottom' },
        decor: ['command_chair', 'table', 'mission_board'],
        floor: 'carpet',
        wall: 'stone',
      },
    ],
    connections: [],
  };
}
