//! Decides what happens when an agent's session asks to use a tool.

use std::path::PathBuf;

use serde_json::Value;

use pcc_core::permissions::{classify_tool, ToolClassification};
use pcc_core::{
    Access, Agent, AgentKind, AutonomySettings, Capability, Connection, ConnectionKind, MasterControl, PermissionSet,
    PowerLevel,
};

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Allow,
    Deny(String),
    /// Ask the user. Carries the classification to build the request.
    Ask {
        reason: String,
        class: ToolClassification,
    },
    /// Would ask, but CLAUDE UNLOCKED auto-approval answers on the user's behalf.
    AutoApprove {
        reason: String,
        class: ToolClassification,
    },
}

/// Whether MASTER CONTROL applies to this agent (Central only).
pub fn mastered(agent: &Agent, master: &MasterControl) -> bool {
    master.active && agent.kind == AgentKind::Central
}

/// Whether a MASTER CONTROL scope covers connections of this kind.
pub fn master_covers_connection(master: &MasterControl, kind: ConnectionKind) -> bool {
    match kind {
        ConnectionKind::Mcp | ConnectionKind::RobloxStudio => master.mcp,
        ConnectionKind::Ssh | ConnectionKind::Sftp => master.ssh,
        ConnectionKind::Github | ConnectionKind::Gitlab => master.github,
        _ => master.pc,
    }
}

/// Capabilities opened by each MASTER CONTROL scope.
fn master_scope_allows(master: &MasterControl, c: Capability) -> bool {
    match c {
        Capability::FsRead
        | Capability::FsWrite
        | Capability::FsExecute
        | Capability::Network
        | Capability::GitRead
        | Capability::GitWrite => master.pc,
        Capability::GithubRead | Capability::GithubWrite | Capability::GithubAdmin => master.github,
        Capability::SshRead | Capability::SshExecute => master.ssh,
        Capability::Mcp => master.mcp,
    }
}

/// The permissions actually enforced for an agent: MASTER CONTROL (Central,
/// per scope) over CLAUDE UNLOCKED (everyone) over the agent's own set.
pub fn effective_permissions(agent: &Agent, autonomy: &AutonomySettings, master: &MasterControl) -> PermissionSet {
    let base = if autonomy.unlocked { autonomy.unlocked_permissions.clone() } else { agent.permissions.clone() };
    if !mastered(agent, master) {
        return base;
    }
    let max = PermissionSet::preset(PowerLevel::Maximum);
    let mut out = base;
    for c in Capability::ALL {
        if master_scope_allows(master, c) {
            out.set(c, max.get(c));
        }
    }
    out
}

pub struct PolicyInput<'a> {
    pub agent: &'a Agent,
    pub project_root: PathBuf,
    pub connections: &'a [Connection],
    /// Returns true when the user chose "allow for this agent" for this key.
    pub has_rule: &'a dyn Fn(&str) -> bool,
    pub autonomy: &'a AutonomySettings,
    pub master: &'a MasterControl,
}

pub fn evaluate(p: &PolicyInput<'_>, tool: &str, input: &Value) -> Decision {
    match evaluate_rules(p, tool, input) {
        Decision::Ask { reason, class } if auto_approvable(p.autonomy, mastered(p.agent, p.master), &class) => {
            Decision::AutoApprove { reason, class }
        }
        d => d,
    }
}

fn auto_approvable(a: &AutonomySettings, master: bool, class: &ToolClassification) -> bool {
    (master || (a.unlocked && a.auto_approve))
        && !(class.destructive && a.manual_for_destructive)
        && !(class.outside_workspace && a.manual_for_outside_workspace)
        && !class.capability.is_some_and(|c| a.manual_capabilities.contains(&c))
}

