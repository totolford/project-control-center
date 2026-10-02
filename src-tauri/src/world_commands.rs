//! AI World commands and the tick runner. One-to-one with `src/lib/api.ts`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use pcc_core::{AgentKind, Error, Event, EventKind, TaskStatus};
use pcc_orchestrator::Orchestrator;
use pcc_store::TaskFilter;
use pcc_world::characters::{self, AgentSeed};
use pcc_world::engine::{self, AgentView};
use pcc_world::model::{Character, Conversation, WorldMode};
use pcc_world::providers::{self, ProviderInfo};
use pcc_world::World;

use crate::state::AppState;

pub type SharedWorld = Arc<Mutex<Option<World>>>;
type CmdResult<T> = Result<T, Error>;

pub const WORLD_CHANNEL: &str = "pcc://world";

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| Error::Process(e.to_string()))
}

async fn project(state: &AppState) -> CmdResult<(Orchestrator, SharedWorld)> {
    let guard = state.project.read().await;
    let p = guard.as_ref().ok_or(Error::NoProject)?;
    Ok((p.orch.clone(), p.world.clone()))
}

/// Real agent states for hybrid characters.
fn agent_views(orch: &Orchestrator) -> Vec<AgentView> {
    let store = &orch.store;
    let agents = store.list_agents().unwrap_or_default();
    let tasks = store.list_tasks(&TaskFilter::default()).unwrap_or_default();
    let recent = chrono_minus_seconds(60);
    let messages = store.list_messages(None, 60).unwrap_or_default();
    agents
        .into_iter()
        .map(|a| {
            let task = a.current_task.as_ref().and_then(|id| tasks.iter().find(|t| &t.id == id)).or_else(|| {
                tasks.iter().rev().find(|t| t.agent.as_deref() == Some(a.id.as_str()) && t.status == TaskStatus::Review)
            });
            let action = a.current_action.clone().unwrap_or_default().to_ascii_lowercase();
            AgentView {
                messaging: messages.iter().any(|m| (m.from == a.id || m.to == a.id) && m.created_at >= recent),
                using_connection: action.starts_with("using ") || action.contains("ssh ") || action.contains("→"),
                using_memory: action.contains("memory"),
                task_status: task.map(|t| t.status.as_str().to_string()),
                task_title: task.map(|t| t.title.clone()),
                status: serde_json::to_value(a.status)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default(),
                current_action: a.current_action,
                model: a.model,
                id: a.id,
                name: a.name,
            }
        })
        .collect()
}

fn chrono_minus_seconds(secs: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::seconds(secs)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorldFrame<'a> {
    tick: u64,
    running: bool,
    characters: &'a [Character],
    events: &'a [pcc_world::model::WorldEvent],
}

/// Advances running worlds and streams frames to the UI; saves periodically.
pub fn spawn_runner(app: AppHandle, orch: Orchestrator, world: SharedWorld) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut since_save = 0u32;
        loop {
            let delay = {
                let mut guard = world.lock().await;
                match guard.as_mut() {
                    Some(w) if w.running => {
                        let views = agent_views(&orch);
                        engine::tick(w, &views);
                        let start = w.events.len().saturating_sub(5);
                        let _ = app.emit(
                            WORLD_CHANNEL,
                            WorldFrame {
                                tick: w.tick,
                                running: true,
                                characters: &w.characters,
                                events: &w.events[start..],
                            },
                        );
                        since_save += 1;
                        if since_save >= 40 && !orch.store.read_only() {
                            since_save = 0;
                            if let Err(e) = pcc_world::save(orch.store.root(), w) {
                                tracing::warn!("cannot save the AI World: {e}");
                            }
                        }
                        Duration::from_secs_f32(1.0 / w.settings.speed.clamp(0.2, 10.0))
                    }
                    _ => Duration::from_millis(500),
                }
            };
            tokio::time::sleep(delay).await;
        }
    })
}

async fn persist(orch: &Orchestrator, w: &World) -> CmdResult<()> {
    if orch.store.read_only() {
        return Err(Error::Denied("compatibility mode: read-only project".into()));
    }
    let root = orch.store.root().to_path_buf();
    let copy = w.clone();
    blocking(move || pcc_world::save(&root, &copy)).await?
}

// ---------------------------------------------------------------- read

#[tauri::command]
pub async fn world_get(state: State<'_, AppState>) -> CmdResult<Option<World>> {
    let (_, world) = project(&state).await?;
    let w = world.lock().await.clone();
    Ok(w)
}

