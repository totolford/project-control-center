//! Structural operations on the building (Central's `manage_ai_world` tool and
//! the AI World page use the same ones).

use serde::{Deserialize, Serialize};

use pcc_core::{Error, Result};

use super::catalog;
use super::config::{Point, Room, RoomLink, Size, WorldConfig};
use super::layout::{MAX_H, MAX_W, MIN_H, MIN_W};
use super::validate;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum WorldOp {
    CreateRoom {
        #[serde(default, rename = "type", alias = "kind")]
        kind: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        purpose: Option<String>,
        #[serde(default)]
        size: Option<Size>,
        #[serde(default)]
        position: Option<Point>,
        #[serde(default)]
        temporary: bool,
        #[serde(default)]
        agents: Vec<String>,
        #[serde(default, alias = "requiredConnections")]
        required_connections: Vec<String>,
    },
    /// Archives the room (nothing is erased; `restore_room` brings it back).
    DeleteRoom {
        room: String,
    },
    RestoreRoom {
        room: String,
    },
    RenameRoom {
        room: String,
        name: String,
    },
    MoveRoom {
        room: String,
        x: i32,
        y: i32,
    },
    ResizeRoom {
        room: String,
        w: u32,
        h: u32,
    },
    ConnectRooms {
        from: String,
        to: String,
    },
    DisconnectRooms {
        from: String,
        to: String,
    },
    AssignRoom {
        room: String,
        #[serde(default)]
        purpose: Option<String>,
        /// Replaces the assigned agents when given.
        #[serde(default)]
        agents: Option<Vec<String>>,
        #[serde(default, alias = "addAgents")]
        add_agents: Vec<String>,
        #[serde(default, alias = "removeAgents")]
        remove_agents: Vec<String>,
        #[serde(default, alias = "requiredConnections")]
        required_connections: Option<Vec<String>>,
    },
    DecorateRoom {
        room: String,
        decor: Vec<String>,
    },
    ChangeLanguage {
        language: String,
        /// Resolved locale when `language` is `auto` (the UI knows it).
        #[serde(default)]
        locale: Option<String>,
    },
    SetLayout {
        mode: String,
    },
    RepairWorld,
}

impl WorldOp {
    pub fn name(&self) -> &'static str {
        match self {
            WorldOp::CreateRoom { .. } => "create_room",
            WorldOp::DeleteRoom { .. } => "delete_room",
            WorldOp::RestoreRoom { .. } => "restore_room",
            WorldOp::RenameRoom { .. } => "rename_room",
            WorldOp::MoveRoom { .. } => "move_room",
            WorldOp::ResizeRoom { .. } => "resize_room",
            WorldOp::ConnectRooms { .. } => "connect_rooms",
            WorldOp::DisconnectRooms { .. } => "disconnect_rooms",
            WorldOp::AssignRoom { .. } => "assign_room",
            WorldOp::DecorateRoom { .. } => "decorate_room",
            WorldOp::ChangeLanguage { .. } => "change_language",
            WorldOp::SetLayout { .. } => "set_layout",
            WorldOp::RepairWorld => "repair_world",
        }
    }

    /// Changes the building's shape (a snapshot is taken first).
    pub fn is_structural(&self) -> bool {
        !matches!(self, WorldOp::AssignRoom { .. } | WorldOp::ChangeLanguage { .. })
    }

    /// Must Central ask the user before this operation?
    pub fn needs_approval(&self, cfg: &WorldConfig) -> bool {
        match self {
            WorldOp::DeleteRoom { room } => match cfg.find(room) {
                Some(r) => r.persistent || !r.temporary || cfg.rules.ask_before_deleting_temporary,
                None => false,
            },
            _ => false,
        }
    }

    /// One line for journals and approval prompts.
    pub fn summary(&self, cfg: &WorldConfig) -> String {
        let name = |id: &str| cfg.find(id).map(|r| r.name.clone()).unwrap_or_else(|| id.to_string());
        match self {
            WorldOp::CreateRoom { kind, name: n, .. } => format!(
                "Create room {}",
                n.clone().unwrap_or_else(|| catalog::default_name(kind.as_deref().unwrap_or("custom"), &cfg.locale))
            ),
            WorldOp::DeleteRoom { room } => format!("Archive room {}", name(room)),
            WorldOp::RestoreRoom { room } => format!("Restore room {}", name(room)),
            WorldOp::RenameRoom { room, name: n } => format!("Rename {} to {n}", name(room)),
            WorldOp::MoveRoom { room, x, y } => format!("Move {} to ({x}, {y})", name(room)),
            WorldOp::ResizeRoom { room, w, h } => format!("Resize {} to {w}x{h}", name(room)),
            WorldOp::ConnectRooms { from, to } => format!("Connect {} and {}", name(from), name(to)),
            WorldOp::DisconnectRooms { from, to } => format!("Disconnect {} and {}", name(from), name(to)),
            WorldOp::AssignRoom { room, .. } => format!("Update the assignment of {}", name(room)),
            WorldOp::DecorateRoom { room, decor } => format!("Furnish {} ({})", name(room), decor.join(", ")),
            WorldOp::ChangeLanguage { language, .. } => format!("AI World language: {language}"),
            WorldOp::SetLayout { mode } => format!("Layout: {mode}"),
            WorldOp::RepairWorld => "Repair the AI World".into(),
        }
    }
}

