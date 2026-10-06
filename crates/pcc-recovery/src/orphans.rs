//! Orphans and zombies left by a previous NEXUS run: processes from the
//! persisted registry that still exist (and really are the same process, not a
//! later one that reused the PID), and Claude Code sessions of a project that
//! no live NEXUS owns.
//!
//! Detection only. Cleaning one up goes through `cleanup_plan` and the caller
//! performs the steps in order: state check, soft attempt, recorded reason,
//! saved context, modified-files check — only then termination.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::registry::{ProcessKind, ProcessRecord};
use crate::sys::{CmdProc, ProcInfo};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Orphan {
    pub pid: u32,
    pub kind: ProcessKind,
    pub label: String,
    /// Why NEXUS thinks it is an orphan.
    pub reason: String,
    pub agent_id: Option<String>,
    pub mission_id: Option<String>,
    /// Shortened command line, when known.
    pub command: Option<String>,
    pub os_start_ms: Option<u64>,
    /// Registry key of the previous run, when it came from the snapshot.
    pub key: Option<String>,
}

/// Records of a previous run whose process still exists.
///
/// `probe` returns the live process with this PID (`None` when gone);
/// `name_of` its image name when the start time cannot be compared.
pub fn from_snapshot(
    previous: &[ProcessRecord],
    current_pid: u32,
    probe: &dyn Fn(u32) -> Option<ProcInfo>,
    name_of: &dyn Fn(u32) -> Option<String>,
    owner_alive: &dyn Fn(u32) -> bool,
) -> Vec<Orphan> {
    let mut out = Vec::new();
    for r in previous {
        let Some(pid) = r.pid else { continue };
        if r.state.is_ended() || pid == current_pid {
            continue;
        }
        // Still owned by a NEXUS that is running (this one or another instance).
        if r.owner_pid == current_pid || (r.owner_pid != 0 && owner_alive(r.owner_pid)) {
            continue;
        }
        let Some(info) = probe(pid) else { continue };
        let same = match crate::sys::same_start(r.os_start_ms, info.created_ms) {
            Some(same) => same,
            // No start time to compare: require the expected image name.
            None => match (&r.image, name_of(pid)) {
                (Some(want), Some(got)) => want.eq_ignore_ascii_case(&got),
                _ => false,
            },
        };
        if !same {
            continue; // the PID was reused by an unrelated process
        }
        out.push(Orphan {
            pid,
            kind: r.kind,
            label: r.label.clone(),
            reason: format!(
                "{} started by NEXUS (pid {}) at {} is still running; that NEXUS instance is gone",
                r.kind.label(),
                r.owner_pid,
                r.started_at
            ),
            agent_id: r.agent_id.clone(),
            mission_id: r.mission_id.clone(),
            command: r.command.clone(),
            os_start_ms: info.created_ms,
            key: Some(r.key.clone()),
        });
    }
    out
}

/// Claude Code sessions of a project that nobody owns: the command line
/// references the project's `.agent-project` folder (MCP config and system
/// prompt files live there) and the parent process is not a running NEXUS.
pub fn unowned_sessions(
    procs: &[CmdProc],
    agent_dir: &str,
    current_pid: u32,
    live_pids: &HashSet<u32>,
    parent_is_nexus: &dyn Fn(u32) -> bool,
) -> Vec<Orphan> {
    let marker = normalise(agent_dir);
    if marker.is_empty() {
        return Vec::new();
    }
    procs
        .iter()
        .filter(|p| p.pid != current_pid && !live_pids.contains(&p.pid))
        .filter_map(|p| {
            let cl = p.command_line.as_deref()?;
            let norm = normalise(cl);
            if !norm.contains(&marker) || !norm.contains("stream-json") {
                return None;
            }
            if p.ppid == current_pid || parent_is_nexus(p.ppid) {
                return None;
            }
            let agent = agent_from_command_line(cl);
            Some(Orphan {
                pid: p.pid,
                kind: ProcessKind::ClaudeSession,
                label: format!("Claude Code session{}", agent.as_ref().map(|a| format!(" of {a}")).unwrap_or_default()),
                reason: format!(
                    "Claude Code process of this project without a running NEXUS parent (parent pid {})",
                    p.ppid
                ),
                agent_id: agent,
                mission_id: None,
                command: Some(cl.chars().take(300).collect()),
                os_start_ms: None,
                key: None,
            })
        })
        .collect()
}

fn normalise(s: &str) -> String {
    s.replace('\\', "/").to_ascii_lowercase().trim_end_matches('/').to_string()
}

/// Agent id from `--mcp-config <...>/sessions/<agent>.mcp.json`.
pub fn agent_from_command_line(cl: &str) -> Option<String> {
    let norm = cl.replace('\\', "/");
    let i = norm.find("/sessions/")?;
    let rest = &norm[i + "/sessions/".len()..];
    let file = rest.split(['"', ' ']).next()?;
    let id = file.split('.').next()?;
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then(|| id.to_string())
}

