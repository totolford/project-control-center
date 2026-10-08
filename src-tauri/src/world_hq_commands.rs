//! NEXUS HQ (the AI World building): what the AI World page shows and the
//! changes the user makes there. One-to-one with the `aiWorldHq*` functions
//! of `src/lib/api.ts`. Changes go through the engine (snapshot, validation,
//! rollback, journal) exactly like Central's `manage_ai_world`.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use pcc_core::Error;
use pcc_world::aitown::bridge;
use pcc_world::hq::{
    self, store::SnapshotInfo, validate::Issue, HqStore, LayoutPayload, RoomIndex, WorldConfig, WorldOp,
};

use crate::state::AppState;

type CmdResult<T> = Result<T, Error>;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Occupant {
    pub agent_id: String,
    pub room_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HqView {
    pub config: WorldConfig,
    /// Rooms with their doors and materials, as AI Town draws them.
    pub layout: LayoutPayload,
    pub issues: Vec<Issue>,
    /// Domains detected in the project and the rooms they call for.
    pub suggestions: Value,
    pub snapshots: Vec<SnapshotInfo>,
    /// The room each agent is in now (same resolution as the world).
    pub occupancy: Vec<Occupant>,
}

async fn view(state: &AppState) -> CmdResult<HqView> {
    let orch = state.orch().await?;
    let (config, issues, suggestions) = {
        let e = orch.lock().await;
        let config = e.ai_world()?;
        (config.clone(), hq::validate::validate(&config), e.ai_world_suggestions()?)
    };
    let rooms = RoomIndex::new(&config);
    let facts = crate::aitown_commands::collect_facts(&orch, &HashMap::new(), &[], &rooms);
    let occupancy = occupancy(&facts, &rooms);
    let snapshots = HqStore::for_project(orch.store.root()).snapshots();
    Ok(HqView { layout: hq::payload(&config), config, issues, suggestions, snapshots, occupancy })
}

fn occupancy(facts: &[pcc_world::aitown::AgentFacts], rooms: &RoomIndex) -> Vec<Occupant> {
    facts.iter().map(|f| Occupant { agent_id: f.id.clone(), room_id: bridge::room_for(f, rooms) }).collect()
}

#[tauri::command]
pub async fn ai_world_hq(state: State<'_, AppState>) -> CmdResult<HqView> {
    view(&state).await
}

/// A change made on the AI World page (no approval: the user is the one asking).
#[tauri::command]
pub async fn ai_world_hq_apply(state: State<'_, AppState>, op: WorldOp) -> CmdResult<HqView> {
    let orch = state.orch().await?;
    orch.lock().await.apply_world_op("user", &op)?;
    view(&state).await
}

#[tauri::command]
pub async fn ai_world_hq_restore(state: State<'_, AppState>, snapshot: String) -> CmdResult<HqView> {
    let orch = state.orch().await?;
    orch.lock().await.restore_world_snapshot(&snapshot)?;
    view(&state).await
}

/// The world view repaired or hid a character (journal warning).
#[tauri::command]
pub async fn ai_world_hq_warning(
    state: State<'_, AppState>,
    code: String,
    agent_id: String,
    detail: String,
    repair: String,
) -> CmdResult<()> {
    let orch = state.orch().await?;
    let clip = |s: &str, n: usize| s.chars().take(n).collect::<String>();
    orch.lock().await.record_world_warning(&code, &agent_id, &clip(&detail, 300), &clip(&repair, 200));
    Ok(())
}

/// The world view crashed: its context is saved as a crash report (Diagnostics).
#[tauri::command]
pub async fn ai_world_hq_crash(state: State<'_, AppState>, context: Value) -> CmdResult<Option<String>> {
    let orch = state.orch().await?;
    let id = orch.lock().await.report_world_crash(&context);
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcc_world::aitown::AgentFacts;

    #[test]
    fn occupancy_uses_the_world_resolution() {
        let mut c = WorldConfig::default();
        for k in ["central_hq", "coding_office", "server_room"] {
            c.rooms.push(pcc_world::hq::Room::of_kind(k, "en"));
        }
        let rooms = RoomIndex::new(&c);
        let facts = vec![
            AgentFacts { id: "central".into(), is_central: true, status: "working".into(), ..Default::default() },
            AgentFacts {
                id: "w1".into(),
                status: "working".into(),
                current_action: Some("Bash: ssh pi@192.0.2.10 uptime".into()),
                ..Default::default()
            },
        ];
        assert_eq!(
            occupancy(&facts, &rooms),
            vec![
                Occupant { agent_id: "central".into(), room_id: "central_hq".into() },
                Occupant { agent_id: "w1".into(), room_id: "server_room".into() },
            ]
        );
    }
}
