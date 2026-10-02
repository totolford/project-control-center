//! Tick-based world engine. Linked characters follow their real NEXUS
//! agent; unlinked ones (simulation) follow a deterministic daily routine.

use serde::{Deserialize, Serialize};

use crate::model::{RoomKind, World, WorldMode};

/// What the engine needs to know about a real agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentView {
    pub id: String,
    pub name: String,
    /// `AgentStatus` in snake_case (`working`, `waiting`, `offline`...).
    pub status: String,
    pub current_action: Option<String>,
    /// Status of the agent's current or last task, if any.
    pub task_status: Option<String>,
    pub task_title: Option<String>,
    /// Sent or received a message in the last minute.
    pub messaging: bool,
    /// Its current action uses a connection (SSH, MCP...).
    pub using_connection: bool,
    /// Its current action touches memory.
    pub using_memory: bool,
    pub model: Option<String>,
}

/// Room a real agent belongs to, from its real state.
pub fn room_for(a: &AgentView) -> RoomKind {
    match a.status.as_str() {
        "crashed" => RoomKind::Infirmary,
        "offline" | "stopped" | "retired" | "disconnected" => RoomKind::Gate,
        "awaiting_permission" => RoomKind::Security,
        "working" if a.using_connection => RoomKind::ServerRoom,
        "working" if a.using_memory => RoomKind::Library,
        "working" | "starting" => RoomKind::Workshop,
        _ if a.task_status.as_deref() == Some("review") => RoomKind::Review,
        _ if a.messaging => RoomKind::Meeting,
        _ => RoomKind::Lounge,
    }
}

/// Simulation routine: a stable pseudo-random room per character and period.
fn routine_room(seed: &str, period: u64) -> RoomKind {
    const ROUTINE: [RoomKind; 6] = [
        RoomKind::Workshop,
        RoomKind::Meeting,
        RoomKind::Lounge,
        RoomKind::Library,
        RoomKind::Workshop,
        RoomKind::Review,
    ];
    let mut h: u64 = 1469598103934665603;
    for b in seed.bytes().chain(period.to_le_bytes()) {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    ROUTINE[(h % ROUTINE.len() as u64) as usize]
}

const SPEED: f32 = 0.6;

/// Where a character should go this tick and what it is doing.
struct Target {
    index: usize,
    room: Option<String>,
    activity: Option<String>,
    model: Option<String>,
}

/// Advances the world by one tick. Returns ids of characters that changed room.
pub fn tick(world: &mut World, agents: &[AgentView]) -> Vec<String> {
    world.tick += 1;
    let mut moved = Vec::new();
    let period = world.tick / 40;
    let linked_modes = matches!(world.mode, WorldMode::Hybrid | WorldMode::RealExecution);
    let targets: Vec<Target> = world
        .characters
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let real =
                c.nexus_agent.as_ref().filter(|_| linked_modes).and_then(|id| agents.iter().find(|a| &a.id == id));
            match real {
                Some(a) => {
                    let room = world.room_of_kind(room_for(a)).map(|r| r.id.clone());
                    let activity = a
                        .current_action
                        .clone()
                        .or_else(|| a.task_title.clone().map(|t| format!("Task: {t}")))
                        .or_else(|| Some(a.status.replace('_', " ")));
                    Target { index: i, room, activity, model: a.model.clone() }
                }
                None => {
                    let room = world.room_of_kind(routine_room(&c.id, period)).map(|r| r.id.clone());
                    Target { index: i, room, activity: c.activity.clone(), model: c.model.clone() }
                }
            }
        })
        .collect();
    for Target { index: i, room, activity, model } in targets {
        let center = room.as_deref().and_then(|r| world.room(r)).map(|r| {
            // Spread characters inside the room so they do not overlap.
            let slot = i as f32;
            let (cx, cy) = r.center();
            (
                cx + ((slot * 2.3) % (r.w - 2.0).max(1.0)) - (r.w - 2.0) / 2.0,
                cy + ((slot * 1.7) % (r.h - 2.0).max(1.0)) - (r.h - 2.0) / 2.0,
            )
        });
        let c = &mut world.characters[i];
        if c.target_room != room {
            c.target_room = room.clone();
            moved.push(c.id.clone());
        }
        if let Some(a) = activity {
            if c.activity.as_ref() != Some(&a) {
                c.last_action = c.activity.take();
                c.activity = Some(a);
            }
        }
        if model.is_some() {
            c.model = model;
        }
        if let Some((tx, ty)) = center {
            let (dx, dy) = (tx - c.x, ty - c.y);
            let dist = (dx * dx + dy * dy).sqrt();
            if dist <= SPEED {
                c.x = tx;
                c.y = ty;
                c.room = c.target_room.clone();
            } else {
                c.x += dx / dist * SPEED;
                c.y += dy / dist * SPEED;
            }
        }
    }
    for id in &moved {
        let (name, room) = {
            let c = world.characters.iter().find(|c| &c.id == id).expect("character");
            (c.name.clone(), c.target_room.clone().unwrap_or_default())
        };
        let room_name = world.room(&room).map(|r| r.name.clone()).unwrap_or(room);
        world.push_event(Some(id), format!("{name} heads to the {room_name}"));
    }
    moved
}