#[tauri::command]
pub async fn world_providers(state: State<'_, AppState>) -> CmdResult<Vec<ProviderInfo>> {
    let (orch, _) = project(&state).await?;
    let root = orch.store.root().to_path_buf();
    blocking(move || providers::list(&root)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldAnalysis {
    pub project_types: Vec<String>,
    pub agents: Vec<AgentSeed>,
    pub providers: Vec<ProviderInfo>,
    pub recommended_provider: String,
    pub reason: String,
    pub existing_world: bool,
}

fn seeds(orch: &Orchestrator) -> Vec<AgentSeed> {
    let tasks = orch.store.list_tasks(&TaskFilter::default()).unwrap_or_default();
    orch.store
        .list_agents()
        .unwrap_or_default()
        .into_iter()
        .filter(|a| a.status != pcc_core::AgentStatus::Retired)
        .map(|a| AgentSeed {
            recent_tasks: tasks
                .iter()
                .rev()
                .filter(|t| t.agent.as_deref() == Some(a.id.as_str()))
                .take(3)
                .map(|t| t.title.clone())
                .collect(),
            is_central: a.kind == AgentKind::Central,
            power: a.permissions.power().map(|p| format!("{p:?}").to_lowercase()),
            skills_enabled: a.profile.skills_enabled,
            connections: a.connections.clone(),
            model: a.model.clone(),
            role: a.role.clone(),
            name: a.name.clone(),
            id: a.id,
        })
        .collect()
}

/// Step 1 of the conversion wizard: stack, agents, providers and a recommendation.
#[tauri::command]
pub async fn world_analyze(state: State<'_, AppState>) -> CmdResult<WorldAnalysis> {
    let (orch, world) = project(&state).await?;
    let root = orch.store.root().to_path_buf();
    let (types, providers) =
        blocking(move || (pcc_connections::environment::detect_project(&root).1, providers::list(&root))).await?;
    let ai_town_ready = providers.iter().any(|p| p.id == "ai_town" && p.ready);
    let node = types.iter().any(|t| t == "node");
    let (recommended, reason) = if ai_town_ready && node {
        ("ai_town", "The project uses Node and AI Town's prerequisites are present; a fork gives a deployable town.")
    } else {
        ("nexus_native", "Runs inside NEXUS with no extra infrastructure and mirrors your real agents. AI Town needs Convex and an Ollama/OpenAI-compatible LLM.")
    };
    let existing_world = world.lock().await.is_some();
    Ok(WorldAnalysis {
        project_types: types,
        agents: seeds(&orch),
        providers,
        recommended_provider: recommended.into(),
        reason: reason.into(),
        existing_world,
    })
}

// ---------------------------------------------------------------- conversion

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldSpec {
    pub name: String,
    pub description: String,
    /// `nexus_native`, `ai_town_compatible`, `ai_town`, `custom`.
    pub provider: String,
    pub mode: WorldMode,
    pub environment: Option<String>,
    pub rules: Vec<String>,
    pub speed: Option<f32>,
    /// Characters prepared by the wizard (from agents, roles, custom or generated).
    pub characters: Vec<Character>,
    /// Folder for the AI Town fork or the custom world (default: `.agent-project/ai-world/ai-town`).
    pub target_dir: Option<String>,
    /// Let Central finish the AI Town setup as a mission (npm install, Convex, LLM, tests).
    pub let_central_finish: bool,
    /// Infrastructure choices recorded for the world (frontend, backend, database, llm...).
    pub infrastructure: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionReport {
    pub world: World,
    pub steps: Vec<String>,
    pub warnings: Vec<String>,
    pub mission_id: Option<String>,
    pub backup: Option<pcc_store::compat::BackupInfo>,
}

/// One-click conversion: snapshot, world, provider setup, optional mission. Never touches project files.
#[tauri::command]
pub async fn world_create(state: State<'_, AppState>, spec: WorldSpec) -> CmdResult<ConversionReport> {
    let (orch, shared) = project(&state).await?;
    if spec.name.trim().is_empty() {
        return Err(Error::invalid("the world needs a name"));
    }
    if spec.characters.is_empty() {
        return Err(Error::invalid("add at least one character"));
    }
    let root = orch.store.root().to_path_buf();
    let mut steps = Vec::new();
    let mut warnings = Vec::new();
    // 1. Snapshot of the project brain (and git, when available).
    let r = root.clone();
    let backup = blocking(move || pcc_store::compat::backup(&r, "before-ai-world")).await??;
    steps.push(format!("Backup of .agent-project: {}", backup.path));
    match orch.lock().await.create_snapshot("before AI World conversion") {
        Ok(s) => steps.push(format!("Git snapshot {}", s.branch)),
        Err(e) => warnings.push(format!("No git snapshot: {e}")),
    }
    // 2. World state.
    let mut w = World::new(&spec.name, &spec.description, &spec.provider, spec.mode);
    w.characters = spec.characters.clone();
    w.settings.rules = spec.rules.clone();
    if let Some(e) = spec.environment.clone().filter(|e| !e.trim().is_empty()) {
        w.settings.environment = e;
    }
    if let Some(s) = spec.speed {
        w.settings.speed = s.clamp(0.2, 10.0);
    }
    w.provider_state = json!({"infrastructure": spec.infrastructure});
    steps.push(format!("World `{}` with {} character(s), mode {:?}", w.name, w.characters.len(), w.mode));
    // 3. Provider.
    let mut mission_id = None;
    match spec.provider.as_str() {
        "nexus_native" => {}
        "ai_town_compatible" => {
            let export = root.join(".agent-project").join("ai-world").join("export");
            std::fs::create_dir_all(&export)?;
            let file = export.join("characters.ts");
            std::fs::write(
                &file,
                format!(
                    "// Generated by NEXUS: paste into AI Town's data/characters.ts\n{}\n",
                    providers::ai_town_descriptions(&w.characters)
                ),
            )?;
            steps.push(format!("AI Town characters exported to {}", file.display()));
        }
        "ai_town" => {
            let dest = spec
                .target_dir
                .clone()
                .filter(|d| !d.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join(".agent-project").join("ai-world").join("ai-town"));
            let chars = w.characters.clone();
            let d2 = dest.clone();
            steps.extend(blocking(move || providers::create_ai_town_fork(&d2, &chars)).await??);
            w.provider_state = json!({"infrastructure": spec.infrastructure, "folder": dest, "setup": "cloned"});
            let r2 = root.clone();
            let missing: Vec<String> = blocking(move || unmet_ai_town(&r2)).await?;
            warnings.extend(missing);
            if spec.let_central_finish {
                let prompt = format!(
                    "Finish the AI Town setup in `{}` (an MIT fork of a16z-infra/ai-town created by NEXUS; its characters were generated from our world).\n\
                     1. Inspect the README and package.json. 2. Run `npm install`. 3. Check Convex (account login `npx convex login`, or self-hosting with Docker) and the LLM (Ollama by default, or an OpenAI-compatible endpoint configured with `npx convex env set`) — ask the user with request_user_action for anything that needs a login or a key. \
                     4. Run the type check / tests that exist. 5. Report exactly what works, what is missing and the command to start it (`npm run dev`). Do not modify files outside that folder.",
                    dest.display()
                );
                let m = orch.lock().await.create_mission(&prompt, Some(format!("Set up AI Town for {}", w.name)))?;
                steps.push(format!("Mission {} created for Central to finish the setup", m.id));
                mission_id = Some(m.id);
            }
        }
        "custom" => {
            let dir = spec
                .target_dir
                .clone()
                .filter(|d| !d.trim().is_empty())
                .ok_or_else(|| Error::invalid("choose the folder of the custom world"))?;
            if !PathBuf::from(&dir).is_dir() {
                return Err(Error::not_found(format!("folder {dir}")));
            }
            w.provider_state = json!({"infrastructure": spec.infrastructure, "folder": dir});
            steps.push(format!("Linked custom world folder {dir}"));
        }
        other => return Err(Error::invalid(format!("unknown provider `{other}`"))),
    }
    persist(&orch, &w).await?;
    *shared.lock().await = Some(w.clone());
    orch.lock().await.emit(Event::new(
        EventKind::ProjectChanged,
        format!("AI World `{}` created ({})", w.name, w.provider),
        json!({"world": w.name}),
    ));
    Ok(ConversionReport { world: w, steps, warnings, mission_id, backup: Some(backup) })
}

/// Replaces the world (edits from the UI: characters, settings, rooms).
#[tauri::command]
pub async fn world_save(state: State<'_, AppState>, world: World) -> CmdResult<World> {
    let (orch, shared) = project(&state).await?;
    persist(&orch, &world).await?;
    *shared.lock().await = Some(world.clone());
    Ok(world)
}

#[tauri::command]
pub async fn world_control(
    state: State<'_, AppState>,
    running: Option<bool>,
    mode: Option<WorldMode>,
    speed: Option<f32>,
) -> CmdResult<World> {
    let (orch, shared) = project(&state).await?;
    let mut guard = shared.lock().await;
    let w = guard.as_mut().ok_or_else(|| Error::not_found("no AI World in this project"))?;
    if let Some(r) = running {
        w.running = r;
    }
    if let Some(m) = mode {
        w.mode = m;
        w.push_event(None, format!("Mode set to {m:?}"));
    }
    if let Some(s) = speed {
        w.settings.speed = s.clamp(0.2, 10.0);
    }
    let copy = w.clone();
    drop(guard);
    persist(&orch, &copy).await?;
    Ok(copy)
}

#[tauri::command]
pub async fn world_delete(state: State<'_, AppState>) -> CmdResult<()> {
    let (orch, shared) = project(&state).await?;
    let file = pcc_world::world_file(orch.store.root());
    if file.is_file() {
        std::fs::remove_file(file)?;
    }
    *shared.lock().await = None;
    Ok(())
}

/// Characters for the wizard from the project's agents (linked for hybrid mode).
#[tauri::command]
pub async fn world_characters_from_agents(state: State<'_, AppState>) -> CmdResult<Vec<Character>> {
    let (orch, _) = project(&state).await?;
    Ok(characters::from_agents(&seeds(&orch)))
}

/// Characters invented by Claude from a description (one real model call).
#[tauri::command]
pub async fn world_generate_characters(
    description: String,
    count: usize,
    model: Option<String>,
) -> CmdResult<Vec<Character>> {
    let claude = pcc_claude::find_claude().ok_or_else(|| Error::Process("Claude Code was not detected".into()))?;
    let model = model.unwrap_or_else(|| "haiku".into());
    blocking(move || characters::generate(&claude, &model, &description, count.clamp(1, 12))).await?
}

/// One simulated conversation between two characters (one real model call).
#[tauri::command]
pub async fn world_converse(state: State<'_, AppState>, a: String, b: String) -> CmdResult<Conversation> {
    let (orch, shared) = project(&state).await?;
    let (ca, cb, room, world_desc, model) = {
        let guard = shared.lock().await;
        let w = guard.as_ref().ok_or_else(|| Error::not_found("no AI World"))?;
        let find = |id: &str| {
            w.characters.iter().find(|c| c.id == id).cloned().ok_or_else(|| Error::not_found(format!("character {id}")))
        };
        let ca = find(&a)?;
        let room = ca.room.clone().and_then(|r| w.room(&r).map(|r| r.name.clone())).unwrap_or_else(|| "street".into());
        (
            ca,
            find(&b)?,
            room,
            format!("{} — {}", w.settings.environment, w.description),
            w.settings.conversation_model.clone(),
        )
    };
    let claude = pcc_claude::find_claude().ok_or_else(|| Error::Process("Claude Code was not detected".into()))?;
    let (c1, c2, r2) = (ca.clone(), cb.clone(), room.clone());
    let lines = blocking(move || characters::converse(&claude, &model, &world_desc, &c1, &c2, &r2)).await??;
    let conv = Conversation {
        id: format!("conv-{}", chrono::Utc::now().timestamp_millis()),
        participants: vec![ca.id.clone(), cb.id.clone()],
        room: Some(room),
        lines,
        origin: "simulated".into(),
        started_at: pcc_core::now(),
    };
    let copy = {
        let mut guard = shared.lock().await;
        let w = guard.as_mut().ok_or_else(|| Error::not_found("no AI World"))?;
        w.conversations.push(conv.clone());
        let excess = w.conversations.len().saturating_sub(100);
        w.conversations.drain(..excess);
        w.push_event(Some(&ca.id), format!("{} talks with {} (simulated)", ca.name, cb.name));
        w.clone()
    };
    persist(&orch, &copy).await?;
    Ok(conv)
}

/// Unmet AI Town prerequisites, as warnings for the conversion report.
fn unmet_ai_town(root: &std::path::Path) -> Vec<String> {
    use providers::AIWorldProvider;
    providers::AiTownFork
        .prerequisites(root)
        .into_iter()
        .filter(|p| !p.met)
        .map(|p| format!("{}: {}", p.name, p.detail))
        .collect()
}
