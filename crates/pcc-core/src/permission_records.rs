//! Permission requests as persistent records.
//!
//! A request is never just dropped: every state change is stored and
//! emitted, and acting on a request that already ended (double click, stale
//! list, restart) gets a typed, human answer instead of a raw "not found".

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::{AgentStatus, PermissionDecision, PermissionRequest};
use crate::permissions::ToolClassification;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionStatus {
    /// Waiting for the user.
    Pending,
    /// The user allowed it; the answer is being delivered or the action applied.
    Approved,
    /// The user (or an emergency stop) refused it; the agent was told.
    Denied,
    /// Nobody answered in time; the agent received a refusal.
    Expired,
    /// Withdrawn without a decision (agent stopped on purpose, retired...).
    Cancelled,
    /// The approval was written to the live session or the approved action ran.
    Consumed,
    /// The session ended before an answer could be delivered.
    Lost,
    /// Re-linked after a restart: the agent asked again for the same action,
    /// or a request that survives restarts (merge, admin) is waiting again.
    Recovered,
}

impl PermissionStatus {
    pub const ALL: [PermissionStatus; 8] = [
        PermissionStatus::Pending,
        PermissionStatus::Approved,
        PermissionStatus::Denied,
        PermissionStatus::Expired,
        PermissionStatus::Cancelled,
        PermissionStatus::Consumed,
        PermissionStatus::Lost,
        PermissionStatus::Recovered,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionStatus::Pending => "pending",
            PermissionStatus::Approved => "approved",
            PermissionStatus::Denied => "denied",
            PermissionStatus::Expired => "expired",
            PermissionStatus::Cancelled => "cancelled",
            PermissionStatus::Consumed => "consumed",
            PermissionStatus::Lost => "lost",
            PermissionStatus::Recovered => "recovered",
        }
    }
    pub fn parse(s: &str) -> Option<PermissionStatus> {
        PermissionStatus::ALL.into_iter().find(|p| p.as_str() == s)
    }
    /// Still waiting for a user decision.
    pub fn is_open(self) -> bool {
        matches!(self, PermissionStatus::Pending | PermissionStatus::Recovered)
    }
}

/// What answering the request does.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PermissionKind {
    /// A Claude Code `can_use_tool` prompt: only the live session can receive the answer.
    #[default]
    Tool,
    /// Merge of an agent branch, executed by NEXUS on approval.
    Merge,
    /// Connection change Central asked for, executed by NEXUS on approval.
    Admin,
}

/// One permission request and everything that happened to it.
///
/// The first fields mirror [`PermissionRequest`] so the UI can use a record
/// wherever it used a request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRecord {
    pub id: String,
    pub agent_id: String,
    /// Action: the tool (`Bash`, `Edit`, `merge_agent_work`...).
    pub tool_name: String,
    /// Capability the action needs (`shell`, `fs_write`, `git_write`...).
    pub capability: String,
    pub summary: String,
    pub input: Value,
    pub reason: String,
    pub rule_key: String,
    pub created_at: String,

    pub status: PermissionStatus,
    pub kind: PermissionKind,
    pub updated_at: String,
    /// `None` = never expires.
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub mission_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    /// What the action touches: path, host, command, URL, MCP server.
    #[serde(default)]
    pub resource: Option<String>,
    /// `destructive`, `outside_workspace`, `capability` or `approval`.
    #[serde(default)]
    pub risk: String,
    /// Agent (or `system`) that asked.
    #[serde(default)]
    pub requested_by: String,
    /// PID of the agent's Claude Code process when the request was made.
    #[serde(default)]
    pub process_id: Option<u32>,
    /// Session generation that must receive the answer (tool requests).
    #[serde(default)]
    pub session_epoch: u64,
    /// Row of the session in the `sessions` table.
    #[serde(default)]
    pub session_row: i64,
    /// Claude Code control request id (tool requests).
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub decision: Option<PermissionDecision>,
    #[serde(default)]
    pub decided_at: Option<String>,
    /// `user`, `timeout`, `emergency`, `system`.
    #[serde(default)]
    pub decided_by: Option<String>,
    /// Why the request reached its current state, in words.
    #[serde(default)]
    pub resolution: Option<String>,
    /// How many times the request was re-linked after its session was lost.
    #[serde(default)]
    pub recoveries: u32,
    /// Data needed to apply a merge/admin request after a restart (never secrets).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_data: Option<Value>,
}

impl PermissionRecord {
    pub fn new(req: PermissionRequest, kind: PermissionKind) -> PermissionRecord {
        PermissionRecord {
            requested_by: req.agent_id.clone(),
            updated_at: req.created_at.clone(),
            id: req.id,
            agent_id: req.agent_id,
            tool_name: req.tool_name,
            capability: req.capability,
            summary: req.summary,
            input: req.input,
            reason: req.reason,
            rule_key: req.rule_key,
            created_at: req.created_at,
            status: PermissionStatus::Pending,
            kind,
            expires_at: None,
            mission_id: None,
            task_id: None,
            resource: None,
            risk: if kind == PermissionKind::Tool { "capability".into() } else { "approval".into() },
            process_id: None,
            session_epoch: 0,
            session_row: 0,
            request_id: None,
            tool_use_id: None,
            decision: None,
            decided_at: None,
            decided_by: None,
            resolution: None,
            recoveries: 0,
            resume_data: None,
        }
    }

