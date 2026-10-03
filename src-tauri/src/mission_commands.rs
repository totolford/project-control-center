//! Mission commands of 0.3: the New Mission flow (analysis, creation with the
//! user's skill / MCP / connection selection), the queue, archiving and the
//! activity observed in the logs. One-to-one with the missions section of `src/lib/api.ts`.

use std::time::Duration;

use serde::Deserialize;
use tauri::State;

use pcc_core::{Error, Mission, MissionAnalysis, Priority};
use pcc_orchestrator::dto::MissionSpec;
use pcc_orchestrator::missions::{self, ContextMcp, ContextSkill, MissionActivity};

use crate::control_commands::skill_roots;
use crate::state::AppState;

type CmdResult<T> = Result<T, Error>;

/// Model used for the analysis when the UI does not choose one.
const DEFAULT_ANALYSIS_MODEL: &str = "haiku";

/// What the UI already knows about Claude Code (from its cached environment
/// snapshot); `None` when it was not loaded, the analysis then says "unknown".
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaudeContext {
    pub mcp_servers: Option<Vec<ContextMcp>>,
    pub models: Vec<String>,
}

/// One short Claude Code call (tools, MCP and slash commands disabled) that
/// estimates what the objective needs, given the real project context.
#[tauri::command]
pub async fn analyze_mission(
    state: State<'_, AppState>,
    objective: String,
    model: Option<String>,
    claude: Option<ClaudeContext>,
) -> CmdResult<MissionAnalysis> {
    let exe = pcc_claude::find_claude().ok_or_else(|| Error::Process("Claude Code was not detected".into()))?;
    let mut ctx = state.orch().await?.lock().await.analysis_base()?;
    let roots = skill_roots(&state).await?;
    let installed = tokio::task::spawn_blocking(move || pcc_claude::skills::list(&roots))
        .await
        .map_err(|e| Error::Process(e.to_string()))?;
    ctx.skills = installed
        .into_iter()
        .map(|k| {
            let plugin =
                k.source.as_deref().filter(|s| *s != "synced" && k.scope == pcc_claude::skills::SkillScope::Plugin);
            ContextSkill {
                name: missions::skill_invocation_name(&k.name, plugin),
                description: k.description,
                enabled: k.enabled,
            }
        })
        .collect();
    let claude = claude.unwrap_or_default();
    ctx.mcp_known = claude.mcp_servers.is_some();
    ctx.mcp_servers = claude.mcp_servers.unwrap_or_default();
    ctx.models = claude.models;
    let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).unwrap_or(DEFAULT_ANALYSIS_MODEL.into());
    let ask_model = model.clone();
    missions::analyze_with(&objective, &ctx, &model, |prompt| async move {
        missions::ask_claude(&exe, &ask_model, prompt, Duration::from_secs(120)).await
    })
    .await
}

/// Creates a mission from the New Mission flow: sent to Central now, or
/// queued while another mission runs (unless `spec.startNow`).
#[tauri::command]
pub async fn create_mission_with(state: State<'_, AppState>, spec: MissionSpec) -> CmdResult<Mission> {
    state.orch().await?.lock().await.create_mission_from(spec)
}

/// Hands a queued mission to Central even if another one runs.
#[tauri::command]
pub async fn start_mission(state: State<'_, AppState>, id: String) -> CmdResult<Mission> {
    state.orch().await?.lock().await.start_mission(&id)
}

#[tauri::command]
pub async fn set_mission_priority(state: State<'_, AppState>, id: String, priority: Priority) -> CmdResult<Mission> {
    state.orch().await?.lock().await.set_mission_priority(&id, priority)
}

/// Hides a finished mission from the main lists (`archived = false` restores it).
#[tauri::command]
pub async fn archive_mission(state: State<'_, AppState>, id: String, archived: bool) -> CmdResult<Mission> {
    state.orch().await?.lock().await.archive_mission(&id, archived)
}

/// Skills and MCP servers the mission's agents really invoked (from their logs).
#[tauri::command]
pub async fn mission_activity(state: State<'_, AppState>, id: String) -> CmdResult<MissionActivity> {
    let orch = state.orch().await?;
    let store = orch.store.clone();
    tokio::task::spawn_blocking(move || {
        let m = store.get_mission(&id)?.ok_or_else(|| Error::not_found(format!("mission {id}")))?;
        missions::mission_activity(&store, &m)
    })
    .await
    .map_err(|e| Error::Process(e.to_string()))?
}
