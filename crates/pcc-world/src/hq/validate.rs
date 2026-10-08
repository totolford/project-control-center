//! World validation (before every write) and repair (`repair_world`).

use std::collections::BTreeSet;

use serde::Serialize;

use super::catalog;
use super::config::{Room, WorldConfig, WORLD_VERSION};
use super::layout::{self, MAX_BUILDING, MAX_H, MAX_W, MIN_H, MIN_W};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// `error` blocks the change, `warning` is shown.
    pub severity: &'static str,
    pub room: Option<String>,
    pub message: String,
}

fn err(room: Option<&str>, message: impl Into<String>) -> Issue {
    Issue { severity: "error", room: room.map(str::to_string), message: message.into() }
}

fn warn(room: Option<&str>, message: impl Into<String>) -> Issue {
    Issue { severity: "warning", room: room.map(str::to_string), message: message.into() }
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 48
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Every problem of a world. Errors mean the world must not be written.
pub fn validate(cfg: &WorldConfig) -> Vec<Issue> {
    let mut out = Vec::new();
    if cfg.version != WORLD_VERSION {
        out.push(err(None, format!("unsupported world version {}", cfg.version)));
    }
    if cfg.language != "auto" && !catalog::is_locale(&cfg.language) {
        out.push(err(None, format!("unknown language `{}`", cfg.language)));
    }
    if cfg.layout != "auto" && cfg.layout != "manual" {
        out.push(err(None, format!("layout must be auto or manual, not `{}`", cfg.layout)));
    }
    let mut ids = BTreeSet::new();
    for r in &cfg.rooms {
        let id = Some(r.id.as_str());
        if !valid_id(&r.id) {
            out.push(err(id, format!("invalid room id `{}`", r.id)));
        }
        if !ids.insert(r.id.as_str()) {
            out.push(err(id, format!("duplicate room id `{}`", r.id)));
        }
        if r.name.trim().is_empty() || r.name.chars().count() > 40 {
            out.push(err(id, "a room name has 1 to 40 characters"));
        }
        if catalog::kind(&r.kind).is_none() {
            out.push(err(id, format!("unknown room type `{}`", r.kind)));
        }
        if !(MIN_W..=MAX_W).contains(&r.size.w) || !(MIN_H..=MAX_H).contains(&r.size.h) {
            out.push(err(id, format!("size {}x{} outside {MIN_W}x{MIN_H}..{MAX_W}x{MAX_H}", r.size.w, r.size.h)));
        }
        if r.active() && !r.unplaced && (r.position.x < 2 || r.position.y < 2) {
            out.push(err(id, "position overlaps the outer wall"));
        }
        for d in &r.decor {
            if !catalog::is_decor(d) {
                out.push(err(id, format!("unknown furniture `{d}`")));
            }
        }
        if r.decor.len() > 12 {
            out.push(err(id, "at most 12 pieces of furniture per room"));
        }
        let mut seen = BTreeSet::new();
        if r.agents.iter().any(|a| !seen.insert(a)) {
            out.push(warn(id, "an agent is listed twice"));
        }
    }
    let active: Vec<&Room> = cfg.active_rooms().collect();
    if active.len() as u32 > cfg.rules.max_rooms {
        out.push(err(None, format!("{} active rooms, the limit is {}", active.len(), cfg.rules.max_rooms)));
    }
    match cfg.rooms.iter().filter(|r| r.kind == "central_hq").count() {
        0 => out.push(err(None, "NEXUS HQ (Central's room) is missing")),
        1 => {}
        _ => out.push(err(None, "there can be only one NEXUS HQ")),
    }
    if cfg.rooms.iter().any(|r| r.kind == "central_hq" && r.archived) {
        out.push(err(Some("central_hq"), "NEXUS HQ cannot be archived"));
    }
    for (i, a) in active.iter().enumerate() {
        for b in &active[i + 1..] {
            if a.unplaced || b.unplaced {
                continue;
            }
            let (ra, rb) = (a.rect(), b.rect());
            // At least one corridor tile between two rooms.
            if ra.0 - 1 < rb.2 && rb.0 < ra.2 + 1 && ra.1 - 1 < rb.3 && rb.1 < ra.3 + 1 {
                out.push(err(Some(&a.id), format!("`{}` and `{}` overlap or touch", a.id, b.id)));
            }
        }
    }
    let size = layout::building_size(cfg);
    if size.w >= MAX_BUILDING.0 || size.h >= MAX_BUILDING.1 {
        out.push(err(None, format!("the building would exceed {}x{} tiles", MAX_BUILDING.0, MAX_BUILDING.1)));
    }
    if !out.iter().any(|i| i.severity == "error") {
        for id in layout::unreachable_rooms(cfg) {
            out.push(err(Some(&id), format!("`{id}` cannot be reached from NEXUS HQ (no free corridor at its door)")));
        }
    }
    for l in &cfg.connections {
        let ok = |id: &str| cfg.room(id).is_some_and(Room::active);
        if !ok(&l.from) || !ok(&l.to) || l.from == l.to {
            out.push(err(None, format!("connection {} → {} links a missing or archived room", l.from, l.to)));
        }
    }
    out
}

pub fn errors(issues: &[Issue]) -> Vec<&Issue> {
    issues.iter().filter(|i| i.severity == "error").collect()
}

/// Repairs what can be repaired; returns what was done.
pub fn repair(cfg: &mut WorldConfig, locale: &str, known_agents: &[String]) -> Vec<String> {
    let mut done = Vec::new();
    if cfg.language != "auto" && !catalog::is_locale(&cfg.language) {
        cfg.language = "auto".into();
        done.push("language reset to Auto".to_string());
    }
    if cfg.layout != "manual" {
        cfg.layout = "auto".into();
    }
    // Ids: invalid or duplicate ones get a fresh id.
    let mut seen = BTreeSet::new();
    for i in 0..cfg.rooms.len() {
        let id = cfg.rooms[i].id.clone();
        if !valid_id(&id) || !seen.insert(id.clone()) {
            let base = if valid_id(&id) { id.clone() } else { cfg.rooms[i].kind.clone() };
            let fresh = (1..).map(|n| format!("{base}-r{n}")).find(|c| !cfg.rooms.iter().any(|r| &r.id == c)).unwrap();
            cfg.rooms[i].id = fresh.clone();
            seen.insert(fresh.clone());
            done.push(format!("room id `{id}` replaced by `{fresh}`"));
        }
    }
    for r in &mut cfg.rooms {
        if catalog::kind(&r.kind).is_none() {
            r.kind = "custom".into();
            done.push(format!("`{}`: unknown type replaced by custom", r.id));
        }
        if r.name.trim().is_empty() {
            r.name = catalog::default_name(&r.kind, locale);
            r.custom_name = false;
            done.push(format!("`{}`: name restored", r.id));
        } else if r.name.chars().count() > 40 {
            r.name = r.name.chars().take(40).collect();
            done.push(format!("`{}`: name shortened", r.id));
        }
        let before = r.decor.len();
        r.decor.retain(|d| catalog::is_decor(d));
        r.decor.truncate(12);
        if r.decor.len() != before {
            done.push(format!("`{}`: unknown furniture removed", r.id));
        }
        let before = r.agents.len();
        let mut s = BTreeSet::new();
        r.agents.retain(|a| known_agents.contains(a) && s.insert(a.clone()));
        if r.agents.len() != before {
            done.push(format!("`{}`: assignments of missing agents removed", r.id));
        }
    }
    // Exactly one NEXUS HQ, active.
    let hqs: Vec<usize> = (0..cfg.rooms.len()).filter(|&i| cfg.rooms[i].kind == "central_hq").collect();
    if hqs.is_empty() {
        let mut hq = Room::of_kind("central_hq", locale);
        hq.id = cfg.free_id("central_hq");
        cfg.rooms.insert(0, hq);
        done.push("NEXUS HQ restored".into());
    } else {
        for &i in &hqs[1..] {
            cfg.rooms[i].kind = "custom".into();
            done.push(format!("`{}`: second NEXUS HQ turned into a custom room", cfg.rooms[i].id));
        }
        if cfg.rooms[hqs[0]].archived {
            cfg.rooms[hqs[0]].archived = false;
            done.push("NEXUS HQ unarchived".into());
        }
    }
    // Too many active rooms: archive the newest non-persistent ones.
    while cfg.active_rooms().count() as u32 > cfg.rules.max_rooms {
        let Some(r) = cfg.rooms.iter_mut().rev().find(|r| r.active() && !r.persistent) else { break };
        r.archived = true;
        done.push(format!("`{}` archived (room limit)", r.id));
    }
    let before = cfg.connections.len();
    let active: BTreeSet<String> = cfg.active_rooms().map(|r| r.id.clone()).collect();
    cfg.connections.retain(|l| l.from != l.to && active.contains(&l.from) && active.contains(&l.to));
    cfg.connections.dedup();
    if cfg.connections.len() != before {
        done.push("connections to missing rooms removed".into());
    }
    // Geometry: clamp sizes and re-pack when rooms overlap or cannot be reached.
    layout::arrange(cfg);
    let broken = validate(cfg).iter().any(|i| i.severity == "error");
    if broken && cfg.layout == "manual" {
        cfg.layout = "auto".into();
        layout::arrange(cfg);
        done.push("rooms overlapped or were unreachable: automatic layout restored".into());
    }
    done
}

#[cfg(test)]
mod tests {
    use super::super::config::{Point, RoomLink, Size};
    use super::*;

    fn base() -> WorldConfig {
        let mut c = WorldConfig::default();
        for k in ["central_hq", "coding_office", "server_room"] {
            c.rooms.push(Room::of_kind(k, "en"));
        }
        layout::arrange(&mut c);
        c
    }

    #[test]
    fn a_fresh_world_is_valid() {
        assert!(errors(&validate(&base())).is_empty(), "{:?}", validate(&base()));
    }

    #[test]
    fn detects_broken_worlds() {
        let mut c = base();
        c.rooms[1].id = "central_hq".into();
        c.rooms[2].size = Size { w: 3, h: 3 };
        c.rooms.push(Room { id: "Bad Id".into(), name: String::new(), kind: "spaceship".into(), ..Room::default() });
        c.connections.push(RoomLink { from: "central_hq".into(), to: "nowhere".into() });
        c.language = "klingon".into();
        let issues = validate(&c);
        let text = format!("{issues:?}");
        for needle in
            ["duplicate room id", "size 3x3", "invalid room id", "unknown room type", "nowhere", "klingon", "1 to 40"]
        {
            assert!(text.contains(needle), "{needle} in {text}");
        }
    }

    #[test]
    fn overlapping_rooms_are_refused_and_repaired() {
        let mut c = base();
        c.layout = "manual".into();
        c.rooms[1].position = Point { x: c.rooms[0].position.x + 1, y: c.rooms[0].position.y + 1 };
        assert!(!errors(&validate(&c)).is_empty());
        let done = repair(&mut c, "en", &[]);
        assert!(errors(&validate(&c)).is_empty(), "{:?}", validate(&c));
        assert!(done.iter().any(|d| d.contains("automatic layout")));
    }

    #[test]
    fn repair_restores_hq_and_cleans_references() {
        let mut c = base();
        c.rooms.retain(|r| r.kind != "central_hq");
        c.rooms[0].agents = vec!["ghost".into(), "w1".into(), "w1".into()];
        c.rooms[0].decor.push("jacuzzi".into());
        c.connections.push(RoomLink { from: "coding_office".into(), to: "gone".into() });
        let done = repair(&mut c, "fr", &["w1".to_string()]);
        assert!(c.hq().is_some_and(|h| h.name == "QG NEXUS"));
        assert_eq!(c.room("coding_office").unwrap().agents, vec!["w1".to_string()]);
        assert!(!c.room("coding_office").unwrap().decor.contains(&"jacuzzi".to_string()));
        assert!(c.connections.is_empty());
        assert!(errors(&validate(&c)).is_empty());
        assert!(done.len() >= 4, "{done:?}");
    }
}
