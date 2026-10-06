//! Agent pyramid commands: promotion, dormancy, delegation decisions.

use tauri::State;

use pcc_core::{Agent, Error};
use pcc_orchestrator::hierarchy::DelegationRecord;

use crate::state::AppState;

type CmdResult<T> = Result<T, Error>;

#[tauri::command]
pub async fn promote_agent(state: State<'_, AppState>, id: String) -> CmdResult<Agent> {
    state.orch().await?.lock().await.promote_agent(&id)
}

#[tauri::command]
pub async fn demote_agent(state: State<'_, AppState>, id: String) -> CmdResult<Agent> {
    state.orch().await?.lock().await.demote_agent(&id)
}

#[tauri::command]
pub async fn pause_agent(state: State<'_, AppState>, id: String) -> CmdResult<Agent> {
    state.orch().await?.lock().await.pause_agent(&id)
}

#[tauri::command]
pub async fn resume_agent(state: State<'_, AppState>, id: String) -> CmdResult<Agent> {
    state.orch().await?.lock().await.resume_agent(&id)
}

/// Puts an idle agent to sleep now. False when it is not idle.
#[tauri::command]
pub async fn sleep_agent(state: State<'_, AppState>, id: String) -> CmdResult<bool> {
    state.orch().await?.lock().await.sleep_agent(&id)
}

#[tauri::command]
pub async fn delegation_decisions(
    state: State<'_, AppState>,
    agent_id: Option<String>,
    limit: u32,
) -> CmdResult<Vec<DelegationRecord>> {
    state.orch().await?.lock().await.delegation_decisions(agent_id.as_deref(), limit)
}
