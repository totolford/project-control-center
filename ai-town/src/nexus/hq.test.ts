// NEXUS addition: the NEXUS HQ map generator (data/nexusHq.ts).
import {
  HQ_FURNITURE,
  HQ_TILES,
  HqLayout,
  HqRoom,
  doorOf,
  generateHqMap,
  initialLayout,
  insideDoor,
  nearestWalkable,
  reachable,
  walkable,
} from '../../data/nexusHq';

function room(id: string, x: number, y: number, w: number, h: number, decor: string[] = [], over: Partial<HqRoom> = {}): HqRoom {
  return {
    id,
    name: id,
    kind: id,
    purpose: '',
    x,
    y,
    w,
    h,
    door: { x: x + Math.floor(w / 2), y: y + h - 1, side: 'bottom' },
    decor,
    ...over,
  };
}

/** The default building as NEXUS packs it (crates/pcc-world/src/hq/layout.rs). */
function defaultHq(): HqLayout {
  return {
    version: 1,
    revision: 1,
    locale: 'en',
    width: 50,
    height: 26,
    rooms: [
      room('central_hq', 2, 2, 12, 8, ['command_chair', 'table', 'mission_board'], { floor: 'carpet', wall: 'stone' }),
      room('coding_office', 16, 2, 10, 7, ['workstation', 'workstation', 'workstation', 'bookshelf'], { floor: 'wood' }),
      room('github_office', 28, 2, 9, 6, ['bookshelf', 'workstation', 'bookshelf'], { wall: 'brick' }),
      room('server_room', 39, 2, 9, 6, ['server_rack', 'server_rack', 'server_rack', 'server_rack'], { floor: 'grate', wall: 'dark' }),
      room('skill_shop', 2, 13, 8, 6, ['shop_counter', 'shelf']),
      room('review_room', 12, 13, 8, 6, ['table'], { floor: 'stone', wall: 'brick' }),
    ],
    connections: [],
  };
}

const center = (r: HqRoom) => ({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) });

