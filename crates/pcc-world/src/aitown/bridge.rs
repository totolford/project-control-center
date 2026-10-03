//! Real NEXUS agent state → AI Town character state.
//!
//! Nothing here invents activity: the zone, label and emoji are derived only
//! from what NEXUS observed (agent status, current tool, task, messages).

use serde::Serialize;

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
}

fn has_any(text: &str, words: &[&str]) -> bool {
    words.iter().any(|w| text.contains(w))
}

/// Zone matching the agent's specialty, used when it works or idles.
fn home_zone(f: &AgentFacts) -> &'static str {
    if f.is_central {
        return "central_hq";
    }
    let role = format!("{} {}", f.role, f.name).to_ascii_lowercase();
    if has_any(&role, &["roblox", "luau"]) {
        "roblox_studio"
    } else if has_any(&role, &["design", "ui", "ux", "style", "brand"]) {
        "design_studio"
    } else if has_any(&role, &["test", "qa"]) {
        "testing_lab"
    } else if has_any(&role, &["review"]) {
        "review_room"
    } else if has_any(&role, &["devops", "server", "ssh", "infra", "deploy"]) {
        "server_room"
    } else if has_any(&role, &["git", "release"]) {
        "github_office"
    } else {
        "coding_office"
    }
}

/// Zone for what the agent is doing now (its current tool call).
fn action_zone(action: &str) -> Option<&'static str> {
    let a = action.to_ascii_lowercase();
    if has_any(&a, &["roblox"]) {
        Some("roblox_studio")
    } else if has_any(&a, &["ssh ", "scp ", "sftp"]) {
        Some("server_room")
    } else if has_any(&a, &["mcp__", "mcp "]) {
        Some("mcp_lab")
    } else if has_any(&a, &["skill"]) {
        Some("skill_shop")
    } else if has_any(&a, &["git ", "gh ", "github"]) {
        Some("github_office")
    } else if has_any(&a, &["test", "vitest", "jest", "pytest", "cargo check", "clippy", "lint"]) {
        Some("testing_lab")
    } else {
        None
    }
}

pub fn zone_for(f: &AgentFacts) -> &'static str {
    match f.status.as_str() {
        "retired" => "archive",
        "working" | "awaiting_permission" => {
            if f.is_central {
                return "central_hq";
            }
            f.current_action.as_deref().and_then(action_zone).unwrap_or_else(|| home_zone(f))
        }
        _ if f.task_status.as_deref() == Some("review") => "review_room",
        _ => home_zone(f),
    }
}

/// Label and emoji shown above the character, from real state only.
pub fn label_for(f: &AgentFacts) -> (String, Option<&'static str>) {
    match f.status.as_str() {
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

pub fn to_nexus_agent(f: &AgentFacts) -> NexusAgent {
    let (label, emoji) = label_for(f);
    NexusAgent {
        nexus_id: f.id.clone(),
        name: f.name.clone(),
        role: f.role.clone(),
        character: f.character.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| default_character(f)),
        is_central: f.is_central,
        status: f.status.clone(),
        status_label: label.chars().take(120).collect(),
        zone: zone_for(f).into(),
        emoji: emoji.map(str::to_string),
        mission: f.mission.clone(),
        task: f.task_title.clone(),
        model: f.model.clone(),
        skills: f.skills.clone(),
        mcp: f.mcp.clone(),
        connections: f.connections.clone(),
        tint: f.tint.clone(),
        badge: f.badge.as_ref().map(|b| b.chars().take(8).collect()),
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

    #[test]
    fn zones_follow_real_activity() {
        let mut f = facts("working");
        f.current_action = Some("Bash: ssh pi@192.0.2.10 uptime".into());
        assert_eq!(zone_for(&f), "server_room");
        f.current_action = Some("mcp__Roblox_Studio__run_code".into());
        assert_eq!(zone_for(&f), "roblox_studio");
        f.current_action = Some("Bash: npm test".into());
        assert_eq!(zone_for(&f), "testing_lab");
        f.current_action = Some("Edit src/app.ts".into());
        assert_eq!(zone_for(&f), "coding_office");
        let mut c = facts("working");
        c.is_central = true;
        c.current_action = Some("Bash: git status".into());
        assert_eq!(zone_for(&c), "central_hq");
        assert_eq!(zone_for(&facts("retired")), "archive");
        let mut r = facts("waiting");
        r.task_status = Some("review".into());
        assert_eq!(zone_for(&r), "review_room");
        let mut d = facts("waiting");
        d.role = "UI designer".into();
        assert_eq!(zone_for(&d), "design_studio");
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
        assert_eq!(to_nexus_agent(&central).character, "f1");
    }
}