fn evaluate_rules(p: &PolicyInput<'_>, tool: &str, input: &Value) -> Decision {
    // The orchestrator's own tools validate their arguments themselves.
    if tool.starts_with("mcp__pcc__") {
        return Decision::Allow;
    }
    let workdir = PathBuf::from(&p.agent.workdir);
    let mut workspaces = vec![workdir.clone()];
    let class0 = classify_tool(tool, input, &workspaces);
    // Reading the main project folder is fine for worktree agents too.
    if class0.capability == Some(Capability::FsRead) && workdir != p.project_root {
        workspaces.push(p.project_root.clone());
    }
    let mut class = classify_tool(tool, input, &workspaces);
    let Some(cap) = class.capability else {
        return Decision::Allow;
    };

    // Connection scoping.
    if let Some(server) = &class.mcp_server {
        let conn = p.connections.iter().find(|c| &c.id == server);
        match conn {
            Some(c) if !c.enabled => return Decision::Deny(format!("connection `{}` is disabled", c.name)),
            Some(c) if p.agent.connections.contains(&c.id) => {}
            Some(_) if mastered(p.agent, p.master) && p.master.mcp => {}
            Some(c) => {
                return Decision::Deny(format!("connection `{}` is not granted to agent {}", c.name, p.agent.id))
            }
            None => return Decision::Deny(format!("unknown MCP server `{server}`")),
        }
    }
    if let Some(host) = &class.ssh_host {
        let conn = p.connections.iter().find(|c| {
            matches!(c.kind, ConnectionKind::Ssh | ConnectionKind::Sftp)
                && c.config.get("host").and_then(Value::as_str).is_some_and(|h| h.eq_ignore_ascii_case(host))
        });
        match conn {
            Some(c) if !c.enabled => return Decision::Deny(format!("connection `{}` is disabled", c.name)),
            Some(c) if p.agent.connections.contains(&c.id) => {}
            Some(_) if mastered(p.agent, p.master) && p.master.ssh => {}
            Some(c) => {
                return Decision::Deny(format!("SSH connection `{}` is not granted to agent {}", c.name, p.agent.id))
            }
            None => {
                return Decision::Ask {
                    reason: format!("SSH to `{host}`, which is not a configured project connection"),
                    class,
                }
            }
        }
    }

    let access = effective_permissions(p.agent, p.autonomy, p.master).get(cap);
    if access == Access::Deny {
        return Decision::Deny(format!(
            "agent {} does not have the `{}` permission; ask Central or the user if it is needed",
            p.agent.id,
            cap.as_str()
        ));
    }
    if class.destructive {
        // "Allow always" on a destructive command only covers that exact command.
        class.rule_key = format!("{tool}!{}", input.get("command").and_then(Value::as_str).unwrap_or(tool));
        return if (p.has_rule)(&class.rule_key) {
            Decision::Allow
        } else {
            Decision::Ask { reason: "potentially destructive action".into(), class }
        };
    }
    if class.outside_workspace {
        class.rule_key = format!("{}:outside", class.rule_key);
        return if (p.has_rule)(&class.rule_key) {
            Decision::Allow
        } else {
            Decision::Ask { reason: format!("path outside the agent workspace ({})", p.agent.workdir), class }
        };
    }
    match access {
        Access::Allow => Decision::Allow,
        Access::Ask if (p.has_rule)(&class.rule_key) => Decision::Allow,
        Access::Ask => Decision::Ask { reason: format!("`{}` requires approval for this agent", cap.as_str()), class },
        Access::Deny => unreachable!("handled above"),
    }
}