/// Steps the caller performs before terminating an orphan, in order.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupStep {
    pub step: String,
    pub outcome: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::ProcessState;

    fn rec(pid: u32, owner: u32, start: Option<u64>, image: Option<&str>, state: ProcessState) -> ProcessRecord {
        ProcessRecord {
            key: format!("k{pid}"),
            kind: ProcessKind::ClaudeSession,
            label: "Builder".into(),
            pid: Some(pid),
            parent_pid: Some(owner),
            os_start_ms: start,
            image: image.map(str::to_string),
            owner_pid: owner,
            started_at: "t".into(),
            heartbeat_at: None,
            heartbeat_source: None,
            last_event: None,
            state,
            state_detail: None,
            project: None,
            mission_id: Some("M-0001".into()),
            agent_id: Some("builder".into()),
            restart_count: 0,
            restarts: vec![],
            command: None,
            ended_at: None,
            exit_code: None,
        }
    }

    #[test]
    fn snapshot_orphans_require_the_same_process() {
        let live = |pid: u32| -> Option<ProcInfo> {
            match pid {
                100 => Some(ProcInfo { pid, created_ms: Some(5_000), cpu_ms: None }),
                // PID reused by a later process.
                200 => Some(ProcInfo { pid, created_ms: Some(99_000_000), cpu_ms: None }),
                300 => Some(ProcInfo { pid, created_ms: None, cpu_ms: None }),
                400 => Some(ProcInfo { pid, created_ms: None, cpu_ms: None }),
                _ => None,
            }
        };
        let names = |pid: u32| match pid {
            300 => Some("claude.exe".to_string()),
            400 => Some("notepad.exe".to_string()),
            _ => None,
        };
        let dead_owner = |_: u32| false;
        let previous = vec![
            rec(100, 7, Some(5_500), None, ProcessState::Busy),        // orphan
            rec(200, 7, Some(5_000), None, ProcessState::Running),     // reused pid
            rec(300, 7, None, Some("claude.exe"), ProcessState::Idle), // orphan by name
            rec(400, 7, None, Some("claude.exe"), ProcessState::Idle), // other image
            rec(500, 7, Some(1), None, ProcessState::Running),         // gone
            rec(100, 7, Some(5_000), None, ProcessState::Crashed),     // ended record
            rec(100, 42, Some(5_000), None, ProcessState::Running),    // owned by this run
        ];
        let o = from_snapshot(&previous, 42, &live, &names, &dead_owner);
        let pids: Vec<u32> = o.iter().map(|x| x.pid).collect();
        assert_eq!(pids, vec![100, 300]);
        assert_eq!(o[0].agent_id.as_deref(), Some("builder"));
        // An owner that is still alive (another NEXUS window) keeps its processes.
        assert!(from_snapshot(&previous, 42, &live, &names, &|_| true).is_empty());
    }

    #[test]
    fn unowned_sessions_of_this_project() {
        let dir = r"C:\Proj\.agent-project";
        let cl = |agent: &str| {
            Some(format!(
                r#""C:\bin\claude.exe" -p --input-format stream-json --mcp-config C:\Proj\.agent-project\sessions\{agent}.mcp.json"#
            ))
        };
        let procs = vec![
            CmdProc { pid: 10, ppid: 1, name: "claude.exe".into(), command_line: cl("builder") }, // orphan
            CmdProc { pid: 11, ppid: 42, name: "claude.exe".into(), command_line: cl("central") }, // ours
            CmdProc { pid: 12, ppid: 77, name: "claude.exe".into(), command_line: cl("tester") }, // other NEXUS
            CmdProc { pid: 13, ppid: 1, name: "claude.exe".into(), command_line: Some("claude -p --resume x".into()) },
            CmdProc { pid: 14, ppid: 1, name: "claude.exe".into(), command_line: cl("known") }, // live session
            CmdProc {
                pid: 15,
                ppid: 1,
                name: "claude.exe".into(),
                command_line: Some(
                    r"claude --mcp-config C:\Other\.agent-project\sessions\a.mcp.json stream-json".into(),
                ),
            },
        ];
        let live: HashSet<u32> = [14].into_iter().collect();
        let o = unowned_sessions(&procs, dir, 42, &live, &|p| p == 77);
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].pid, 10);
        assert_eq!(o[0].agent_id.as_deref(), Some("builder"));
    }

    #[test]
    fn agent_id_from_command_line() {
        assert_eq!(
            agent_from_command_line(r#"x --mcp-config "C:\p\.agent-project\sessions\ui-dev.mcp.json" y"#).as_deref(),
            Some("ui-dev")
        );
        assert_eq!(agent_from_command_line("claude -p"), None);
    }
}
