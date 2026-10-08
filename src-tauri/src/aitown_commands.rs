//! Integrated AI Town: runtime control, the project world, the agent bridge
//! and upstream sync. One-to-one with the `aiTown*` functions of `src/lib/api.ts`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use pcc_core::{AgentAppearance, AgentKind, ConnectionKind, Error, LogKind, MissionStatus, TaskStatus};
use pcc_orchestrator::Orchestrator;
use pcc_store::TaskFilter;
use pcc_world::aitown::bridge::{self, AgentFacts};
use pcc_world::aitown::runtime::{self, AiTownRuntime, RuntimeStatus};
use pcc_world::aitown::upstream::{self, ApplyResult, UpstreamReport};
use pcc_world::aitown::ConvexClient;
use pcc_world::hq::{self, HqStore, RoomIndex, WorldConfig};

use crate::state::AppState;

type CmdResult<T> = Result<T, Error>;

pub const AI_TOWN_CHANNEL: &str = "pcc://ai-town";

pub type SharedRuntime = Arc<Mutex<Option<AiTownRuntime>>>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| Error::Process(e.to_string()))
}

/// The runtime, created on first use (needs the resource directory).
pub(crate) async fn runtime_of(app: &AppHandle, state: &AppState) -> SharedRuntime {
    let shared = state.ai_town.clone();
    let mut guard = shared.lock().await;
    if guard.is_none() {
        let resources = app.path().resource_dir().ok();
        // The app's own data folder, never the install folder that holds the bundled source.
        let runtime_dir = app
            .path()
            .app_local_data_dir()
            .map(|d| d.join("ai-town-runtime"))
            .unwrap_or_else(|_| runtime::default_runtime_dir());
        *guard = Some(AiTownRuntime::new(runtime::locate_source(resources.as_deref()), runtime_dir));
    }
    drop(guard);
    shared
}

/// Runs `f` on the runtime in a blocking thread (npm / convex are slow).
pub(crate) async fn with_runtime<T: Send + 'static>(
    shared: SharedRuntime,
    f: impl FnOnce(&mut AiTownRuntime) -> T + Send + 'static,
) -> CmdResult<T> {
    blocking(move || {
        let mut guard = shared.blocking_lock();
        f(guard.as_mut().expect("runtime initialised"))
    })
    .await
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    stage: &'static str,
    message: String,
}

fn progress(app: &AppHandle, stage: &'static str, message: impl Into<String>) {
    let _ = app.emit(AI_TOWN_CHANNEL, Progress { stage, message: message.into() });
}

#[tauri::command]
pub async fn ai_town_status(app: AppHandle, state: State<'_, AppState>) -> CmdResult<RuntimeStatus> {
    let shared = runtime_of(&app, &state).await;
    with_runtime(shared, |r| r.status()).await
}

