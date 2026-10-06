//! Permission requests and the event journal. One-to-one with `src/lib/api.ts`.

use pcc_claude::cli_help::CliRun;
use tauri::State;

use pcc_core::{Error, Event, PermissionDecision, PermissionOutcome, PermissionRecord, PermissionStatusReport};
use pcc_store::JournalFilter;

use crate::state::AppState;

type CmdResult<T> = Result<T, Error>;

/// Idempotent: a repeated or late decision returns an explanation, not an error.
#[tauri::command]
pub async fn resolve_permission(
    state: State<'_, AppState>,
    id: String,
    decision: PermissionDecision,
) -> CmdResult<PermissionOutcome> {
    state.orch().await?.lock().await.resolve_permission(&id, decision)
}

#[tauri::command]
pub async fn permission_status(state: State<'_, AppState>, id: String) -> CmdResult<PermissionStatusReport> {
    state.orch().await?.lock().await.permission_status(&id)
}

#[tauri::command]
pub async fn permission_history(
    state: State<'_, AppState>,
    agent_id: Option<String>,
    limit: u32,
) -> CmdResult<Vec<PermissionRecord>> {
    state.orch().await?.lock().await.permission_history(agent_id.as_deref(), limit)
}

#[tauri::command]
pub async fn rerequest_permission(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    state.orch().await?.lock().await.rerequest_permission(&id)
}

#[tauri::command]
pub async fn journal(state: State<'_, AppState>, filter: JournalFilter) -> CmdResult<Vec<Event>> {
    state.orch().await?.store.journal(&filter)
}

// ---------------------------------------------------------------- idempotence helpers

/// A repeated `claude mcp add` / `remove` whose target state already holds
/// (the CLI fails with "already exists" / "not found") is reported as a
/// success with `note`. Returns the run and whether it was such a repeat.
pub(crate) fn settle_repeat(mut run: CliRun, already: &[&str], note: &str) -> (CliRun, bool) {
    if run.exit_code == Some(0) {
        return (run, false);
    }
    let text = format!("{}\n{}", run.stdout, run.stderr).to_lowercase();
    if !already.iter().any(|p| text.contains(p)) {
        return (run, false);
    }
    run.exit_code = Some(0);
    run.stdout = format!("{note}\n{}", run.stdout.trim()).trim().to_string();
    (run, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(code: i32, stderr: &str) -> CliRun {
        CliRun { args: vec![], exit_code: Some(code), stdout: String::new(), stderr: stderr.into(), duration_ms: 1 }
    }

    #[test]
    fn repeated_mcp_add_is_success_other_failures_are_kept() {
        let (r, repeat) =
            settle_repeat(run(1, "MCP server pi already exists in local config"), &["already exists"], "Already added");
        assert!(repeat);
        assert_eq!(r.exit_code, Some(0));
        assert!(r.stdout.starts_with("Already added"));
        let (r, repeat) = settle_repeat(run(1, "Invalid JSON"), &["already exists"], "Already added");
        assert!(!repeat);
        assert_eq!(r.exit_code, Some(1));
        let (_, repeat) = settle_repeat(run(0, ""), &["already exists"], "x");
        assert!(!repeat);
    }
}