fn room_id(cfg: &WorldConfig, key: &str) -> Result<String> {
    cfg.find(key).map(|r| r.id.clone()).ok_or_else(|| Error::not_found(format!("room `{key}`")))
}

fn clean_name(name: &str) -> Result<String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 40 {
        return Err(Error::invalid("a room name has 1 to 40 characters"));
    }
    Ok(n.to_string())
}

/// Context the operations need from NEXUS.
pub struct OpContext<'a> {
    /// `central`, `user`.
    pub actor: &'a str,
    /// Ids of the project's agents (assignments must reference real agents).
    pub agents: &'a [String],
}

/// Applies `op` to `cfg` (no geometry: the caller arranges and validates).
/// Returns a short description of the result.
pub fn apply(cfg: &mut WorldConfig, op: &WorldOp, ctx: &OpContext) -> Result<String> {
    let check_agents = |list: &[String]| -> Result<()> {
        match list.iter().find(|a| !ctx.agents.contains(a)) {
            Some(a) => Err(Error::not_found(format!("agent `{a}`"))),
            None => Ok(()),
        }
    };
    match op {
        WorldOp::CreateRoom { kind, name, purpose, size, position, temporary, agents, required_connections } => {
            let kind = kind.clone().unwrap_or_else(|| "custom".into());
            if catalog::kind(&kind).is_none() {
                let known: Vec<&String> = catalog::catalog().kinds.keys().collect();
                return Err(Error::invalid(format!("unknown room type `{kind}` (known: {known:?})")));
            }
            if kind == "central_hq" && cfg.rooms.iter().any(|r| r.kind == "central_hq") {
                return Err(Error::invalid("NEXUS HQ already exists"));
            }
            check_agents(agents)?;
            let mut room = Room::of_kind(&kind, &cfg.locale);
            if let Some(n) = name {
                room.name = clean_name(n)?;
                room.custom_name = !catalog::is_default_name(&kind, &room.name);
            }
            room.id = cfg.free_id(if kind == "custom" { &room.name } else { &kind });
            if let Some(p) = purpose.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
                room.purpose = p.chars().take(200).collect();
            }
            if let Some(s) = size {
                room.size = *s;
            }
            if let Some(p) = position {
                room.position = *p;
                room.unplaced = false;
                cfg.layout = "manual".into();
            }
            room.temporary = *temporary;
            room.agents = agents.clone();
            room.required_connections = required_connections.clone();
            room.created_by = ctx.actor.to_string();
            room.persistent = false;
            let text = format!("Room `{}` ({}) created.", room.id, room.name);
            cfg.rooms.push(room);
            Ok(text)
        }
        WorldOp::DeleteRoom { room } => {
            let id = room_id(cfg, room)?;
            let r = cfg.room_mut(&id).expect("room");
            if r.kind == "central_hq" {
                return Err(Error::invalid("NEXUS HQ cannot be archived"));
            }
            if r.archived {
                return Ok(format!("`{id}` was already archived."));
            }
            r.archived = true;
            r.agents.clear();
            cfg.connections.retain(|l| l.from != id && l.to != id);
            Ok(format!("Room `{id}` archived (restore_room brings it back)."))
        }
        WorldOp::RestoreRoom { room } => {
            let id = room_id(cfg, room)?;
            let r = cfg.room_mut(&id).expect("room");
            r.archived = false;
            r.unplaced = true;
            Ok(format!("Room `{id}` restored."))
        }
        WorldOp::RenameRoom { room, name } => {
            let id = room_id(cfg, room)?;
            let name = clean_name(name)?;
            let r = cfg.room_mut(&id).expect("room");
            r.custom_name = !catalog::is_default_name(&r.kind, &name);
            r.name = name;
            Ok(format!("Room `{id}` renamed to {}.", r.name))
        }
        WorldOp::MoveRoom { room, x, y } => {
            let id = room_id(cfg, room)?;
            let r = cfg.room_mut(&id).expect("room");
            r.position = Point { x: *x, y: *y };
            r.unplaced = false;
            cfg.layout = "manual".into();
            Ok(format!("Room `{id}` moved to ({x}, {y}); the layout is now manual."))
        }
        WorldOp::ResizeRoom { room, w, h } => {
            if !(MIN_W..=MAX_W).contains(w) || !(MIN_H..=MAX_H).contains(h) {
                return Err(Error::invalid(format!("size must be between {MIN_W}x{MIN_H} and {MAX_W}x{MAX_H}")));
            }
            let id = room_id(cfg, room)?;
            cfg.room_mut(&id).expect("room").size = Size { w: *w, h: *h };
            Ok(format!("Room `{id}` resized to {w}x{h}."))
        }
        WorldOp::ConnectRooms { from, to } => {
            let (a, b) = (room_id(cfg, from)?, room_id(cfg, to)?);
            if a == b {
                return Err(Error::invalid("a room cannot be connected to itself"));
            }
            let exists = cfg.connections.iter().any(|l| (l.from == a && l.to == b) || (l.from == b && l.to == a));
            if !exists {
                cfg.connections.push(RoomLink { from: a.clone(), to: b.clone() });
            }
            Ok(format!("`{a}` and `{b}` are connected."))
        }
        WorldOp::DisconnectRooms { from, to } => {
            let (a, b) = (room_id(cfg, from)?, room_id(cfg, to)?);
            cfg.connections.retain(|l| !((l.from == a && l.to == b) || (l.from == b && l.to == a)));
            Ok(format!("`{a}` and `{b}` are no longer connected."))
        }
        WorldOp::AssignRoom { room, purpose, agents, add_agents, remove_agents, required_connections } => {
            let id = room_id(cfg, room)?;
            if let Some(list) = agents {
                check_agents(list)?;
            }
            check_agents(add_agents)?;
            // An agent has one assigned room: adding it here removes it elsewhere.
            let incoming: Vec<String> =
                agents.clone().unwrap_or_default().into_iter().chain(add_agents.clone()).collect();
            for other in cfg.rooms.iter_mut().filter(|r| r.id != id) {
                other.agents.retain(|a| !incoming.contains(a));
            }
            let r = cfg.room_mut(&id).expect("room");
            if r.archived {
                return Err(Error::invalid(format!("`{id}` is archived")));
            }
            if let Some(p) = purpose.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
                r.purpose = p.chars().take(200).collect();
            }
            if let Some(list) = agents {
                r.agents = list.clone();
            }
            for a in add_agents {
                if !r.agents.contains(a) {
                    r.agents.push(a.clone());
                }
            }
            r.agents.retain(|a| !remove_agents.contains(a));
            if let Some(c) = required_connections {
                r.required_connections = c.clone();
            }
            Ok(format!("Room `{id}`: purpose \"{}\", agents [{}].", r.purpose, r.agents.join(", ")))
        }
        WorldOp::DecorateRoom { room, decor } => {
            let id = room_id(cfg, room)?;
            if let Some(bad) = decor.iter().find(|d| !catalog::is_decor(d)) {
                let known: Vec<&String> = catalog::catalog().decor.keys().collect();
                return Err(Error::invalid(format!("unknown furniture `{bad}` (functional palette: {known:?})")));
            }
            if decor.len() > 12 {
                return Err(Error::invalid("at most 12 pieces of furniture per room"));
            }
            cfg.room_mut(&id).expect("room").decor = decor.clone();
            Ok(format!("Room `{id}` furnished."))
        }
        WorldOp::ChangeLanguage { language, locale } => {
            if language != "auto" && !catalog::is_locale(language) {
                return Err(Error::invalid(format!(
                    "unknown language `{language}` (auto, {})",
                    catalog::LOCALES.join(", ")
                )));
            }
            let resolved = if language == "auto" {
                locale.clone().filter(|l| catalog::is_locale(l)).unwrap_or_else(|| cfg.locale.clone())
            } else {
                language.clone()
            };
            cfg.language = language.clone();
            relocalize(cfg, &resolved);
            Ok(format!("AI World language set to {language} (room names in {resolved})."))
        }
        WorldOp::SetLayout { mode } => {
            if mode != "auto" && mode != "manual" {
                return Err(Error::invalid("layout is auto or manual"));
            }
            cfg.layout = mode.clone();
            Ok(format!("Layout set to {mode}."))
        }
        WorldOp::RepairWorld => {
            let locale = cfg.locale.clone();
            let done = validate::repair(cfg, &locale, ctx.agents);
            Ok(if done.is_empty() { "Nothing to repair.".into() } else { format!("Repaired: {}.", done.join("; ")) })
        }
    }
}

