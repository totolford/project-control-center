//! Request/response shapes shared with the UI (see `src/lib/types.ts`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use pcc_core::{
    Access, Agent, Capability, Connection, ConnectionKind, MissionView, PermissionRequest, PermissionSet, Priority,
    ProjectInfo, ProjectSettings, Task, TaskStatus,
};
use pcc_git::{BranchDiff, Commit, RepoStatus, Snapshot};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryAgent {
    pub agent_id: String,
    pub name: String,
    pub claude_session_id: Option<String>,
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryInfo {
    pub agents: Vec<RecoveryAgent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub info: ProjectInfo,
    pub settings: ProjectSettings,
    pub agents: Vec<Agent>,
    pub tasks: Vec<Task>,
    pub missions: Vec<MissionView>,
    pub connections: Vec<Connection>,
    pub pending_permissions: Vec<PermissionRequest>,
    pub repo: Option<RepoStatus>,
    pub recovery: Option<RecoveryInfo>,
    /// Emergency stop active: new work and autonomy are blocked.
    pub emergency: bool,
    /// Agents waiting for the user (secrets, SSH key setup, sign-in).
    pub user_requests: Vec<crate::admin::UserRequest>,
    pub compatibility: Option<pcc_store::compat::CompatibilityReport>,
    /// Compatibility mode: the project needs a newer NEXUS and nothing is written.
    pub read_only: bool,
    /// Migration performed while opening this project, if any.
    pub migration: Option<pcc_store::compat::MigrationReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSpec {
    pub id: Option<String>,
    /// Provider id; defaults to Claude Code.
    pub provider: Option<String>,
    pub name: String,
    pub role: String,
    pub instructions: Option<String>,
    /// Partial map; missing capabilities use the project defaults.
    pub permissions: Option<BTreeMap<Capability, Access>>,
    pub connections: Option<Vec<String>>,
    /// `auto` (worktree when available), `shared` or `worktree`.
    pub isolation: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentPatch {
    pub name: Option<String>,
    pub role: Option<String>,
    pub instructions: Option<String>,
    pub permissions: Option<PermissionSet>,
    pub connections: Option<Vec<String>>,
    /// `Some(None)` clears the model override.
    #[serde(default, deserialize_with = "double_option")]
    pub model: Option<Option<String>>,
    pub profile: Option<pcc_core::AgentProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskSpec {
    pub title: String,
    pub description: Option<String>,
    pub agent: Option<String>,
    pub dependencies: Option<Vec<String>>,
    pub priority: Option<Priority>,
    pub requires_review: Option<bool>,
    pub mission_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub agent: Option<Option<String>>,
    pub priority: Option<Priority>,
    pub status: Option<TaskStatus>,
    pub requires_review: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub name: String,
    pub kind: ConnectionKind,
    #[serde(default)]
    pub config: Value,
    #[serde(default)]
    pub secrets: Option<BTreeMap<String, String>>,
    /// `None` keeps the current state (enabled for new connections).
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentBranch {
    pub agent_id: String,
    pub branch: String,
    pub workdir: String,
    pub diff: Option<BranchDiff>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitOverview {
    pub status: RepoStatus,
    pub agents: Vec<AgentBranch>,
    pub recent_commits: Vec<Commit>,
    pub snapshots: Vec<Snapshot>,
}

/// Distinguishes an absent field from an explicit `null`.
fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_null_vs_absent() {
        let p: AgentPatch = serde_json::from_str(r#"{"model": null}"#).unwrap();
        assert_eq!(p.model, Some(None));
        let p: AgentPatch = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(p.model, None);
        let t: TaskPatch = serde_json::from_str(r#"{"agent": "x", "status": "in_progress"}"#).unwrap();
        assert_eq!(t.agent, Some(Some("x".into())));
        assert_eq!(t.status, Some(TaskStatus::InProgress));
    }
}