    /// The request as the UI's permission prompt knows it.
    pub fn request(&self) -> PermissionRequest {
        PermissionRequest {
            id: self.id.clone(),
            agent_id: self.agent_id.clone(),
            tool_name: self.tool_name.clone(),
            capability: self.capability.clone(),
            summary: self.summary.clone(),
            input: self.input.clone(),
            reason: self.reason.clone(),
            rule_key: self.rule_key.clone(),
            created_at: self.created_at.clone(),
        }
    }

    /// Same action as another request (same agent, tool and input).
    pub fn same_action(&self, agent: &str, tool: &str, input: &Value) -> bool {
        self.agent_id == agent && self.tool_name == tool && &self.input == input
    }
}

/// Risk label and touched resource of a tool call, from its classification.
pub fn tool_risk(tool: &str, input: &Value, class: &ToolClassification) -> (String, Option<String>) {
    let risk = if class.destructive {
        "destructive"
    } else if class.outside_workspace {
        "outside_workspace"
    } else {
        "capability"
    };
    let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    let resource = match tool {
        "Bash" | "PowerShell" => class.ssh_host.clone().or_else(|| s("command")),
        "WebFetch" => s("url"),
        "WebSearch" => s("query"),
        _ if class.mcp_server.is_some() => class.mcp_server.clone(),
        _ => s("file_path").or_else(|| s("path")).or_else(|| s("notebook_path")),
    };
    (risk.into(), resource)
}

/// Answer to `resolve_permission`. Acting twice, too late or on an unknown
/// id is not an error: `applied` is false and `message` says what happened.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOutcome {
    pub id: String,
    /// The decision was taken into account now.
    pub applied: bool,
    /// State after the call (`None`: the id is unknown in this project).
    pub status: Option<PermissionStatus>,
    pub message: String,
    pub record: Option<PermissionRecord>,
}

/// Real state of a permission request and of the agent behind it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatusReport {
    pub id: String,
    pub found: bool,
    pub record: Option<PermissionRecord>,
    /// One paragraph for the user.
    pub explanation: String,
    pub agent_name: Option<String>,
    pub agent_status: Option<AgentStatus>,
    /// The agent has a live Claude Code session right now.
    pub session_alive: bool,
    /// PID of the live session, if any.
    pub process_id: Option<u32>,
    /// The session that asked is the one running now.
    pub same_session: bool,
    /// Whether the action ran: `Some(true)` from the command journal, `None` when unknown.
    pub executed: Option<bool>,
    pub execution_detail: Option<String>,
    /// The user can ask the agent to try again.
    pub can_rerequest: bool,
}

/// Readable form of a stored timestamp (`2026-10-03 14:03:12 UTC`).
pub fn human_time(ts: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(ts) {
        Ok(t) => t.with_timezone(&chrono::Utc).format("%Y-%m-%d %H:%M:%S UTC").to_string(),
        Err(_) => ts.to_string(),
    }
}

fn decision_word(allow: bool) -> &'static str {
    if allow {
        "approved"
    } else {
        "denied"
    }
}

/// Explains a request's current state in one paragraph.
pub fn explain(r: &PermissionRecord) -> String {
    let at = human_time(r.decided_at.as_deref().unwrap_or(&r.updated_at));
    let why = r.resolution.as_deref().map(|w| format!(" ({w})")).unwrap_or_default();
    match r.status {
        PermissionStatus::Pending => "Waiting for your decision.".into(),
        PermissionStatus::Recovered => {
            "Waiting for your decision again: it was re-linked after the agent's session was restored.".into()
        }
        PermissionStatus::Approved => format!("Already approved at {at}; the approved action is being applied."),
        PermissionStatus::Consumed => match r.kind {
            PermissionKind::Tool => {
                format!("Already approved at {at}; the approval was delivered to the agent's session.")
            }
            _ => format!("Already approved at {at}; the approved action was applied{why}."),
        },
        PermissionStatus::Denied => {
            let by = match r.decided_by.as_deref() {
                Some("emergency") => " by the emergency stop",
                _ => "",
            };
            format!("Already denied{by} at {at}. The agent was told; it will ask again if it still needs it.")
        }
        PermissionStatus::Expired => format!(
            "Expired at {at}: nobody answered in time{why}. The agent received a refusal and continued without it; it will ask again if it still needs it."
        ),
        PermissionStatus::Lost => format!(
            "Lost: the agent's session ended at {at} before an answer could be delivered{why}. The agent will ask again if it still needs it."
        ),
        PermissionStatus::Cancelled => format!("Cancelled at {at}{why}. Nothing was executed for this request."),
    }
}