describe('NEXUS HQ map', () => {
  test('walls block, doors and corridors are walkable, every room is reachable', () => {
    const layout = defaultHq();
    const { map, dropped } = generateHqMap(layout);
    expect(dropped).toEqual([]);
    expect(map.width).toBe(50);
    expect(map.bgTiles[0].length).toBe(50);
    expect(map.bgTiles[0][0].length).toBe(26);
    // Outer wall.
    for (let x = 0; x < map.width; x++) {
      expect(walkable(map, x, 0)).toBe(false);
      expect(walkable(map, x, map.height - 1)).toBe(false);
    }
    const hq = layout.rooms[0];
    const fromHq = reachable(map, insideDoor(hq));
    for (const r of layout.rooms) {
      const d = doorOf(r);
      expect(walkable(map, d.x, d.y)).toBe(true);
      expect(map.bgTiles[0][d.x][d.y]).toBe(HQ_TILES.floor_threshold);
      // Every wall tile except the door blocks.
      for (let x = r.x; x < r.x + r.w; x++) {
        for (const y of [r.y, r.y + r.h - 1]) {
          if (x === d.x && y === d.y) continue;
          expect(walkable(map, x, y)).toBe(false);
        }
      }
      for (let y = r.y; y < r.y + r.h; y++) {
        for (const x of [r.x, r.x + r.w - 1]) {
          if (x === d.x && y === d.y) continue;
          expect(walkable(map, x, y)).toBe(false);
        }
      }
      expect(fromHq.has(`${insideDoor(r).x},${insideDoor(r).y}`)).toBe(true);
    }
    // A room's interior is only reachable through its door: close it and it is sealed.
    const sealed = generateHqMap(layout).map;
    const d = doorOf(layout.rooms[3]);
    sealed.objectTiles[0][d.x][d.y] = HQ_TILES.wall_dark_face;
    const after = reachable(sealed, insideDoor(hq));
    expect(after.has(`${center(layout.rooms[3]).x},${center(layout.rooms[3]).y}`)).toBe(false);
  });

  test('every free interior tile of a room is connected (furniture never splits a room)', () => {
    const layout = defaultHq();
    const { map, spots } = generateHqMap(layout);
    for (const r of layout.rooms) {
      const seen = reachable(map, insideDoor(r));
      for (const s of spots[r.id]) {
        expect(seen.has(`${s.x},${s.y}`)).toBe(true);
        expect(walkable(map, s.x, s.y)).toBe(true);
      }
      expect(spots[r.id].length).toBeGreaterThan(3);
      // The tile inside the door is never a standing spot.
      const e = insideDoor(r);
      expect(spots[r.id].some((s) => s.x === e.x && s.y === e.y)).toBe(false);
    }
  });

  test('furniture is drawn whole, blocks, and what does not fit is reported', () => {
    const layout: HqLayout = { ...defaultHq(), rooms: [room('tiny', 2, 2, 6, 5, ['shop_counter', 'shop_counter', 'chest', 'jacuzzi'])] };
    const { map, skipped } = generateHqMap(layout);
    // Interior columns 3..6: first and last kept free → 2 columns: no 3-wide counter fits.
    expect(skipped.tiny).toEqual(['shop_counter', 'shop_counter', 'jacuzzi']);
    let tiles = 0;
    for (let x = 0; x < map.width; x++) for (let y = 0; y < map.height; y++) if (map.objectTiles[1][x][y] !== -1) tiles++;
    expect(tiles).toBe(HQ_FURNITURE.chest.w * HQ_FURNITURE.chest.h);
    const { map: m2 } = generateHqMap({ ...defaultHq(), rooms: [room('r', 2, 2, 10, 6, ['table'])] });
    expect(m2.objectTiles[1][4][3]).toBe(HQ_TILES.table);
    expect(m2.objectTiles[1][5][4]).toBe(HQ_TILES.table + 3);
    expect(walkable(m2, 4, 3)).toBe(false);
  });

  test('invalid rooms are dropped, never drawn over others', () => {
    const layout: HqLayout = {
      ...defaultHq(),
      rooms: [room('a', 2, 2, 8, 6), room('overlap', 4, 4, 8, 6), room('outside', 45, 2, 9, 6), room('flat', 20, 2, 3, 3)],
    };
    const { dropped, spots } = generateHqMap(layout);
    expect(dropped).toEqual(['overlap', 'outside', 'flat']);
    expect(Object.keys(spots)).toEqual(['a']);
  });

  test('a door not on the wall is put back at the bottom middle; side doors work', () => {
    const bad = room('r', 2, 2, 8, 6, [], { door: { x: 40, y: 40, side: 'top' } });
    expect(doorOf(bad)).toEqual({ x: 6, y: 7, side: 'bottom' });
    const left = room('l', 6, 4, 8, 6, ['bookshelf'], { door: { x: 6, y: 7, side: 'left' } });
    const { map } = generateHqMap({ ...defaultHq(), rooms: [room('central_hq', 20, 2, 10, 6), left] });
    expect(walkable(map, 6, 7)).toBe(true);
    expect(reachable(map, { x: 25, y: 10 }).has('7,7')).toBe(true);
  });

  test('characters left in a new wall are moved to the nearest walkable tile', () => {
    const { map } = generateHqMap(defaultHq());
    expect(nearestWalkable(map, { x: 2, y: 2 })).not.toBeNull();
    const p = nearestWalkable(map, { x: 2.4, y: 2.2 })!;
    expect(walkable(map, p.x, p.y)).toBe(true);
    expect(Math.abs(p.x - 2) + Math.abs(p.y - 2)).toBeLessThanOrEqual(2);
  });

  test('the initial building is valid', () => {
    const { map, dropped, spots } = generateHqMap(initialLayout());
    expect(dropped).toEqual([]);
    expect(spots.central_hq.length).toBeGreaterThan(10);
    expect(map.tileSetUrl).toBe('/ai-town/assets/nexus-hq.png');
  });
});
