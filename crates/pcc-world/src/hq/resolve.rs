//! Which room an agent walks to, from what it really does.
//!
//! Order: Central → NEXUS HQ. A working agent goes to the room matching its
//! real current tool call (or the MCP server / connection it uses) when the
//! building has one; otherwise, and when idle, to the room Central assigned
//! it, then its supervising lieutenant's room, then the room matching its
//! role, then the Coding Office, then NEXUS HQ. Nothing here invents activity:
//! an empty room stays empty.

use super::catalog;
use super::config::WorldConfig;

#[derive(Debug, Clone)]
struct RoomInfo {
    id: String,
    kind: String,
    /// Lowercase name (custom rooms match agents' roles on it).
    text: String,
    agents: Vec<String>,
    required: Vec<String>,
}

/// The active rooms, ready for matching.
#[derive(Debug, Clone)]
pub struct RoomIndex {
    rooms: Vec<RoomInfo>,
}

/// What resolution needs about one agent.
#[derive(Debug, Clone, Default)]
pub struct Who<'a> {
    pub id: &'a str,
    pub is_central: bool,
    /// `AgentStatus` in snake_case.
    pub status: &'a str,
    pub role: &'a str,
    pub name: &'a str,
    pub current_action: Option<&'a str>,
    pub task_status: Option<&'a str>,
    /// Room of the supervising lieutenant (resolved first).
    pub parent_room: Option<&'a str>,
}

fn has_any(text: &str, words: &[String]) -> bool {
    words.iter().any(|w| !w.is_empty() && text.contains(w.as_str()))
}

/// Lowercase alphanumeric words of 4+ characters.
fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 4)
        .map(str::to_string)
        .collect()
}

impl RoomIndex {
    pub fn new(cfg: &WorldConfig) -> Self {
        let rooms = cfg
            .active_rooms()
            .map(|r| RoomInfo {
                id: r.id.clone(),
                kind: r.kind.clone(),
                text: r.name.to_lowercase(),
                agents: r.agents.clone(),
                required: r.required_connections.iter().map(|c| c.to_lowercase()).collect(),
            })
            .collect();
        RoomIndex { rooms }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.rooms.iter().any(|r| r.id == id)
    }

    pub fn ids(&self) -> Vec<String> {
        self.rooms.iter().map(|r| r.id.clone()).collect()
    }

    fn of_kind(&self, kind: &str) -> Option<&str> {
        self.rooms.iter().find(|r| r.kind == kind).map(|r| r.id.as_str())
    }

    pub fn hq(&self) -> Option<&str> {
        self.of_kind("central_hq").or_else(|| self.rooms.first().map(|r| r.id.as_str()))
    }

    /// Room assigned by Central.
    pub fn assigned(&self, agent: &str) -> Option<&str> {
        self.rooms.iter().find(|r| r.agents.iter().any(|a| a == agent)).map(|r| r.id.as_str())
    }

    /// Room for a real tool call: a room requiring the MCP server / connection
    /// named in it first, then the room type whose action words match.
    pub fn for_action(&self, action: &str) -> Option<&str> {
        let a = action.to_lowercase();
        // `mcp__Roblox_Studio__run_code` → "roblox studio".
        let mcp_server = a.strip_prefix("mcp__").and_then(|r| r.split("__").next()).map(|s| s.replace(['_', '-'], " "));
        if let Some(server) = &mcp_server {
            for r in &self.rooms {
                let hit = r.required.iter().any(|c| {
                    let c = c.trim_start_matches("mcp:").replace(['_', '-'], " ");
                    !c.is_empty() && (server.contains(&c) || c.contains(server.as_str()))
                });
                if hit {
                    return Some(&r.id);
                }
            }
        }
        for r in &self.rooms {
            if r.required.iter().any(|c| c.len() >= 3 && !c.starts_with("mcp:") && a.contains(&format!("{c} "))) {
                return Some(&r.id);
            }
        }
        // Most specific first: types listed later in this order win over the generic ones.
        const ORDER: &[&str] = &[
            "roblox_studio",
            "server_room",
            "database_room",
            "cicd_room",
            "testing_lab",
            "github_office",
            "skill_shop",
            "api_lab",
            "design_studio",
            "web_dev",
            "docs_room",
            "mcp_lab",
            "coding_office",
        ];
        for kind in ORDER {
            let Some(spec) = catalog::kind(kind) else { continue };
            if has_any(&a, &spec.actions) {
                if let Some(id) = self.of_kind(kind) {
                    return Some(id);
                }
            }
        }
        None
    }

    /// Home room from the agent's role and name.
    pub fn for_role(&self, role: &str, name: &str) -> Option<&str> {
        let text = format!(" {} {} ", role, name).to_lowercase();
        // A custom room whose name words appear in the role ("Payments API" ↔ "payments engineer").
        for r in self.rooms.iter().filter(|r| r.kind == "custom") {
            if words(&r.text).iter().any(|w| text.contains(w.as_str())) {
                return Some(&r.id);
            }
        }
        const ORDER: &[&str] = &[
            "roblox_studio",
            "design_studio",
            "testing_lab",
            "review_room",
            "database_room",
            "cicd_room",
            "server_room",
            "github_office",
            "api_lab",
            "web_dev",
            "docs_room",
            "mcp_lab",
            "skill_shop",
            "coding_office",
        ];
        for kind in ORDER {
            let Some(spec) = catalog::kind(kind) else { continue };
            if has_any(&text, &spec.roles) {
                if let Some(id) = self.of_kind(kind) {
                    return Some(id);
                }
            }
        }
        None
    }

