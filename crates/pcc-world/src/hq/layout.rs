//! Geometry of the building: where rooms go, where their doors are, and a
//! walkability grid to check that every room can be reached.
//!
//! Tiles: the building's outer wall is the map border; rooms are rectangles
//! whose perimeter is wall except one door tile; everything else is corridor.

use std::collections::VecDeque;

use serde::Serialize;

use super::config::{Point, Room, Size, WorldConfig};

pub const MIN_W: u32 = 6;
pub const MIN_H: u32 = 5;
pub const MAX_W: u32 = 24;
pub const MAX_H: u32 = 16;
/// Largest building, tiles.
pub const MAX_BUILDING: (u32, u32) = (128, 96);
/// Corridor between two rooms side by side.
const GAP_X: i32 = 2;
/// Corridor below a row of rooms (their doors open on it).
const GAP_Y: i32 = 3;
/// Rooms start after the outer wall and one corridor tile.
const MARGIN: i32 = 2;
const MIN_BUILDING: (u32, u32) = (36, 22);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Bottom,
    Top,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct Door {
    pub x: i32,
    pub y: i32,
    pub side: Side,
}

/// Places the rooms: re-packs everything in `auto` layout, only the rooms not
/// placed yet in `manual` layout. Returns the building size.
pub fn arrange(cfg: &mut WorldConfig) -> Size {
    for r in cfg.rooms.iter_mut() {
        r.size.w = r.size.w.clamp(MIN_W, MAX_W);
        r.size.h = r.size.h.clamp(MIN_H, MAX_H);
    }
    if cfg.layout != "manual" {
        pack(cfg);
    } else {
        let ids: Vec<String> = cfg.rooms.iter().filter(|r| r.active() && r.unplaced).map(|r| r.id.clone()).collect();
        for id in ids {
            let spot = free_spot(cfg, &id);
            if let Some(r) = cfg.room_mut(&id) {
                r.position = spot;
                r.unplaced = false;
            }
        }
    }
    building_size(cfg)
}

/// Shelf packing in creation order, NEXUS HQ first.
fn pack(cfg: &mut WorldConfig) {
    let mut order: Vec<usize> = (0..cfg.rooms.len()).filter(|&i| cfg.rooms[i].active()).collect();
    order.sort_by_key(|&i| if cfg.rooms[i].kind == "central_hq" { 0 } else { 1 });
    let area: u32 = order.iter().map(|&i| (cfg.rooms[i].size.w + 2) * (cfg.rooms[i].size.h + 3)).sum();
    let widest = order.iter().map(|&i| cfg.rooms[i].size.w).max().unwrap_or(MIN_W);
    // Inner width: a 16:10-ish building, in steps of 8 so one more room rarely reshuffles all.
    let target = ((area as f64 * 1.7).sqrt().ceil() as u32).div_ceil(8) * 8;
    let inner = target.max(widest).max(MIN_BUILDING.0 - 2 * MARGIN as u32) as i32;
    let (mut x, mut y, mut shelf_h) = (MARGIN, MARGIN, 0i32);
    for i in order {
        let r = &mut cfg.rooms[i];
        let (w, h) = (r.size.w as i32, r.size.h as i32);
        if x > MARGIN && x + w > MARGIN + inner {
            x = MARGIN;
            y += shelf_h + GAP_Y;
            shelf_h = 0;
        }
        r.position = Point { x, y };
        r.unplaced = false;
        x += w + GAP_X;
        shelf_h = shelf_h.max(h);
    }
}

/// Building size: room bounding box plus corridors and the outer wall.
pub fn building_size(cfg: &WorldConfig) -> Size {
    let (mut w, mut h) = (MIN_BUILDING.0 as i32, MIN_BUILDING.1 as i32);
    for r in cfg.active_rooms() {
        let (_, _, x1, y1) = r.rect();
        w = w.max(x1 + MARGIN);
        h = h.max(y1 + GAP_Y + 1);
    }
    Size { w: (w as u32).min(MAX_BUILDING.0), h: (h as u32).min(MAX_BUILDING.1) }
}

fn overlaps_with_margin(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32), margin: i32) -> bool {
    a.0 - margin < b.2 && b.0 < a.2 + margin && a.1 - margin < b.3 && b.1 < a.3 + margin
}

