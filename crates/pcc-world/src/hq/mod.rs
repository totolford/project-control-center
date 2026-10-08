//! NEXUS HQ: the AI World as one building made of functional rooms.
//!
//! * `config`   – world.json (rooms, connections, language, rules) and its migrations;
//! * `catalog`  – room types and furniture (shared with ai-town/data/nexusRooms.json);
//! * `layout`   – room placement, doors, walkability;
//! * `validate` – validation before every write, `repair_world`;
//! * `ops`      – the operations (Central's `manage_ai_world` and the AI World page);
//! * `store`    – disk, snapshots, rollback;
//! * `detect`   – project domains from real facts, room suggestions;
//! * `resolve`  – the room an agent walks to.

pub mod catalog;
pub mod config;
pub mod detect;
pub mod layout;
pub mod ops;
pub mod resolve;
pub mod store;
pub mod validate;

use std::path::Path;

use serde::Serialize;

pub use config::{Room, RoomLink, WorldConfig, WORLD_VERSION};
pub use detect::ProjectFacts;
pub use ops::{OpContext, WorldOp};
pub use resolve::RoomIndex;
pub use store::HqStore;

/// A room as the AI Town map generator receives it (`nexus:applyLayout`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRoom {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub purpose: String,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub door: layout::Door,
    pub decor: Vec<String>,
    /// Floor and wall materials of the room type (`ai-town/data/nexusHq.ts` HQ_FLOORS / HQ_WALLS).
    pub floor: String,
    pub wall: String,
    pub temporary: bool,
    pub created_at: String,
}

/// The building sent to AI Town.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutPayload {
    pub version: u32,
    pub revision: u64,
    pub locale: String,
    pub width: u32,
    pub height: u32,
    pub rooms: Vec<LayoutRoom>,
    pub connections: Vec<RoomLink>,
}

/// The project's building: world.json (migrated when older), or a new one —
/// the base rooms plus one room per domain detected in the project's real
/// files and connections. `language` is the project's `aiWorldLanguage`.
pub fn ensure_world(root: &Path, language: &str, facts: &ProjectFacts) -> pcc_core::Result<WorldConfig> {
    HqStore::for_project(root).load_or_init(|| {
        let language = if catalog::is_locale(language) { language } else { "auto" };
        let locale = if language == "auto" { "en" } else { language };
        detect::default_world(&detect::detect(root, facts), language, locale)
    })
}

pub fn payload(cfg: &WorldConfig) -> LayoutPayload {
    let size = layout::building_size(cfg);
    LayoutPayload {
        version: cfg.version,
        revision: cfg.revision,
        locale: cfg.locale.clone(),
        width: size.w,
        height: size.h,
        rooms: cfg
            .active_rooms()
            .map(|r| LayoutRoom {
                id: r.id.clone(),
                name: r.name.clone(),
                kind: r.kind.clone(),
                purpose: r.purpose.clone(),
                x: r.position.x,
                y: r.position.y,
                w: r.size.w,
                h: r.size.h,
                door: layout::door(cfg, r),
                decor: r.decor.clone(),
                floor: catalog::kind(&r.kind).map(|k| k.floor.clone()).unwrap_or_else(|| "wood".into()),
                wall: catalog::kind(&r.kind).map(|k| k.wall.clone()).unwrap_or_else(|| "plaster".into()),
                temporary: r.temporary,
                created_at: r.created_at.clone(),
            })
            .collect(),
        connections: cfg.connections.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_has_doors_inside_the_map() {
        let mut cfg = detect::default_world(&[], "auto", "en");
        layout::arrange(&mut cfg);
        let p = payload(&cfg);
        assert_eq!(p.rooms.len(), 6);
        for r in &p.rooms {
            assert!(r.door.x >= r.x && r.door.x < r.x + r.w as i32);
            assert!((r.door.y as u32) < p.height);
        }
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["rooms"][0]["door"]["side"], "bottom");
        assert_eq!(
            (json["rooms"][0]["floor"].as_str(), json["rooms"][0]["wall"].as_str()),
            (Some("carpet"), Some("stone"))
        );
    }

    #[test]
    fn materials_are_known_to_the_map_generator() {
        // ai-town/data/nexusHq.ts HQ_FLOORS / HQ_WALLS.
        let floors = ["wood", "darkwood", "stone", "carpet", "tiles", "grate"];
        let walls = ["plaster", "brick", "stone", "dark"];
        for (id, k) in &catalog::catalog().kinds {
            assert!(floors.contains(&k.floor.as_str()), "{id} floor {}", k.floor);
            assert!(walls.contains(&k.wall.as_str()), "{id} wall {}", k.wall);
        }
    }

    #[test]
    fn ensure_world_creates_then_reuses() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("Dockerfile"), "FROM scratch").unwrap();
        let a = ensure_world(tmp.path(), "fr", &ProjectFacts::default()).unwrap();
        assert_eq!(a.rooms[0].name, "QG NEXUS");
        assert_eq!(a.language, "fr");
        assert!(tmp.path().join(".agent-project/world/world.json").exists());
        let b = ensure_world(tmp.path(), "fr", &ProjectFacts::default()).unwrap();
        assert_eq!(a, b, "an existing world is never rebuilt");
        let c = ensure_world(tempfile::tempdir().unwrap().path(), "xx", &ProjectFacts::default()).unwrap();
        assert_eq!((c.language.as_str(), c.locale.as_str()), ("auto", "en"));
    }
}