/// Built-in Claude Code tools enabled for a permission set (`--tools`).
pub fn builtin_tools(perms: &PermissionSet) -> Vec<String> {
    let on = |c: Capability| perms.get(c) != Access::Deny;
    let mut t: Vec<&str> = vec!["Read", "Glob", "Grep", "TodoWrite"];
    if on(Capability::FsWrite) {
        t.extend(["Edit", "Write", "NotebookEdit"]);
    }
    let shell = [
        Capability::FsExecute,
        Capability::GitRead,
        Capability::GitWrite,
        Capability::GithubRead,
        Capability::GithubWrite,
        Capability::SshRead,
        Capability::SshExecute,
    ];
    if shell.into_iter().any(on) {
        t.extend(["Bash", "PowerShell"]);
    }
    if on(Capability::Network) {
        t.extend(["WebFetch", "WebSearch"]);
    }
    t.into_iter().map(str::to_string).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcc_core::{AgentStatus, ConnectionStatus, Isolation};
    use serde_json::json;

    fn agent(perms: PermissionSet, conns: &[&str]) -> Agent {
        Agent {
            id: "movement".into(),
            name: "Movement".into(),
            kind: AgentKind::Worker,
            provider: pcc_core::CLAUDE_CODE_PROVIDER.into(),
            role: "r".into(),
            instructions: String::new(),
            status: AgentStatus::Working,
            model: None,
            permissions: perms,
            connections: conns.iter().map(|s| s.to_string()).collect(),
            isolation: Isolation::Worktree,
            workdir: r"C:\P\.agent-project\worktrees\movement".into(),
            branch: Some("agent/movement".into()),
            current_task: None,
            current_action: None,
            progress: None,
            claude_session_id: None,
            total_cost_usd: 0.0,
            profile: Default::default(),
            created_by: "central".into(),
            created_at: String::new(),
            updated_at: String::new(),
            parent_agent: None,
            rank: Default::default(),
            paused_at: None,
        }
    }

    fn conn(id: &str, kind: ConnectionKind, config: Value) -> Connection {
        Connection {
            id: id.into(),
            name: id.into(),
            kind,
            config,
            credential_ref: None,
            status: ConnectionStatus::Connected,
            status_detail: None,
            last_checked: None,
            created_at: String::new(),
            enabled: true,
            last_used: None,
        }
    }

    fn eval_with(
        a: &Agent,
        conns: &[Connection],
        tool: &str,
        input: Value,
        rules: &[&str],
        autonomy: &AutonomySettings,
    ) -> Decision {
        let rules: Vec<String> = rules.iter().map(|s| s.to_string()).collect();
        let has = |k: &str| rules.iter().any(|r| r == k);
        evaluate(
            &PolicyInput {
                agent: a,
                project_root: PathBuf::from(r"C:\P"),
                connections: conns,
                has_rule: &has,
                autonomy,
                master: &MasterControl::default(),
            },
            tool,
            &input,
        )
    }

    #[test]
    fn master_control_opens_scopes_for_central_only() {
        let conns = vec![
            conn("roblox-studio", ConnectionKind::RobloxStudio, json!({})),
            conn("pi", ConnectionKind::Ssh, json!({"host": "192.168.1.157", "user": "pi"})),
        ];
        let mut central = agent(PermissionSet::central(), &[]);
        central.kind = AgentKind::Central;
        let master = MasterControl { active: true, ssh: false, ..Default::default() };
        let run = |a: &Agent, tool: &str, input: Value| {
            let has = |_: &str| false;
            evaluate(
                &PolicyInput {
                    agent: a,
                    project_root: PathBuf::from(r"C:\P"),
                    connections: &conns,
                    has_rule: &has,
                    autonomy: &AutonomySettings::default(),
                    master: &master,
                },
                tool,
                &input,
            )
        };
        // MCP scope on: any enabled MCP connection, without a grant.
        assert_eq!(run(&central, "mcp__roblox-studio__run_code", json!({})), Decision::Allow);
        // Network was "ask" for Central; master opens it.
        assert_eq!(run(&central, "WebFetch", json!({"url": "https://x"})), Decision::Allow);
        // SSH scope off: grants still required.
        assert!(matches!(run(&central, "Bash", json!({"command": "ssh pi@192.168.1.157 uptime"})), Decision::Deny(_)));
        // Destructive stays manual (autonomy default keeps it manual).
        assert!(matches!(run(&central, "Bash", json!({"command": "rm -rf build"})), Decision::Ask { .. }));
        // Workers are unaffected.
        let worker = agent(PermissionSet::worker_default(), &[]);
        assert!(matches!(run(&worker, "mcp__roblox-studio__run_code", json!({})), Decision::Deny(_)));
    }

    fn eval(a: &Agent, conns: &[Connection], tool: &str, input: Value, rules: &[&str]) -> Decision {
        eval_with(a, conns, tool, input, rules, &AutonomySettings::default())
    }

    #[test]
    fn unlocked_and_auto_approve() {
        let a = agent(PermissionSet::preset(pcc_core::PowerLevel::Low), &[]);
        let wt = r"C:\P\.agent-project\worktrees\movement";
        let file = json!({"file_path": format!(r"{wt}\a.txt")});
        // Locked: low power cannot write.
        assert!(matches!(eval(&a, &[], "Write", file.clone(), &[]), Decision::Deny(_)));
        // Unlocked: maximum preset applies.
        let mut auto = AutonomySettings { unlocked: true, ..Default::default() };
        assert_eq!(eval_with(&a, &[], "Write", file.clone(), &[], &auto), Decision::Allow);
        // Destructive still asks without auto-approve...
        assert!(matches!(
            eval_with(&a, &[], "Bash", json!({"command": "rm -rf build"}), &[], &auto),
            Decision::Ask { .. }
        ));
        auto.auto_approve = true;
        // ...and with auto-approve, because destructive stays manual by default.
        assert!(matches!(
            eval_with(&a, &[], "Bash", json!({"command": "rm -rf build"}), &[], &auto),
            Decision::Ask { .. }
        ));
        auto.manual_for_destructive = false;
        assert!(matches!(
            eval_with(&a, &[], "Bash", json!({"command": "rm -rf build"}), &[], &auto),
            Decision::AutoApprove { .. }
        ));
        // Outside the workspace stays manual by default.
        assert!(matches!(
            eval_with(&a, &[], "Write", json!({"file_path": r"C:\Windows\x"}), &[], &auto),
            Decision::Ask { .. }
        ));
        // Auto-approve never applies while locked.
        let locked = AutonomySettings { auto_approve: true, manual_for_destructive: false, ..Default::default() };
        let w = agent(PermissionSet::worker_default(), &[]);
        assert!(matches!(
            eval_with(&w, &[], "Bash", json!({"command": "rm -rf build"}), &[], &locked),
            Decision::Ask { .. }
        ));
    }

    #[test]
    fn disabled_connections_are_denied() {
        let mut c = conn("roblox-studio", ConnectionKind::RobloxStudio, json!({}));
        c.enabled = false;
        let a = agent(PermissionSet::worker_default(), &["roblox-studio"]);
        assert!(matches!(eval(&a, &[c], "mcp__roblox-studio__run_code", json!({}), &[]), Decision::Deny(_)));
    }

    #[test]
    fn worker_defaults() {
        let a = agent(PermissionSet::worker_default(), &[]);
        let wt = r"C:\P\.agent-project\worktrees\movement";
        assert_eq!(eval(&a, &[], "Edit", json!({"file_path": format!(r"{wt}\src\a.luau")}), &[]), Decision::Allow);
        assert_eq!(eval(&a, &[], "Read", json!({"file_path": r"C:\P\README.md"}), &[]), Decision::Allow);
        assert!(matches!(eval(&a, &[], "Write", json!({"file_path": r"C:\P\src\a.luau"}), &[]), Decision::Ask { .. }));
        assert_eq!(eval(&a, &[], "Bash", json!({"command": "npm test"}), &[]), Decision::Allow);
        assert!(matches!(eval(&a, &[], "Bash", json!({"command": "rm -rf build"}), &[]), Decision::Ask { .. }));
        assert_eq!(eval(&a, &[], "Bash", json!({"command": "rm -rf build"}), &["Bash!rm -rf build"]), Decision::Allow);
        assert!(matches!(
            eval(&a, &[], "Bash", json!({"command": "rm -rf src"}), &["Bash!rm -rf build"]),
            Decision::Ask { .. }
        ));
        assert!(matches!(eval(&a, &[], "WebFetch", json!({"url": "https://x"}), &[]), Decision::Ask { .. }));
        assert_eq!(eval(&a, &[], "WebFetch", json!({"url": "https://y"}), &["WebFetch"]), Decision::Allow);
        assert!(matches!(
            eval(&a, &[], "Bash", json!({"command": "gh repo delete x/y --yes"}), &[]),
            Decision::Deny(_) | Decision::Ask { .. }
        ));
        assert_eq!(eval(&a, &[], "mcp__pcc__complete_task", json!({}), &[]), Decision::Allow);
    }

    #[test]
    fn connections_are_scoped() {
        let conns = vec![
            conn("roblox-studio", ConnectionKind::RobloxStudio, json!({})),
            conn("prod", ConnectionKind::Ssh, json!({"host": "192.168.1.50", "user": "admin"})),
        ];
        let without = agent(PermissionSet::worker_default(), &[]);
        assert!(matches!(eval(&without, &conns, "mcp__roblox-studio__run_code", json!({}), &[]), Decision::Deny(_)));
        assert!(matches!(
            eval(&without, &conns, "Bash", json!({"command": "ssh admin@192.168.1.50 uptime"}), &[]),
            Decision::Deny(_)
        ));
        let with = agent(PermissionSet::worker_default(), &["roblox-studio", "prod"]);
        assert_eq!(eval(&with, &conns, "mcp__roblox-studio__run_code", json!({}), &[]), Decision::Allow);
        // SshExecute defaults to Ask even when granted.
        assert!(matches!(
            eval(&with, &conns, "Bash", json!({"command": "ssh admin@192.168.1.50 uptime"}), &[]),
            Decision::Ask { .. }
        ));
        assert!(matches!(eval(&with, &conns, "mcp__unknown__x", json!({}), &[]), Decision::Deny(_)));
    }

    #[test]
    fn denied_capability_and_tools() {
        let mut p = PermissionSet::worker_default();
        p.set(Capability::FsWrite, Access::Deny);
        p.set(Capability::Network, Access::Deny);
        let a = agent(p.clone(), &[]);
        assert!(matches!(eval(&a, &[], "Edit", json!({"file_path": "x"}), &[]), Decision::Deny(_)));
        let tools = builtin_tools(&p);
        assert!(!tools.contains(&"Edit".to_string()));
        assert!(!tools.contains(&"WebFetch".to_string()));
        assert!(tools.contains(&"Bash".to_string()));
    }
}