/// First spot (reading order) where a room fits with a corridor around it.
fn free_spot(cfg: &WorldConfig, id: &str) -> Point {
    let Some(room) = cfg.room(id) else { return Point { x: MARGIN, y: MARGIN } };
    let (w, h) = (room.size.w as i32, room.size.h as i32);
    let size = building_size(cfg);
    let others: Vec<_> = cfg.active_rooms().filter(|r| r.id != id && !r.unplaced).map(Room::rect).collect();
    let max_y = size.h as i32 + h + GAP_Y;
    for y in MARGIN..max_y {
        for x in MARGIN..=(size.w as i32 - MARGIN - w).max(MARGIN) {
            let rect = (x, y, x + w, y + h);
            if !others.iter().any(|o| overlaps_with_margin(rect, *o, GAP_X.max(GAP_Y))) {
                return Point { x, y };
            }
        }
    }
    Point { x: MARGIN, y: max_y }
}

/// Is the tile inside a room's rectangle (walls included)?
fn in_any_room(cfg: &WorldConfig, x: i32, y: i32) -> bool {
    cfg.active_rooms().any(|r| {
        let (x0, y0, x1, y1) = r.rect();
        x >= x0 && x < x1 && y >= y0 && y < y1
    })
}

/// The door of a room: middle of the bottom wall, or another side when the
/// tile in front of it is not corridor.
pub fn door(cfg: &WorldConfig, r: &Room) -> Door {
    let size = building_size(cfg);
    let (x0, y0, x1, y1) = r.rect();
    let (cx, cy) = (x0 + (r.size.w as i32) / 2, y0 + (r.size.h as i32) / 2);
    let candidates = [
        (Door { x: cx, y: y1 - 1, side: Side::Bottom }, (cx, y1)),
        (Door { x: cx, y: y0, side: Side::Top }, (cx, y0 - 1)),
        (Door { x: x0, y: cy, side: Side::Left }, (x0 - 1, cy)),
        (Door { x: x1 - 1, y: cy, side: Side::Right }, (x1, cy)),
    ];
    let open = |(x, y): (i32, i32)| {
        x > 0 && y > 0 && x < size.w as i32 - 1 && y < size.h as i32 - 1 && !in_any_room(cfg, x, y)
    };
    candidates.iter().find(|(_, front)| open(*front)).map(|(d, _)| *d).unwrap_or(candidates[0].0)
}

/// Walkability: `true` = floor. Furniture is not included (the map generator
/// keeps every room's floor connected).
pub struct Grid {
    pub w: i32,
    pub h: i32,
    pub floor: Vec<bool>,
}

impl Grid {
    pub fn of(cfg: &WorldConfig) -> Grid {
        let size = building_size(cfg);
        let (w, h) = (size.w as i32, size.h as i32);
        let mut floor = vec![true; (w * h) as usize];
        let mut set = |x: i32, y: i32, v: bool| {
            if x >= 0 && y >= 0 && x < w && y < h {
                floor[(y * w + x) as usize] = v;
            }
        };
        for x in 0..w {
            set(x, 0, false);
            set(x, h - 1, false);
        }
        for y in 0..h {
            set(0, y, false);
            set(w - 1, y, false);
        }
        for r in cfg.active_rooms() {
            let (x0, y0, x1, y1) = r.rect();
            for x in x0..x1 {
                set(x, y0, false);
                set(x, y1 - 1, false);
            }
            for y in y0..y1 {
                set(x0, y, false);
                set(x1 - 1, y, false);
            }
            let d = door(cfg, r);
            set(d.x, d.y, true);
        }
        Grid { w, h, floor }
    }

    pub fn is_floor(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && x < self.w && y < self.h && self.floor[(y * self.w + x) as usize]
    }

    /// Tiles reachable from `start` (4-connected).
    pub fn reach(&self, start: (i32, i32)) -> Vec<bool> {
        let mut seen = vec![false; self.floor.len()];
        if !self.is_floor(start.0, start.1) {
            return seen;
        }
        let mut q = VecDeque::from([start]);
        seen[(start.1 * self.w + start.0) as usize] = true;
        while let Some((x, y)) = q.pop_front() {
            for (nx, ny) in [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)] {
                if self.is_floor(nx, ny) && !seen[(ny * self.w + nx) as usize] {
                    seen[(ny * self.w + nx) as usize] = true;
                    q.push_back((nx, ny));
                }
            }
        }
        seen
    }
}

