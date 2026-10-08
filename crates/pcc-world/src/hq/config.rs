//! `.agent-project/world/world.json`: the NEXUS HQ building (rooms,
//! connections, language, rules) and its migrations from older shapes.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use pcc_core::{Error, Result};

use super::catalog;

/// Current `version` of world.json.
pub const WORLD_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Size {
    pub w: u32,
    pub h: u32,
}

/// A room of the building. Position and size are in tiles, walls included.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Room {
    pub id: String,
    pub name: String,
    /// Room type (`ai-town/data/nexusRooms.json`), `custom` for anything else.
    #[serde(rename = "type")]
    pub kind: String,
    pub position: Point,
    pub size: Size,
    pub purpose: String,
    /// NEXUS connections this room's work relies on (connection names or kinds: `ssh`, `mcp:roblox`...).
    pub required_connections: Vec<String>,
    /// Agents Central assigned to this room.
    pub agents: Vec<String>,
    /// Part of the base building (NEXUS HQ...).
    pub persistent: bool,
    /// Created for temporary work.
    pub temporary: bool,
    pub archived: bool,
    /// Functional furniture (ids of `decor` in nexusRooms.json).
    pub decor: Vec<String>,
    /// The name was chosen (by Central or the user): a language change keeps it.
    pub custom_name: bool,
    /// `nexus` (default building), `central`, `user`, `migration`.
    pub created_by: String,
    pub created_at: String,
    /// Not placed yet: the layout finds a spot.
    pub unplaced: bool,
}

impl Default for Room {
    fn default() -> Self {
        Room {
            id: String::new(),
            name: String::new(),
            kind: "custom".into(),
            position: Point::default(),
            size: Size { w: 8, h: 6 },
            purpose: String::new(),
            required_connections: vec![],
            agents: vec![],
            persistent: false,
            temporary: false,
            archived: false,
            decor: vec![],
            custom_name: false,
            created_by: "nexus".into(),
            created_at: String::new(),
            unplaced: false,
        }
    }
}

impl Room {
    /// A room of a catalog type with its default name, purpose, size and furniture.
    pub fn of_kind(kind: &str, locale: &str) -> Room {
        let spec = catalog::kind(kind);
        Room {
            id: kind.to_string(),
            name: catalog::default_name(kind, locale),
            kind: if spec.is_some() { kind.to_string() } else { "custom".into() },
            size: spec.map(|k| Size { w: k.size[0], h: k.size[1] }).unwrap_or(Size { w: 8, h: 6 }),
            purpose: catalog::default_purpose(kind, locale),
            persistent: spec.is_some_and(|k| k.persistent),
            decor: spec.map(|k| k.decor.clone()).unwrap_or_default(),
            created_at: pcc_core::now(),
            unplaced: true,
            ..Default::default()
        }
    }

    pub fn active(&self) -> bool {
        !self.archived
    }