/// Installs AI Town's npm dependencies. The UI calls this only after the user
/// confirmed (it downloads packages from npm).
#[tauri::command]
pub async fn ai_town_install(app: AppHandle, state: State<'_, AppState>) -> CmdResult<RuntimeStatus> {
    let shared = runtime_of(&app, &state).await;
    let a = app.clone();
    with_runtime(shared, move |r| {
        r.install(|m| progress(&a, "install", m))?;
        Ok(r.status())
    })
    .await?
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiTownWorld {
    pub url: String,
    pub world_id: String,
    pub engine_id: String,
    /// Path of the embedded frontend, with its parameters.
    pub frontend: String,
}

fn frontend_url(url: &str, world_id: &str, engine_id: &str) -> String {
    let enc = |s: &str| s.replace(':', "%3A").replace('/', "%2F");
    format!("/ai-town/index.html?embed=nexus&convex={}&world={}&engine={}", enc(url), enc(world_id), enc(engine_id))
}

/// Starts the local backend (if needed), ensures the project's world and
/// starts mirroring the project's agents into it.
#[tauri::command]
pub async fn ai_town_start(app: AppHandle, state: State<'_, AppState>) -> CmdResult<AiTownWorld> {
    let orch = state.orch().await?;
    let shared = runtime_of(&app, &state).await;
    progress(&app, "start", "Starting the local AI Town backend (Convex)...");
    let url = with_runtime(shared, |r| r.start()).await??;
    let project = orch.store.info().clone();
    let client = ConvexClient::new(&url);
    let (key, name) = (project.id.clone(), project.name.clone());
    let c = client.clone();
    let world = blocking(move || c.mutation("nexus:ensureWorld", json!({ "projectKey": key, "name": name }))).await??;
    let world_id = world["worldId"].as_str().unwrap_or_default().to_string();
    let engine_id = world["engineId"].as_str().unwrap_or_default().to_string();
    let roots = crate::control_commands::skill_roots(&state).await.ok();
    {
        let guard = state.project.read().await;
        if let Some(p) = guard.as_ref() {
            *p.ai_town_target.lock().await = Some((client.clone(), world_id.clone()));
            let mut bridge = p.ai_town_bridge.lock().await;
            if let Some(old) = bridge.take() {
                old.abort();
            }
            *bridge = Some(spawn_bridge(orch.clone(), client, world_id.clone(), roots));
        }
    }
    progress(&app, "ready", "AI Town is running.");
    Ok(AiTownWorld { frontend: frontend_url(&url, &world_id, &engine_id), url, world_id, engine_id })
}

#[tauri::command]
pub async fn ai_town_stop(app: AppHandle, state: State<'_, AppState>) -> CmdResult<RuntimeStatus> {
    if let Some(p) = state.project.read().await.as_ref() {
        if let Some(b) = p.ai_town_bridge.lock().await.take() {
            b.abort();
        }
    }
    let shared = runtime_of(&app, &state).await;
    with_runtime(shared, |r| {
        r.stop();
        r.status()
    })
    .await
}

/// A line of speech shown above a character: what the user said to an agent
/// in a Talk conversation (`origin: user`).
#[tauri::command]
pub async fn ai_town_say(state: State<'_, AppState>, agent_id: String, text: String) -> CmdResult<()> {
    let target = {
        let guard = state.project.read().await;
        let p = guard.as_ref().ok_or(Error::NoProject)?;
        let t = p.ai_town_target.lock().await.clone();
        t
    };
    let Some((client, world)) = target else { return Ok(()) };
    blocking(move || {
        client.mutation(
            "nexus:say",
            json!({ "worldId": world, "from": agent_id, "text": clip(&text, 200), "origin": "user" }),
        )
    })
    .await??;
    Ok(())
}

#[tauri::command]
pub async fn set_agent_appearance(
    state: State<'_, AppState>,
    agent_id: String,
    appearance: AgentAppearance,
) -> CmdResult<pcc_core::Agent> {
    let orch = state.orch().await?;
    let mut agent = orch.store.get_agent(&agent_id)?.ok_or_else(|| Error::NotFound(format!("agent {agent_id}")))?;
    if let Some(skin) = &appearance.skin {
        if !is_builtin_skin(skin) && !skin.starts_with("nexus-skin:") {
            return Err(Error::Invalid(format!("unknown skin {skin}")));
        }
    }
    if let Some(t) = &appearance.tint {
        if !(t.len() == 7 && t.starts_with('#') && t[1..].chars().all(|c| c.is_ascii_hexdigit())) {
            return Err(Error::Invalid("tint must be #rrggbb".into()));
        }
    }
    agent.profile.appearance = appearance;
    agent.updated_at = pcc_core::now();
    orch.store.upsert_agent(&agent)?;
    Ok(agent)
}

/// AI Town's folk characters and NEXUS's own sprites (ai-town/data/nexusSkins.ts `BUILTIN_SKINS`).
fn is_builtin_skin(skin: &str) -> bool {
    let folk = skin.len() == 2 && skin.starts_with('f') && skin[1..].parse::<u8>().is_ok_and(|n| (1..=8).contains(&n));
    folk || matches!(skin, "nexus-robot" | "nexus-android" | "nexus-wizard" | "nexus-cyberpunk")
}

/// Clones upstream into a temp folder and compares it with the NEXUS copy.
#[tauri::command]
pub async fn ai_town_upstream_check(app: AppHandle, state: State<'_, AppState>) -> CmdResult<UpstreamReport> {
    let shared = runtime_of(&app, &state).await;
    let source =
        with_runtime(shared, |r| r.source.clone()).await?.ok_or_else(|| Error::NotFound("ai-town source".into()))?;
    progress(&app, "upstream", "Fetching a16z-infra/ai-town...");
    blocking(move || {
        let tmp = std::env::temp_dir().join(format!("nexus-ai-town-upstream-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        upstream::fetch_upstream(&tmp)?;
        let report = upstream::analyze(&source, &tmp);
        let _ = std::fs::remove_dir_all(&tmp);
        report
    })
    .await?
}

/// Applies the non-conflicting part of the plan (after a backup).
#[tauri::command]
pub async fn ai_town_upstream_apply(app: AppHandle, state: State<'_, AppState>) -> CmdResult<ApplyResult> {
    let shared = runtime_of(&app, &state).await;
    let source =
        with_runtime(shared, |r| r.source.clone()).await?.ok_or_else(|| Error::NotFound("ai-town source".into()))?;
    blocking(move || {
        let tmp = std::env::temp_dir().join(format!("nexus-ai-town-upstream-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        upstream::fetch_upstream(&tmp)?;
        let result = upstream::apply(&source, &tmp);
        let _ = std::fs::remove_dir_all(&tmp);
        result
    })
    .await?
}

fn clip(text: &str, max: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let mut out: String = line.chars().take(max).collect();
    if line.chars().count() > max {
        out.push('…');
    }
    out
}

// ---------------------------------------------------------------- bridge

/// What the agents' facts need that is slow to compute.
struct Slow {
    at: Option<Instant>,
    skills: Vec<String>,
}

/// NEXUS HQ as the bridge last read it, and the revision AI Town has.
struct Building {
    store: HqStore,
    config: Option<WorldConfig>,
    modified: Option<std::time::SystemTime>,
    sent: Option<u64>,
    /// When the last read / push failed (retried after a pause).
    failed_at: Option<Instant>,
}

impl Building {
    /// Re-reads world.json when it changed on disk (created on first use).
    fn refresh(&mut self, orch: &Orchestrator) {
        let modified = self.store.modified();
        if self.config.is_some() && modified == self.modified {
            return;
        }
        if self.failed_at.is_some_and(|t| t.elapsed() < Duration::from_secs(10)) {
            return;
        }
        let read = orch_world(orch);
        match read {
            Ok(cfg) => {
                self.config = Some(cfg);
                self.modified = self.store.modified();
                self.failed_at = None;
            }
            Err(e) => {
                // Keep the last good building; the world keeps running.
                tracing::warn!("AI World: cannot read world.json: {e}");
                self.failed_at = Some(Instant::now());
            }
        }
    }

    fn rooms(&self) -> RoomIndex {
        match &self.config {
            Some(c) => RoomIndex::new(c),
            None => RoomIndex::new(&WorldConfig::default()),
        }
    }
}

/// The project's building, created from the project's real facts on first use.
fn orch_world(orch: &Orchestrator) -> pcc_core::Result<WorldConfig> {
    let facts = hq::ProjectFacts {
        connections: orch
            .store
            .list_connections()
            .unwrap_or_default()
            .into_iter()
            .map(|c| {
                let kind = serde_json::to_value(c.kind).ok().and_then(|v| v.as_str().map(str::to_string));
                (kind.unwrap_or_default(), c.name)
            })
            .collect(),
    };
    hq::ensure_world(orch.store.root(), &orch.store.settings().ai_world_language, &facts)
}

/// Real agent state → AI Town, once a second.
fn spawn_bridge(
    orch: Orchestrator,
    client: ConvexClient,
    world_id: String,
    roots: Option<pcc_claude::skills::SkillRoots>,
) -> JoinHandle<()> {
    let roots = roots.map(Arc::new);
    tokio::spawn(async move {
        let mut logs = orch.bus.subscribe_logs();
        let mut last_kind: HashMap<String, LogKind> = HashMap::new();
        let mut pending_bubbles: HashMap<String, String> = HashMap::new();
        let mut last_bubble: HashMap<String, Instant> = HashMap::new();
        let mut messages_since = pcc_core::now();
        let mut slow = Slow { at: None, skills: vec![] };
        let mut building = Building {
            store: HqStore::for_project(orch.store.root()),
            config: None,
            modified: None,
            sent: None,
            failed_at: None,
        };
        loop {
            // NEXUS HQ: redraw the map in AI Town when the building changed.
            building.refresh(&orch);
            if let Some(cfg) = building.config.as_ref().filter(|c| building.sent != Some(c.revision)) {
                let layout = hq::payload(cfg);
                let revision = cfg.revision;
                let (c, w) = (client.clone(), world_id.clone());
                let pushed = tokio::task::spawn_blocking(move || {
                    c.mutation("nexus:applyLayout", json!({ "worldId": w, "layout": layout }))
                })
                .await;
                match pushed {
                    Ok(Ok(_)) => building.sent = Some(revision),
                    Ok(Err(e)) => tracing::debug!("AI World layout push failed: {e}"),
                    Err(e) => tracing::debug!("AI World layout push failed: {e}"),
                }
            }
            let rooms = building.rooms();
            // Drain log lines: thinking state and what agents say.
            loop {
                match logs.try_recv() {
                    Ok(l) => {
                        if l.kind == LogKind::AssistantText && !l.text.trim().is_empty() {
                            pending_bubbles.insert(l.agent_id.clone(), clip(&l.text, 160));
                        }
                        if matches!(
                            l.kind,
                            LogKind::AssistantText | LogKind::Thinking | LogKind::ToolUse | LogKind::Result
                        ) {
                            last_kind.insert(l.agent_id.clone(), l.kind);
                        }
                    }
                    Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
            if slow.at.is_none_or(|t| t.elapsed() > Duration::from_secs(60)) {
                if let Some(r) = roots.clone() {
                    slow.skills = tokio::task::spawn_blocking(move || {
                        pcc_claude::skills::list(&r).into_iter().filter(|s| s.enabled).map(|s| s.name).collect()
                    })
                    .await
                    .unwrap_or_default();
                }
                slow.at = Some(Instant::now());
            }
            let facts = collect_facts(&orch, &last_kind, &slow.skills, &rooms);
            let agents: Vec<_> = facts.iter().map(|f| bridge::to_nexus_agent(f, &rooms)).collect();
            let messages: Vec<_> = orch
                .store
                .list_messages(None, 50)
                .unwrap_or_default()
                .into_iter()
                .filter(|m| m.created_at > messages_since)
                .collect();
            if let Some(last) = messages.iter().map(|m| m.created_at.clone()).max() {
                messages_since = last;
            }
            let known: Vec<String> = facts.iter().map(|f| f.id.clone()).collect();
            let mut speech = Vec::new();
            for m in messages {
                let text = clip(&m.body, 160);
                if known.contains(&m.from) && known.contains(&m.to) {
                    speech.push(json!({ "from": m.from, "to": m.to, "text": text, "origin": "real" }));
                    last_bubble.insert(m.from.clone(), Instant::now());
                } else if m.from == "user" && known.contains(&m.to) {
                    speech.push(json!({ "from": m.to, "text": text, "origin": "user" }));
                }
            }
            // Assistant text: at most one bubble per agent every 4 s.
            for (agent, text) in pending_bubbles.clone() {
                if last_bubble.get(&agent).is_none_or(|t| t.elapsed() > Duration::from_secs(4))
                    && known.contains(&agent)
                {
                    speech.push(json!({ "from": agent, "text": text, "origin": "real" }));
                    last_bubble.insert(agent.clone(), Instant::now());
                    pending_bubbles.remove(&agent);
                }
            }
            let (c, w) = (client.clone(), world_id.clone());
            let result = tokio::task::spawn_blocking(move || -> pcc_core::Result<()> {
                c.mutation("nexus:syncAgents", json!({ "worldId": w, "agents": agents }))?;
                for s in speech {
                    let mut args = s;
                    args["worldId"] = json!(w);
                    c.mutation("nexus:say", args)?;
                }
                Ok(())
            })
            .await;
            if let Ok(Err(e)) = result {
                tracing::debug!("AI Town sync failed: {e}");
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
}

pub(crate) fn collect_facts(
    orch: &Orchestrator,
    last_kind: &HashMap<String, LogKind>,
    skills: &[String],
    rooms: &RoomIndex,
) -> Vec<AgentFacts> {
    let store = &orch.store;
    let agents = store.list_agents().unwrap_or_default();
    let tasks = store.list_tasks(&TaskFilter::default()).unwrap_or_default();
    let missions = store.list_missions().unwrap_or_default();
    let connections = store.list_connections().unwrap_or_default();
    let active_mission =
        missions.iter().rev().find(|m| m.mission.status == MissionStatus::Active).map(|m| m.mission.title.clone());
    let mut facts: Vec<AgentFacts> = agents
        .into_iter()
        .map(|a| {
            let task = a.current_task.as_ref().and_then(|id| tasks.iter().find(|t| &t.id == id)).or_else(|| {
                tasks.iter().rev().find(|t| {
                    t.agent.as_deref() == Some(a.id.as_str())
                        && !matches!(t.status, TaskStatus::Pending | TaskStatus::Queued)
                })
            });
            let granted: Vec<_> = connections.iter().filter(|c| a.connections.contains(&c.id)).collect();
            let is_central = a.kind == AgentKind::Central;
            let mission = if is_central {
                active_mission.clone()
            } else {
                task.and_then(|t| t.mission_id.as_ref())
                    .and_then(|id| missions.iter().find(|m| &m.mission.id == id))
                    .map(|m| m.mission.title.clone())
            };
            AgentFacts {
                status: serde_json::to_value(a.status)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default(),
                thinking: last_kind.get(&a.id) == Some(&LogKind::Thinking),
                task_title: task.map(|t| t.title.clone()),
                task_status: task.map(|t| t.status.as_str().to_string()),
                character: a.profile.appearance.skin.clone(),
                tint: a.profile.appearance.tint.clone(),
                badge: a.profile.appearance.badge.clone().filter(|b| !b.trim().is_empty()),
                name: a
                    .profile
                    .appearance
                    .display_name
                    .clone()
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or(a.name.clone()),
                skills: if a.profile.skills_enabled { skills.to_vec() } else { vec![] },
                mcp: granted
                    .iter()
                    .filter(|c| matches!(c.kind, ConnectionKind::Mcp | ConnectionKind::RobloxStudio))
                    .map(|c| c.name.clone())
                    .collect(),
                connections: granted.iter().map(|c| c.name.clone()).collect(),
                is_central,
                mission,
                model: a.model.clone(),
                current_action: a.current_action.clone(),
                role: a.role.clone(),
                rank: pcc_orchestrator::hierarchy::rank_label(a.rank).into(),
                parent_id: a.parent_agent.clone(),
                provider: a.provider.clone(),
                paused: a.paused_at.is_some(),
                parent_room: None,
                id: a.id,
            }
        })
        .collect();
    // Idle specialists gather in their lieutenant's room.
    let lieutenant_rooms: HashMap<String, String> =
        facts.iter().filter(|f| f.rank == "lieutenant").map(|f| (f.id.clone(), bridge::home_room(f, rooms))).collect();
    for f in &mut facts {
        f.parent_room = f.parent_id.as_ref().and_then(|p| lieutenant_rooms.get(p).cloned());
    }
    facts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_url_encodes_parameters() {
        let u = frontend_url("http://127.0.0.1:3210", "mh70", "m974");
        assert_eq!(u, "/ai-town/index.html?embed=nexus&convex=http%3A%2F%2F127.0.0.1%3A3210&world=mh70&engine=m974");
    }

    #[test]
    fn builtin_skins_include_nexus_sprites() {
        assert!(is_builtin_skin("f1") && is_builtin_skin("f8") && is_builtin_skin("nexus-robot"));
        assert!(!is_builtin_skin("f9") && !is_builtin_skin("nexus-dragon") && !is_builtin_skin("f"));
    }

    #[test]
    fn clip_keeps_the_first_line() {
        assert_eq!(clip("\n  Hello there\nmore", 5), "Hello…");
        assert_eq!(clip("Short", 10), "Short");
    }
}