    /// The room for `who`; `None` when it should not be shown (retired with no Archive).
    pub fn room_for(&self, who: &Who) -> Option<String> {
        if who.status == "retired" {
            return self.of_kind("archive").map(str::to_string);
        }
        if who.is_central {
            return self.hq().map(str::to_string);
        }
        let working = matches!(who.status, "working" | "awaiting_permission");
        let by_action = if working { who.current_action.and_then(|a| self.for_action(a)) } else { None };
        let review = (!working && who.task_status == Some("review")).then(|| self.of_kind("review_room")).flatten();
        by_action
            .or(review)
            .or_else(|| self.assigned(who.id))
            .or_else(|| who.parent_room.filter(|r| self.contains(r) && !working))
            .or_else(|| self.for_role(who.role, who.name))
            .or_else(|| self.of_kind("coding_office"))
            .or_else(|| self.hq())
            .map(str::to_string)
    }
}

#[cfg(test)]
mod tests {
    use super::super::config::Room;
    use super::*;

    fn index(kinds: &[&str]) -> (WorldConfig, RoomIndex) {
        let mut c = WorldConfig::default();
        for k in kinds {
            c.rooms.push(Room::of_kind(k, "en"));
        }
        let i = RoomIndex::new(&c);
        (c, i)
    }

    fn working(action: &str) -> Who<'static> {
        Who {
            id: "w1",
            status: "working",
            role: "Backend developer",
            name: "Ada",
            current_action: Some(Box::leak(action.to_string().into_boxed_str())),
            ..Default::default()
        }
    }

    #[test]
    fn agents_go_where_they_really_work() {
        let (_, i) =
            index(&["central_hq", "coding_office", "github_office", "server_room", "testing_lab", "database_room"]);
        assert_eq!(i.room_for(&working("Bash: ssh pi@192.0.2.10 uptime")).as_deref(), Some("server_room"));
        assert_eq!(i.room_for(&working("Bash: git push origin main")).as_deref(), Some("github_office"));
        assert_eq!(i.room_for(&working("Bash: npx vitest run")).as_deref(), Some("testing_lab"));
        assert_eq!(i.room_for(&working("Bash: psql -c 'select 1'")).as_deref(), Some("database_room"));
        assert_eq!(i.room_for(&working("Edit src/app.ts")).as_deref(), Some("coding_office"));
        // No MCP Lab in this building: an MCP call stays in the agent's own room.
        assert_eq!(i.room_for(&working("mcp__figma__get_file")).as_deref(), Some("coding_office"));
        let central = Who {
            id: "central",
            is_central: true,
            status: "working",
            current_action: Some("Bash: git status"),
            ..Default::default()
        };
        assert_eq!(i.room_for(&central).as_deref(), Some("central_hq"));
    }

    #[test]
    fn idle_agents_go_to_their_assigned_or_home_room() {
        let (mut c, _) = index(&["central_hq", "coding_office", "server_room", "review_room"]);
        let idle = Who { id: "w1", status: "waiting", role: "DevOps engineer", name: "Ops", ..Default::default() };
        assert_eq!(RoomIndex::new(&c).room_for(&idle).as_deref(), Some("server_room"));
        c.rooms[1].agents.push("w1".into());
        assert_eq!(RoomIndex::new(&c).room_for(&idle).as_deref(), Some("coding_office"));
        let review = Who { task_status: Some("review"), ..idle.clone() };
        assert_eq!(RoomIndex::new(&c).room_for(&review).as_deref(), Some("review_room"));
        let retired = Who { status: "retired", ..idle };
        assert_eq!(RoomIndex::new(&c).room_for(&retired), None, "no Archive room: not shown");
    }

    #[test]
    fn rooms_with_required_connections_and_custom_rooms() {
        let (mut c, _) = index(&["central_hq", "coding_office", "mcp_lab"]);
        let mut roblox = Room::of_kind("custom", "en");
        roblox.id = "game-studio".into();
        roblox.name = "Game Studio".into();
        roblox.required_connections = vec!["mcp:Roblox_Studio".into()];
        c.rooms.push(roblox);
        let i = RoomIndex::new(&c);
        assert_eq!(i.room_for(&working("mcp__Roblox_Studio__run_code")).as_deref(), Some("game-studio"));
        assert_eq!(i.room_for(&working("mcp__github__list_issues")).as_deref(), Some("mcp_lab"));
        let gamer = Who { id: "g", status: "waiting", role: "Game designer", name: "G", ..Default::default() };
        assert_eq!(i.room_for(&gamer).as_deref(), Some("game-studio"));
    }
}