/// Renames the rooms that still have their default name (and default purpose) into `locale`.
pub fn relocalize(cfg: &mut WorldConfig, locale: &str) {
    let old = cfg.locale.clone();
    for r in &mut cfg.rooms {
        if !r.custom_name {
            r.name = catalog::default_name(&r.kind, locale);
        }
        if r.purpose == catalog::default_purpose(&r.kind, &old) {
            r.purpose = catalog::default_purpose(&r.kind, locale);
        }
    }
    cfg.locale = locale.to_string();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn world() -> WorldConfig {
        let mut c = WorldConfig::default();
        for k in ["central_hq", "coding_office"] {
            c.rooms.push(Room::of_kind(k, "en"));
        }
        c
    }

    fn ctx() -> OpContext<'static> {
        static AGENTS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
        OpContext { actor: "central", agents: AGENTS.get_or_init(|| vec!["w1".into(), "w2".into()]) }
    }

    #[test]
    fn ops_parse_from_central_json() {
        let op: WorldOp =
            serde_json::from_value(json!({"op": "create_room", "type": "database_room", "temporary": true})).unwrap();
        assert!(
            matches!(op, WorldOp::CreateRoom { ref kind, temporary: true, .. } if kind.as_deref() == Some("database_room"))
        );
        let op: WorldOp =
            serde_json::from_value(json!({"op": "assign_room", "room": "x", "addAgents": ["w1"]})).unwrap();
        assert!(matches!(op, WorldOp::AssignRoom { ref add_agents, .. } if add_agents == &["w1".to_string()]));
        assert!(serde_json::from_value::<WorldOp>(json!({"op": "nuke"})).is_err());
    }

    #[test]
    fn create_rename_assign_archive() {
        let mut c = world();
        let ctx = ctx();
        apply(
            &mut c,
            &WorldOp::CreateRoom {
                kind: Some("api_lab".into()),
                name: None,
                purpose: None,
                size: None,
                position: None,
                temporary: false,
                agents: vec!["w1".into()],
                required_connections: vec![],
            },
            &ctx,
        )
        .unwrap();
        assert_eq!(c.room("api_lab").unwrap().name, "API Lab");
        assert!(apply(
            &mut c,
            &WorldOp::CreateRoom {
                kind: Some("warp_core".into()),
                name: None,
                purpose: None,
                size: None,
                position: None,
                temporary: false,
                agents: vec![],
                required_connections: vec![]
            },
            &ctx
        )
        .is_err());
        assert!(apply(
            &mut c,
            &WorldOp::CreateRoom {
                kind: None,
                name: Some("X".into()),
                purpose: None,
                size: None,
                position: None,
                temporary: false,
                agents: vec!["ghost".into()],
                required_connections: vec![]
            },
            &ctx
        )
        .is_err());
        apply(&mut c, &WorldOp::RenameRoom { room: "API Lab".into(), name: "Payments API".into() }, &ctx).unwrap();
        assert!(c.room("api_lab").unwrap().custom_name);
        // Assigning w1 elsewhere moves it.
        apply(
            &mut c,
            &WorldOp::AssignRoom {
                room: "coding_office".into(),
                purpose: Some("Rust code".into()),
                agents: None,
                add_agents: vec!["w1".into()],
                remove_agents: vec![],
                required_connections: None,
            },
            &ctx,
        )
        .unwrap();
        assert!(c.room("api_lab").unwrap().agents.is_empty());
        assert_eq!(c.room("coding_office").unwrap().purpose, "Rust code");
        apply(&mut c, &WorldOp::ConnectRooms { from: "api_lab".into(), to: "coding_office".into() }, &ctx).unwrap();
        apply(&mut c, &WorldOp::ConnectRooms { from: "coding_office".into(), to: "api_lab".into() }, &ctx).unwrap();
        assert_eq!(c.connections.len(), 1);
        apply(&mut c, &WorldOp::DeleteRoom { room: "api_lab".into() }, &ctx).unwrap();
        assert!(c.room("api_lab").unwrap().archived && c.connections.is_empty());
        assert!(apply(&mut c, &WorldOp::DeleteRoom { room: "central_hq".into() }, &ctx).is_err());
        assert!(apply(
            &mut c,
            &WorldOp::DecorateRoom { room: "coding_office".into(), decor: vec!["hot_tub".into()] },
            &ctx
        )
        .is_err());
        assert!(apply(&mut c, &WorldOp::ResizeRoom { room: "coding_office".into(), w: 2, h: 2 }, &ctx).is_err());
    }

    #[test]
    fn approval_rules() {
        let mut c = world();
        let mut tmp = Room::of_kind("custom", "en");
        tmp.id = "tmp".into();
        tmp.temporary = true;
        c.rooms.push(tmp);
        let del = |r: &str| WorldOp::DeleteRoom { room: r.into() };
        assert!(del("coding_office").needs_approval(&c));
        assert!(del("tmp").needs_approval(&c));
        c.rules.ask_before_deleting_temporary = false;
        assert!(!del("tmp").needs_approval(&c));
        assert!(!WorldOp::RepairWorld.needs_approval(&c));
    }

    #[test]
    fn language_change_keeps_custom_names() {
        let mut c = world();
        c.rooms[1].name = "Forge".into();
        c.rooms[1].custom_name = true;
        apply(&mut c, &WorldOp::ChangeLanguage { language: "fr".into(), locale: None }, &ctx()).unwrap();
        assert_eq!((c.language.as_str(), c.locale.as_str()), ("fr", "fr"));
        assert_eq!(c.rooms[0].name, "QG NEXUS");
        assert_eq!(c.rooms[0].purpose, "Central planifie et orchestre les missions");
        assert_eq!(c.rooms[1].name, "Forge");
        apply(&mut c, &WorldOp::ChangeLanguage { language: "auto".into(), locale: Some("en".into()) }, &ctx()).unwrap();
        assert_eq!(c.rooms[0].name, "NEXUS HQ");
        assert!(apply(&mut c, &WorldOp::ChangeLanguage { language: "xx".into(), locale: None }, &ctx()).is_err());
    }
}
