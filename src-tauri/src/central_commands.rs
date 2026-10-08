//! Central as an execution agent: autonomy level, missions waiting for the
//! user, the resume service (verified report, resume now) and the AI Runtime
//! capability test of the local model Central may run on. One-to-one with the
//! central section of `src/lib/api.ts`.

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use pcc_ai::capability::{self, CapabilityReport, CapabilityResult};
use pcc_core::{EngineProvider, Error, Event, EventKind, PowerLevel, Severity, CENTRAL_ID};
use pcc_orchestrator::central::{self, AutoResumeNotice, MissionBlock};
use pcc_orchestrator::resume::ResumeReport;

use crate::state::AppState;

type CmdResult<T> = Result<T, Error>;

/// Progress of a capability test (`{ model, result }`, one per finished test).
pub const CAPABILITY_CHANNEL: &str = "pcc://ai-capability";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CentralState {
    /// `LOW`, `NORMAL`, `HIGH`, `MAXIMUM` or `CUSTOM` (Central's power preset).
    pub autonomy: &'static str,
    pub autonomy_level: Option<PowerLevel>,
    /// Supervisor reminders allowed on an unchanged mission state.
    pub nudge_limit: u8,
    /// Missions Central declared blocked on the user.
    pub blocks: Vec<MissionBlock>,
    pub auto_resume: Option<AutoResumeNotice>,
    /// The mission "reprends" would continue.
    pub resume_candidate: Option<String>,
    /// Central's engine (`claude`, `local`, `hybrid`).
    pub engine: EngineProvider,
    /// Last capability test of the configured local model, if any.
    pub local_capability: Option<CapabilityReport>,
}

#[tauri::command]
pub async fn central_state(state: State<'_, AppState>) -> CmdResult<CentralState> {
    let orch = state.orch().await?;
    let ai = orch.store.settings().ai;
    let level = orch.store.get_agent(CENTRAL_ID)?.and_then(|a| central::autonomy_level(&a));
    let e = orch.lock().await;
    Ok(CentralState {
        autonomy: central::autonomy_label(level),
        autonomy_level: level,
        nudge_limit: central::nudge_limit(level),
        blocks: e.mission_blocks(),
        auto_resume: e.auto_resume_notice(),
        resume_candidate: e.resume_candidate()?,
        engine: ai.central,
        local_capability: ai.local.model.as_deref().and_then(|m| capability::latest(&ai.local.runtime, m)),
    })
}

/// Verified state of a mission (read-only): the report Central would get.
#[tauri::command]
pub async fn central_resume_report(state: State<'_, AppState>, mission_id: Option<String>) -> CmdResult<ResumeReport> {
    let orch = state.orch().await?;
    let e = orch.lock().await;
    let id = match mission_id {
        Some(id) => id,
        None => e.resume_candidate()?.ok_or_else(|| Error::invalid("no running or interrupted mission"))?,
    };
    e.resume_report(&id, "user")
}

/// Resume now: sessions brought back, Central briefed with the verified report.
#[tauri::command]
pub async fn central_resume(state: State<'_, AppState>, mission_id: Option<String>) -> CmdResult<ResumeReport> {
    let orch = state.orch().await?;
    let mut e = orch.lock().await;
    let id = match mission_id {
        Some(id) => id,
        None => e.resume_candidate()?.ok_or_else(|| Error::invalid("no running or interrupted mission"))?,
    };
    Ok(e.resume_mission_flow(&id, "user", None)?.0)
}

#[tauri::command]
pub async fn central_dismiss_auto_resume(state: State<'_, AppState>) -> CmdResult<()> {
    state.orch().await?.lock().await.dismiss_auto_resume();
    Ok(())
}

// ---------------------------------------------------------------- capability test

/// Stored capability reports (latest per runtime + model).
#[tauri::command]
pub async fn ai_capability_reports() -> CmdResult<Vec<CapabilityReport>> {
    Ok(capability::load_all())
}

/// Runs the six capability tests for real against the configured runtime
/// (installed models only: nothing is downloaded) and stores the result.
#[tauri::command]
pub async fn ai_capability_test(
    app: AppHandle,
    state: State<'_, AppState>,
    model: String,
) -> CmdResult<CapabilityReport> {
    let settings = crate::ai_commands::current(&state).await;
    let runtime = settings.local.runtime.clone();
    let installed = {
        let s = settings.clone();
        tokio::task::spawn_blocking(move || pcc_ai::provider_for(&s).list_models())
            .await
            .map_err(|e| Error::Process(e.to_string()))??
    };
    let norm = |s: &str| s.strip_suffix(":latest").unwrap_or(s).to_string();
    if !installed.iter().any(|m| m.name == model || norm(&m.name) == norm(&model)) {
        return Err(Error::invalid(format!(
            "{model} is not installed in {}: the capability test only runs on installed models",
            pcc_ai::runtime_name(&runtime)
        )));
    }
    let tx = app.clone();
    let m = model.clone();
    let report = tokio::task::spawn_blocking(move || {
        let p = pcc_ai::provider_for(&settings);
        let mut on = |r: &CapabilityResult| {
            let _ = tx.emit(CAPABILITY_CHANNEL, json!({"model": m, "result": r}));
        };
        capability::run(p.as_ref(), &runtime, &m, &mut on)
    })
    .await
    .map_err(|e| Error::Process(e.to_string()))?;
    capability::save(&report)?;
    let severity = match report.central_mode {
        capability::CentralMode::Full => Severity::Info,
        _ => Severity::Warning,
    };
    crate::ai_commands::emit(
        &app,
        Event::new(EventKind::RuntimeChanged, report.summary.clone(), json!({"report": report}))
            .named("ai.capabilityTest")
            .with_source("runtime")
            .with_severity(severity),
    )
    .await;
    Ok(report)
}
