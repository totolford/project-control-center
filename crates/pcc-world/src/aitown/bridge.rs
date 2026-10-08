//! Real NEXUS agent state → AI Town character state.
//!
//! Nothing here invents activity: the room, label and emoji are derived only
//! from what NEXUS observed (agent status, current tool, task, messages).

use serde::Serialize;

use crate::hq::resolve::{RoomIndex, Who};

/// One NEXUS agent as sent to `nexus:syncAgents` (see ai-town/convex/nexusSchema.ts).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NexusAgent {
    pub nexus_id: String,
    pub name: String,
    pub role: String,
    pub character: String,
    pub is_central: bool,
    pub status: String,
    pub status_label: String,
    /// Room of NEXUS HQ (field name kept for the AI Town schema).
    pub zone: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mission: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub skills: Vec<String>,
    pub mcp: Vec<String>,
    pub connections: Vec<String>,
    /// "#rrggbb" sprite tint chosen in "Customize Character".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    /// `commander`, `lieutenant` or `specialist`.
    pub rank: String,
    /// Supervising agent (absent for Central).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// Runtime adapter, e.g. `claude-code`.
    pub provider: String,
    /// Paused by the user.
    pub paused: bool,
}

/// What NEXUS knows about an agent right now.
#[derive(Debug, Clone, Default)]
pub struct AgentFacts {
    pub id: String,
    pub name: String,
    pub role: String,
    pub is_central: bool,
    /// `AgentStatus` in snake_case.
    pub status: String,
    pub current_action: Option<String>,
    pub task_title: Option<String>,
    pub task_status: Option<String>,
    /// Last log line was a thinking block (only when Claude Code exposes it).
    pub thinking: bool,
    /// AI Town character (f1..f8) or `nexus-skin:<name>`.
    pub character: Option<String>,
    pub tint: Option<String>,
    pub badge: Option<String>,
    pub mission: Option<String>,
    pub model: Option<String>,
    pub skills: Vec<String>,
    pub mcp: Vec<String>,
    pub connections: Vec<String>,
    /// `commander`, `lieutenant` or `specialist` (empty = specialist).
    pub rank: String,
    pub parent_id: Option<String>,
    pub provider: String,
    pub paused: bool,
    /// Home room of the supervising lieutenant: idle specialists gather there.
    pub parent_room: Option<String>,
}

/// Room of NEXUS HQ for the agent, from what it really does (see
/// `hq::resolve`): Central in NEXUS HQ, a working agent in the room of its
/// current tool call / MCP server / connection, otherwise the room Central
/// assigned it, its lieutenant's room, the room of its role. `archive` (or
/// NEXUS HQ when the building has no Archive) for retired agents.
pub fn room_for(f: &AgentFacts, rooms: &RoomIndex) -> String {
    let who = Who {
        id: &f.id,
        is_central: f.is_central,
        status: &f.status,
        role: &f.role,
        name: &f.name,
        current_action: f.current_action.as_deref(),
        task_status: f.task_status.as_deref(),
        parent_room: f.parent_room.as_deref(),
    };
    rooms.room_for(&who).or_else(|| rooms.hq().map(str::to_string)).unwrap_or_else(|| "central_hq".into())
}

/// Home room of a lieutenant (where its idle specialists gather): its own room when idle.
pub fn home_room(f: &AgentFacts, rooms: &RoomIndex) -> String {
    let idle = AgentFacts { status: "waiting".into(), current_action: None, parent_room: None, ..f.clone() };
    room_for(&idle, rooms)
}

/// Label and emoji shown above the character, from real state only.
pub fn label_for(f: &AgentFacts) -> (String, Option<&'static str>) {
    if f.paused && f.status != "working" && f.status != "retired" {
        return ("Paused by you".into(), Some("⏸️"));
    }
    match f.status.as_str() {
        "sleeping" => ("Sleeping (session stopped, wakes on the next message)".into(), Some("😴")),
        "offline" => ("Offline (no Claude Code session)".into(), Some("💤")),
        "stopped" => ("Stopped".into(), Some("⏹️")),
        "disconnected" => ("Disconnected".into(), Some("🔌")),
        "retired" => ("Retired".into(), None),
        "crashed" => ("Session crashed".into(), Some("❗")),
        "starting" => ("Starting Claude Code".into(), Some("⏳")),
        "awaiting_permission" => {
            (format!("Waiting for your approval: {}", f.current_action.as_deref().unwrap_or("tool call")), Some("✋"))
        }
        "working" => match &f.current_action {
            Some(a) => (format!("Working: {a}"), Some("⚙️")),
            None if f.thinking => ("Thinking".into(), Some("💭")),
            None => ("Working".into(), Some("💭")),
        },
        _ => match (f.task_status.as_deref(), &f.task_title) {
            (Some("completed"), Some(t)) => (format!("Finished: {t}"), Some("✅")),
            (Some("review"), Some(t)) => (format!("In review: {t}"), Some("🔎")),
            (Some("failed"), Some(t)) => (format!("Task failed: {t}"), Some("❗")),
            _ => ("Idle".into(), None),
        },
    }
}

/// Default character for agents that never customized theirs.
pub fn default_character(f: &AgentFacts) -> String {
    if f.is_central {
        return "f1".into();
    }
    let mut h: u32 = 2166136261;
    for b in f.id.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(16777619);
    }
    format!("f{}", 2 + h % 7)
}

