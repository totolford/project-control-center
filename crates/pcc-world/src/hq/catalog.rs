//! Room types and functional furniture of NEXUS HQ, shared with the AI Town
//! side (`ai-town/data/nexusRooms.json` is the single source).

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

const ROOMS_JSON: &str = include_str!("../../../../ai-town/data/nexusRooms.json");

/// Locales of the AI World (same order as the UI catalogs).
pub const LOCALES: [&str; 2] = ["en", "fr"];

#[derive(Debug, Deserialize)]
pub struct KindSpec {
    pub names: BTreeMap<String, String>,
    pub purpose: BTreeMap<String, String>,
    /// `[w, h]` in tiles, walls included.
    pub size: [u32; 2],
    pub floor: String,
    pub wall: String,
    pub decor: Vec<String>,
    /// Words of a real tool call that send a working agent here.
    pub actions: Vec<String>,
    /// Words of an agent's role that make this its home room.
    pub roles: Vec<String>,
    pub persistent: bool,
}

#[derive(Debug, Deserialize)]
pub struct DecorSpec {
    pub w: u32,
    pub h: u32,
    pub names: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct Catalog {
    pub kinds: BTreeMap<String, KindSpec>,
    pub decor: BTreeMap<String, DecorSpec>,
}

pub fn catalog() -> &'static Catalog {
    static C: OnceLock<Catalog> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(ROOMS_JSON).expect("ai-town/data/nexusRooms.json is valid"))
}

pub fn kind(id: &str) -> Option<&'static KindSpec> {
    catalog().kinds.get(id)
}

pub fn is_locale(s: &str) -> bool {
    LOCALES.contains(&s)
}

fn pick(map: &BTreeMap<String, String>, locale: &str) -> String {
    map.get(locale).or_else(|| map.get("en")).cloned().unwrap_or_default()
}

/// Name of a room type in a locale (English when unknown).
pub fn default_name(kind_id: &str, locale: &str) -> String {
    kind(kind_id).map(|k| pick(&k.names, locale)).unwrap_or_else(|| pick(&catalog().kinds["custom"].names, locale))
}

pub fn default_purpose(kind_id: &str, locale: &str) -> String {
    kind(kind_id).map(|k| pick(&k.purpose, locale)).unwrap_or_default()
}

/// True when `name` is the default name of `kind_id` in any locale.
pub fn is_default_name(kind_id: &str, name: &str) -> bool {
    kind(kind_id).is_some_and(|k| k.names.values().any(|n| n == name))
}

pub fn is_decor(id: &str) -> bool {
    catalog().decor.contains_key(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_complete() {
        let c = catalog();
        for k in ["central_hq", "coding_office", "github_office", "server_room", "skill_shop", "custom"] {
            assert!(c.kinds.contains_key(k), "{k}");
        }
        for (id, k) in &c.kinds {
            for l in LOCALES {
                assert!(k.names.contains_key(l), "{id} name {l}");
                assert!(k.purpose.contains_key(l), "{id} purpose {l}");
            }
            for d in &k.decor {
                assert!(is_decor(d), "{id} decor {d}");
            }
            assert!(k.size[0] >= 6 && k.size[1] >= 5, "{id} too small");
        }
        assert_eq!(default_name("server_room", "fr"), "Salle des serveurs");
        assert_eq!(default_name("server_room", "xx"), "Server Room");
        assert!(is_default_name("server_room", "Salle des serveurs"));
        assert!(!is_default_name("server_room", "Serverraum"));
    }
}