    /// Interior bounds (walls excluded), `[x0, x1) x [y0, y1)`.
    pub fn rect(&self) -> (i32, i32, i32, i32) {
        (self.position.x, self.position.y, self.position.x + self.size.w as i32, self.position.y + self.size.h as i32)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoomLink {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorldRules {
    /// Archiving a temporary room asks the user too (otherwise Central may archive it alone).
    pub ask_before_deleting_temporary: bool,
    /// Maximum number of active rooms.
    pub max_rooms: u32,
}

impl Default for WorldRules {
    fn default() -> Self {
        WorldRules { ask_before_deleting_temporary: true, max_rooms: 24 }
    }
}

/// Appearance of a character as stored by older worlds (migrated from a plain string).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Appearance {
    pub skin: String,
    pub sprite: String,
    pub palette: String,
}

impl Default for Appearance {
    fn default() -> Self {
        Appearance { skin: "default".into(), sprite: "default-agent".into(), palette: "default".into() }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CharacterEntry {
    pub agent_id: String,
    pub appearance: Appearance,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorldConfig {
    pub version: u32,
    /// AI World language preference: `auto` or a locale (mirrors the project's `aiWorldLanguage`).
    pub language: String,
    /// Locale the default room names are written in (the resolved language).
    pub locale: String,
    /// `auto` (NEXUS packs the rooms) or `manual` (positions kept as moved).
    pub layout: String,
    pub rooms: Vec<Room>,
    pub connections: Vec<RoomLink>,
    pub theme: String,
    pub rules: WorldRules,
    /// Per-character overrides kept from older worlds.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub characters: Vec<CharacterEntry>,
    /// Incremented on every change (the bridge redraws the map when it moves).
    pub revision: u64,
    pub updated_at: String,
    /// Fields written by other NEXUS versions, kept on rewrite.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for WorldConfig {
    fn default() -> Self {
        WorldConfig {
            version: WORLD_VERSION,
            language: "auto".into(),
            locale: "en".into(),
            layout: "auto".into(),
            rooms: vec![],
            connections: vec![],
            theme: "nexus-hq".into(),
            rules: WorldRules::default(),
            characters: vec![],
            revision: 0,
            updated_at: String::new(),
            extra: Map::new(),
        }
    }
}

impl WorldConfig {
    pub fn room(&self, id: &str) -> Option<&Room> {
        self.rooms.iter().find(|r| r.id == id)
    }
    pub fn room_mut(&mut self, id: &str) -> Option<&mut Room> {
        self.rooms.iter_mut().find(|r| r.id == id)
    }
    /// A room by id, or by name (case-insensitive) — Central may use either.
    pub fn find(&self, key: &str) -> Option<&Room> {
        self.room(key).or_else(|| self.rooms.iter().find(|r| r.name.eq_ignore_ascii_case(key.trim())))
    }
    pub fn active_rooms(&self) -> impl Iterator<Item = &Room> {
        self.rooms.iter().filter(|r| r.active())
    }
    pub fn hq(&self) -> Option<&Room> {
        self.active_rooms().find(|r| r.kind == "central_hq")
    }
    /// A free room id derived from `base`.
    pub fn free_id(&self, base: &str) -> String {
        let base = {
            let s = if catalog::kind(base).is_some() { base.to_string() } else { pcc_core::ids::slugify(base) };
            if s.is_empty() {
                "room".to_string()
            } else {
                s
            }
        };
        if self.room(&base).is_none() {
            return base;
        }
        (2..).map(|n| format!("{base}-{n}")).find(|id| self.room(id).is_none()).expect("free id")
    }
}

/// Outcome of reading world.json.
#[derive(Debug, Clone)]
pub struct Migrated {
    pub config: WorldConfig,
    /// What the migration changed (empty when the file was current).
    pub notes: Vec<String>,
}

/// Reads any known shape of world.json and returns the current one.
///
/// * no `version` (0.3/0.4 era): `zones` (AI Town buildings) become rooms,
///   character appearances given as a plain string become `{skin, sprite, palette}`;
/// * `version` newer than this build: refused (the file is kept untouched).
pub fn migrate(mut v: Value) -> Result<Migrated> {
    let obj = v.as_object_mut().ok_or_else(|| Error::invalid("world.json is not an object"))?;
    let version = obj.get("version").and_then(Value::as_u64).unwrap_or(0) as u32;
    if version > WORLD_VERSION {
        return Err(Error::invalid(format!(
            "world.json was written by a newer NEXUS (world version {version}, this build reads up to {WORLD_VERSION})"
        )));
    }
    let mut notes = Vec::new();
    if version == 0 {
        if let Some(zones) = obj.remove("zones").and_then(|z| z.as_array().cloned()) {
            let rooms = obj.entry("rooms").or_insert_with(|| json!([]));
            let list = rooms.as_array_mut().ok_or_else(|| Error::invalid("`rooms` is not a list"))?;
            for z in zones {
                let id = z.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                if id.is_empty() || list.iter().any(|r| r.get("id").and_then(Value::as_str) == Some(id.as_str())) {
                    continue;
                }
                let kind = if catalog::kind(&id).is_some() { id.clone() } else { "custom".to_string() };
                let mut room = json!({
                    "id": id,
                    "type": kind,
                    "name": z.get("name").cloned().unwrap_or(json!("")),
                    "purpose": z.get("purpose").cloned().unwrap_or(json!("")),
                    "createdBy": "migration",
                    "unplaced": true,
                });
                if let Some(spec) = catalog::kind(&kind) {
                    room["size"] = json!({"w": spec.size[0], "h": spec.size[1]});
                    room["decor"] = json!(spec.decor);
                    room["persistent"] = json!(spec.persistent);
                }
                list.push(room);
            }
            notes.push("AI Town buildings (0.3/0.4 zones) converted to HQ rooms".into());
        }
        // Appearance given as a plain string.
        if let Some(chars) = obj.get_mut("characters").and_then(Value::as_array_mut) {
            let mut fixed = 0;
            for c in chars.iter_mut() {
                if let Some(s) = c.get("appearance").and_then(Value::as_str).map(str::to_string) {
                    c["appearance"] = json!({"skin": s, "sprite": s, "palette": "default"});
                    fixed += 1;
                }
                if let Some(id) = c.get("id").cloned() {
                    if c.get("agentId").is_none() {
                        c["agentId"] = id;
                    }
                }
            }
            if fixed > 0 {
                notes.push(format!("{fixed} character appearance(s) converted to {{skin, sprite, palette}}"));
            }
        }
        // Older room records: `x/y/w/h` instead of position/size, `kind` instead of `type`.
        if let Some(rooms) = obj.get_mut("rooms").and_then(Value::as_array_mut) {
            for r in rooms.iter_mut() {
                let Some(o) = r.as_object_mut() else { continue };
                if !o.contains_key("type") {
                    if let Some(k) = o.remove("kind") {
                        o.insert("type".into(), k);
                    }
                }
                if !o.contains_key("position") {
                    if let (Some(x), Some(y)) = (o.get("x").and_then(Value::as_i64), o.get("y").and_then(Value::as_i64))
                    {
                        o.insert("position".into(), json!({"x": x, "y": y}));
                    }
                }
                if !o.contains_key("size") {
                    if let (Some(w), Some(h)) = (o.get("w").and_then(Value::as_u64), o.get("h").and_then(Value::as_u64))
                    {
                        o.insert("size".into(), json!({"w": w, "h": h}));
                    }
                }
                for k in ["x", "y", "w", "h", "door"] {
                    o.remove(k);
                }
            }
        }
        obj.insert("version".into(), json!(WORLD_VERSION));
        notes.push(format!("world.json migrated from version {version} to {WORLD_VERSION}"));
    }
    let mut config: WorldConfig = serde_json::from_value(v).map_err(|e| Error::invalid(format!("world.json: {e}")))?;
    for r in &mut config.rooms {
        if r.name.trim().is_empty() {
            r.name = catalog::default_name(&r.kind, &config.locale);
        }
        if r.purpose.trim().is_empty() {
            r.purpose = catalog::default_purpose(&r.kind, &config.locale);
        }
        if catalog::kind(&r.kind).is_none() {
            r.kind = "custom".into();
        }
    }
    Ok(Migrated { config, notes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_zones_become_rooms() {
        let legacy = json!({
            "zones": [
                {"id": "central_hq", "name": "Central HQ", "purpose": "plans", "x": 42, "y": 16, "w": 8, "h": 5, "door": {"x": 46, "y": 21}},
                {"id": "mystery", "name": "Mystery", "purpose": "", "x": 1, "y": 1, "w": 6, "h": 5}
            ],
            "characters": [{"agentId": "a1", "appearance": "f3"}],
            "somethingNew": 1
        });
        let m = migrate(legacy).unwrap();
        let c = m.config;
        assert_eq!(c.version, WORLD_VERSION);
        assert_eq!(c.rooms.len(), 2);
        assert_eq!(c.rooms[0].kind, "central_hq");
        assert_eq!(c.rooms[0].size, Size { w: 12, h: 8 });
        assert!(c.rooms[0].persistent && c.rooms[0].unplaced);
        assert_eq!(c.rooms[1].kind, "custom");
        assert_eq!(
            c.characters[0].appearance,
            Appearance { skin: "f3".into(), sprite: "f3".into(), palette: "default".into() }
        );
        assert_eq!(c.extra.get("somethingNew"), Some(&json!(1)));
        assert!(m.notes.len() >= 2);
        // Unknown fields survive a rewrite.
        let back = serde_json::to_value(&c).unwrap();
        assert_eq!(back["somethingNew"], json!(1));
    }

    #[test]
    fn old_room_shape_and_newer_versions() {
        let m =
            migrate(json!({"rooms": [{"id": "r", "kind": "server_room", "x": 3, "y": 4, "w": 9, "h": 6}]})).unwrap();
        let r = &m.config.rooms[0];
        assert_eq!((r.kind.as_str(), r.position, r.size), ("server_room", Point { x: 3, y: 4 }, Size { w: 9, h: 6 }));
        assert_eq!(r.name, "Server Room");
        assert!(migrate(json!({"version": WORLD_VERSION + 1})).is_err());
        let current = migrate(serde_json::to_value(WorldConfig::default()).unwrap()).unwrap();
        assert!(current.notes.is_empty());
    }

    #[test]
    fn free_ids() {
        let mut c = WorldConfig::default();
        c.rooms.push(Room::of_kind("server_room", "en"));
        assert_eq!(c.free_id("server_room"), "server_room-2");
        assert_eq!(c.free_id("API Lab"), "api-lab");
        assert_eq!(c.free_id("サーバー"), "room");
    }
}