pub fn to_nexus_agent(f: &AgentFacts, rooms: &RoomIndex) -> NexusAgent {
    let (label, emoji) = label_for(f);
    NexusAgent {
        nexus_id: f.id.clone(),
        name: f.name.clone(),
        role: f.role.clone(),
        character: f.character.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| default_character(f)),
        is_central: f.is_central,
        status: f.status.clone(),
        status_label: label.chars().take(120).collect(),
        zone: room_for(f, rooms),
        emoji: emoji.map(str::to_string),
        mission: f.mission.clone(),
        task: f.task_title.clone(),
        model: f.model.clone(),
        skills: f.skills.clone(),
        mcp: f.mcp.clone(),
        connections: f.connections.clone(),
        tint: f.tint.clone(),
        badge: f.badge.as_ref().map(|b| b.chars().take(8).collect()),
        rank: if f.rank.is_empty() { "specialist".into() } else { f.rank.clone() },
        parent_id: f.parent_id.clone(),
        provider: f.provider.clone(),
        paused: f.paused,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(status: &str) -> AgentFacts {
        AgentFacts {
            id: "w1".into(),
            name: "Worker".into(),
            role: "Backend".into(),
            status: status.into(),
            ..Default::default()
        }
    }

    fn building(kinds: &[&str]) -> RoomIndex {
        let mut c = crate::hq::WorldConfig::default();
        for k in kinds {
            c.rooms.push(crate::hq::Room::of_kind(k, "en"));
        }
        RoomIndex::new(&c)
    }

    fn hq() -> RoomIndex {
        building(&[
            "central_hq",
            "coding_office",
            "github_office",
            "server_room",
            "testing_lab",
            "review_room",
            "archive",
        ])
    }

    #[test]
    fn rooms_follow_real_activity() {
        let rooms = hq();
        let mut f = facts("working");
        f.current_action = Some("Bash: ssh pi@192.0.2.10 uptime".into());
        assert_eq!(room_for(&f, &rooms), "server_room");
        f.current_action = Some("Bash: npm test".into());
        assert_eq!(room_for(&f, &rooms), "testing_lab");
        f.current_action = Some("Edit src/app.ts".into());
        assert_eq!(room_for(&f, &rooms), "coding_office");
        // No Roblox room in this building: the agent stays in its own room.
        f.current_action = Some("mcp__Roblox_Studio__run_code".into());
        assert_eq!(room_for(&f, &rooms), "coding_office");
        let mut c = facts("working");
        c.is_central = true;
        c.current_action = Some("Bash: git status".into());
        assert_eq!(room_for(&c, &rooms), "central_hq");
        assert_eq!(room_for(&facts("retired"), &rooms), "archive");
        let mut r = facts("waiting");
        r.task_status = Some("review".into());
        assert_eq!(room_for(&r, &rooms), "review_room");
        // Idle specialists gather in their lieutenant's room; working ones go where they work.
        let mut d = facts("waiting");
        d.parent_room = Some("github_office".into());
        assert_eq!(room_for(&d, &rooms), "github_office");
        let mut w = facts("working");
        w.parent_room = Some("github_office".into());
        w.current_action = Some("Bash: npm test".into());
        assert_eq!(room_for(&w, &rooms), "testing_lab");
        // An empty building still gives a room.
        assert_eq!(room_for(&facts("waiting"), &building(&[])), "central_hq");
        let mut lead = facts("working");
        lead.role = "DevOps lead".into();
        lead.current_action = Some("Bash: npm test".into());
        assert_eq!(home_room(&lead, &rooms), "server_room");
    }

    #[test]
    fn dormant_and_paused_labels_are_real_states() {
        assert_eq!(label_for(&facts("sleeping")).1, Some("😴"));
        let mut p = facts("waiting");
        p.paused = true;
        assert_eq!(label_for(&p).0, "Paused by you");
        let mut p = facts("waiting");
        p.parent_id = Some("lead".into());
        p.rank = "lieutenant".into();
        let n = to_nexus_agent(&p, &hq());
        assert_eq!((n.rank.as_str(), n.parent_id.as_deref()), ("lieutenant", Some("lead")));
        assert_eq!(n.zone, "coding_office");
        assert_eq!(to_nexus_agent(&facts("waiting"), &hq()).rank, "specialist");
    }

    #[test]
    fn labels_never_claim_unobserved_work() {
        assert_eq!(label_for(&facts("waiting")).0, "Idle");
        assert_eq!(label_for(&facts("offline")).1, Some("💤"));
        let mut f = facts("working");
        assert_eq!(label_for(&f).0, "Working");
        f.thinking = true;
        assert_eq!(label_for(&f), ("Thinking".into(), Some("💭")));
        f.current_action = Some("Bash: ls".into());
        assert_eq!(label_for(&f).0, "Working: Bash: ls");
        let mut p = facts("awaiting_permission");
        p.current_action = Some("Bash: rm -rf build".into());
        assert_eq!(label_for(&p).1, Some("✋"));
        let mut done = facts("waiting");
        done.task_status = Some("completed".into());
        done.task_title = Some("Add login".into());
        assert_eq!(label_for(&done).0, "Finished: Add login");
    }

    #[test]
    fn characters_are_stable_and_valid() {
        let f = facts("waiting");
        let c = default_character(&f);
        assert_eq!(c, default_character(&f));
        let n: u32 = c[1..].parse().unwrap();
        assert!((2..=8).contains(&n));
        let mut central = facts("waiting");
        central.is_central = true;
        assert_eq!(to_nexus_agent(&central, &hq()).character, "f1");
    }
}