/// Pairs of unlinked characters sharing a room, candidates for a simulated conversation.
pub fn conversation_candidates(world: &World) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let free: Vec<_> = world.characters.iter().filter(|c| c.room.is_some()).collect();
    for (i, a) in free.iter().enumerate() {
        for b in &free[i + 1..] {
            if a.room == b.room && a.room.as_deref() != Some("gate") {
                out.push((a.id.clone(), b.id.clone()));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Character;

    fn view(status: &str) -> AgentView {
        AgentView { id: "movement".into(), name: "Movement".into(), status: status.into(), ..Default::default() }
    }

    #[test]
    fn rooms_follow_real_state() {
        assert_eq!(room_for(&view("working")), RoomKind::Workshop);
        assert_eq!(room_for(&AgentView { using_connection: true, ..view("working") }), RoomKind::ServerRoom);
        assert_eq!(room_for(&view("awaiting_permission")), RoomKind::Security);
        assert_eq!(room_for(&view("offline")), RoomKind::Gate);
        assert_eq!(room_for(&view("crashed")), RoomKind::Infirmary);
        assert_eq!(room_for(&AgentView { task_status: Some("review".into()), ..view("waiting") }), RoomKind::Review);
        assert_eq!(room_for(&AgentView { messaging: true, ..view("waiting") }), RoomKind::Meeting);
        assert_eq!(room_for(&view("waiting")), RoomKind::Lounge);
    }

    #[test]
    fn linked_character_walks_to_its_real_room() {
        let mut w = World::new("t", "", "nexus_native", WorldMode::Hybrid);
        w.characters.push(Character {
            id: "c1".into(),
            name: "Movement".into(),
            nexus_agent: Some("movement".into()),
            x: 1.0,
            y: 1.0,
            ..Default::default()
        });
        let agents = vec![AgentView { current_action: Some("Editing Drone.luau".into()), ..view("working") }];
        let moved = tick(&mut w, &agents);
        assert_eq!(moved, vec!["c1"]);
        assert_eq!(w.characters[0].target_room.as_deref(), Some("workshop"));
        assert_eq!(w.characters[0].activity.as_deref(), Some("Editing Drone.luau"));
        for _ in 0..200 {
            tick(&mut w, &agents);
        }
        assert_eq!(w.characters[0].room.as_deref(), Some("workshop"));
        assert!(w.events.iter().any(|e| e.text.contains("Workshop")));
        // Agent goes idle: character goes to the lounge.
        let idle = vec![view("waiting")];
        tick(&mut w, &idle);
        assert_eq!(w.characters[0].target_room.as_deref(), Some("lounge"));
    }

    #[test]
    fn simulation_ignores_real_agents_and_is_deterministic() {
        let mut a = World::new("t", "", "nexus_native", WorldMode::Simulation);
        a.characters.push(Character { id: "c1".into(), nexus_agent: Some("movement".into()), ..Default::default() });
        let mut b = a.clone();
        for _ in 0..100 {
            tick(&mut a, &[view("crashed")]);
            tick(&mut b, &[]);
        }
        assert_eq!(a.characters[0].room, b.characters[0].room, "real state ignored in simulation");
        assert_ne!(a.characters[0].room.as_deref(), Some("infirmary"));
    }
}