/// Outcome of a decision on a request that is no longer open.
pub fn closed_outcome(r: &PermissionRecord, decision: PermissionDecision) -> PermissionOutcome {
    let wanted = decision != PermissionDecision::Reject;
    let previous = r.decision.map(|d| d != PermissionDecision::Reject);
    let message = match (r.status, previous) {
        (PermissionStatus::Approved | PermissionStatus::Consumed | PermissionStatus::Denied, Some(was))
            if was == wanted =>
        {
            format!(
                "Already {} at {}.",
                decision_word(was),
                human_time(r.decided_at.as_deref().unwrap_or(&r.updated_at))
            )
        }
        (PermissionStatus::Approved | PermissionStatus::Consumed | PermissionStatus::Denied, Some(was)) => format!(
            "This request was already {} at {}; a decision cannot be changed once delivered. {}",
            decision_word(was),
            human_time(r.decided_at.as_deref().unwrap_or(&r.updated_at)),
            if was {
                "To stop the action now, interrupt or stop the agent."
            } else {
                "The agent will ask again if it still needs it."
            }
        ),
        _ => explain(r),
    };
    PermissionOutcome { id: r.id.clone(), applied: false, status: Some(r.status), message, record: Some(r.clone()) }
}

/// Outcome for an id this project has never seen.
pub fn unknown_outcome(id: &str) -> PermissionOutcome {
    PermissionOutcome {
        id: id.into(),
        applied: false,
        status: None,
        message: format!(
            "This permission request is no longer available: {id} is not known in this project (it may come from another project or an outdated window)."
        ),
        record: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(status: PermissionStatus, decision: Option<PermissionDecision>) -> PermissionRecord {
        let mut r = PermissionRecord::new(
            PermissionRequest {
                id: "perm-1".into(),
                agent_id: "ops".into(),
                tool_name: "Bash".into(),
                capability: "shell".into(),
                summary: "Bash: rm -rf build".into(),
                input: json!({"command": "rm -rf build"}),
                reason: "destructive".into(),
                rule_key: "Bash:rm".into(),
                created_at: "2026-10-03T10:00:00.000Z".into(),
            },
            PermissionKind::Tool,
        );
        r.status = status;
        r.decision = decision;
        r.decided_at = Some("2026-10-03T10:05:00.000Z".into());
        r
    }

    #[test]
    fn status_round_trip_and_open_states() {
        for s in PermissionStatus::ALL {
            assert_eq!(PermissionStatus::parse(s.as_str()), Some(s));
        }
        assert!(PermissionStatus::Recovered.is_open());
        assert!(!PermissionStatus::Lost.is_open());
    }

    #[test]
    fn same_decision_twice_is_already_done() {
        let r = record(PermissionStatus::Consumed, Some(PermissionDecision::AllowOnce));
        let o = closed_outcome(&r, PermissionDecision::AllowAlways);
        assert!(!o.applied);
        assert_eq!(o.message, "Already approved at 2026-10-03 10:05:00 UTC.");
        let r = record(PermissionStatus::Denied, Some(PermissionDecision::Reject));
        assert_eq!(
            closed_outcome(&r, PermissionDecision::Reject).message,
            "Already denied at 2026-10-03 10:05:00 UTC."
        );
    }

    #[test]
    fn opposite_decision_after_final_state_is_explained() {
        let r = record(PermissionStatus::Denied, Some(PermissionDecision::Reject));
        let o = closed_outcome(&r, PermissionDecision::AllowOnce);
        assert!(o.message.starts_with("This request was already denied at 2026-10-03 10:05:00 UTC"));
        let mut lost = record(PermissionStatus::Lost, None);
        lost.resolution = Some("session crashed".into());
        let o = closed_outcome(&lost, PermissionDecision::AllowOnce);
        assert_eq!(o.status, Some(PermissionStatus::Lost));
        assert!(o.message.starts_with("Lost: the agent's session ended at 2026-10-03 10:05:00 UTC"));
        assert!(o.message.contains("(session crashed)"));
        assert!(o.message.contains("will ask again"));
        let expired = record(PermissionStatus::Expired, Some(PermissionDecision::Reject));
        assert!(closed_outcome(&expired, PermissionDecision::AllowOnce).message.starts_with("Expired at"));
    }

    #[test]
    fn unknown_id_never_says_not_found() {
        let o = unknown_outcome("perm-1325d8236e24");
        assert!(o.status.is_none());
        assert!(o.message.contains("no longer available"));
        assert!(!o.message.contains("not found"));
    }

    #[test]
    fn record_keeps_request_shape() {
        let r = record(PermissionStatus::Pending, None);
        let v = serde_json::to_value(&r).unwrap();
        for k in ["id", "agentId", "toolName", "capability", "summary", "input", "reason", "ruleKey", "createdAt"] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
        assert_eq!(v["status"], "pending");
        assert_eq!(r.request().id, "perm-1");
    }
}