/// Rooms whose interior cannot be reached from NEXUS HQ's interior.
pub fn unreachable_rooms(cfg: &WorldConfig) -> Vec<String> {
    let grid = Grid::of(cfg);
    let Some(hq) = cfg.hq().or_else(|| cfg.active_rooms().next()) else { return vec![] };
    let center = |r: &Room| (r.position.x + r.size.w as i32 / 2, r.position.y + r.size.h as i32 / 2);
    let seen = grid.reach(center(hq));
    cfg.active_rooms()
        .filter(|r| {
            let (x, y) = center(r);
            !grid.is_floor(x, y) || !seen[(y * grid.w + x) as usize]
        })
        .map(|r| r.id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hq() -> WorldConfig {
        let mut c = WorldConfig::default();
        for k in ["central_hq", "coding_office", "github_office", "server_room", "skill_shop", "review_room"] {
            c.rooms.push(Room::of_kind(k, "en"));
        }
        c
    }

    #[test]
    fn packing_never_overlaps_and_every_room_is_reachable() {
        let mut c = hq();
        for i in 0..10 {
            let mut r = Room::of_kind("custom", "en");
            r.id = format!("extra-{i}");
            r.size = Size { w: 6 + i % 7, h: 5 + i % 5 };
            c.rooms.push(r);
            let size = arrange(&mut c);
            let rooms: Vec<_> = c.active_rooms().collect();
            for (i, a) in rooms.iter().enumerate() {
                let (_, _, x1, y1) = a.rect();
                assert!(a.position.x >= MARGIN && a.position.y >= MARGIN);
                assert!(x1 < size.w as i32 && y1 < size.h as i32, "{} inside the building", a.id);
                for b in &rooms[i + 1..] {
                    assert!(!overlaps_with_margin(a.rect(), b.rect(), 1), "{} / {}", a.id, b.id);
                }
            }
            assert!(unreachable_rooms(&c).is_empty(), "{:?}", unreachable_rooms(&c));
        }
        assert_eq!(c.rooms[0].position, Point { x: MARGIN, y: MARGIN }, "HQ first");
    }

    #[test]
    fn doors_open_on_corridors() {
        let mut c = hq();
        arrange(&mut c);
        let g = Grid::of(&c);
        for r in c.active_rooms() {
            let d = door(&c, r);
            assert!(g.is_floor(d.x, d.y));
            assert_eq!(d.side, Side::Bottom);
        }
        // A room blocked below gets its door elsewhere.
        c.layout = "manual".into();
        let below = c.rooms[0].rect();
        let mut r = Room::of_kind("custom", "en");
        r.id = "under".into();
        r.position = Point { x: below.0, y: below.3 };
        r.unplaced = false;
        c.rooms.push(r);
        let d = door(&c, &c.rooms[0]);
        assert_ne!(d.side, Side::Bottom);
    }

    #[test]
    fn manual_layout_keeps_positions_and_places_new_rooms() {
        let mut c = hq();
        arrange(&mut c);
        c.layout = "manual".into();
        let before: Vec<Point> = c.rooms.iter().map(|r| r.position).collect();
        let mut r = Room::of_kind("database_room", "en");
        r.unplaced = true;
        c.rooms.push(r);
        arrange(&mut c);
        assert_eq!(before, c.rooms[..before.len()].iter().map(|r| r.position).collect::<Vec<_>>());
        let new = c.rooms.last().unwrap().rect();
        for other in &c.rooms[..before.len()] {
            assert!(!overlaps_with_margin(new, other.rect(), 1));
        }
        assert!(unreachable_rooms(&c).is_empty());
    }

    #[test]
    fn a_sealed_room_is_detected() {
        let mut c = WorldConfig { layout: "manual".into(), ..Default::default() };
        let mut a = Room::of_kind("central_hq", "en");
        a.position = Point { x: 2, y: 2 };
        a.unplaced = false;
        // A room enclosed by four others leaves its door facing a wall.
        let mut inner = Room::of_kind("custom", "en");
        inner.id = "inner".into();
        inner.position = Point { x: 20, y: 10 };
        inner.size = Size { w: 6, h: 5 };
        inner.unplaced = false;
        let wall = |id: &str, x, y, w, h| {
            let mut r = Room::of_kind("custom", "en");
            r.id = id.into();
            r.position = Point { x, y };
            r.size = Size { w, h };
            r.unplaced = false;
            r
        };
        c.rooms = vec![
            a,
            inner,
            wall("n", 18, 4, 10, 6),
            wall("s", 18, 15, 10, 6),
            wall("w", 14, 4, 6, 17),
            wall("e", 26, 10, 6, 5),
        ];
        assert!(unreachable_rooms(&c).contains(&"inner".to_string()));
    }
}
