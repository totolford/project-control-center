//! Multi-agent orchestration for Project Control Center.
//!
//! * `engine`  – sessions, delivery, scheduling, control requests, recovery.
//! * `work`    – agents, tasks, missions, memory operations.
//! * `connections` – project connections and their secrets.
//! * `gitops`  – agent branches, merges, snapshots.
//! * `tools`   – the in-process MCP server agents use to act.
//! * `policy`  – tool-call permission decisions.
//! * `launch`  – Claude Code launch specification per agent.
//! * `prompts` – system prompts and session input formatting.
//! * `dto`     – shapes shared with the UI.

mod connections;
pub mod dto;
pub mod engine;
mod gitops;
pub mod launch;
pub mod policy;
pub mod prompts;
pub mod tools;
mod work;

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{mpsc, Mutex, MutexGuard};

use pcc_core::{EventBus, Result};
use pcc_store::ProjectStore;

pub use engine::Engine;

/// Handle to an open project's engine. Cloning is cheap.
#[derive(Clone)]
pub struct Orchestrator {
    engine: Arc<Mutex<Engine>>,
    pub store: Arc<ProjectStore>,
    pub bus: EventBus,
    pump: Arc<tokio::task::JoinHandle<()>>,
}

impl Orchestrator {
    /// Opens the engine and starts the task that feeds session output into it.
    pub fn open(
        store: ProjectStore,
        bus: EventBus,
        claude: Option<PathBuf>,
        project_types: Vec<String>,
    ) -> Result<Orchestrator> {
        let store = Arc::new(store);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let engine = Arc::new(Mutex::new(Engine::new(store.clone(), bus.clone(), claude, project_types, tx)?));
        let e = engine.clone();
        let pump = tokio::spawn(async move {
            while let Some((tag, out)) = rx.recv().await {
                let mut guard = e.lock().await;
                if let Err(err) = guard.handle_output(tag, out) {
                    tracing::error!("orchestrator error: {err}");
                    guard.emit(pcc_core::Event::new(
                        pcc_core::EventKind::Error,
                        err.to_string(),
                        serde_json::Value::Null,
                    ));
                }
            }
        });
        Ok(Orchestrator { engine, store, bus, pump: Arc::new(pump) })
    }

    pub async fn lock(&self) -> MutexGuard<'_, Engine> {
        self.engine.lock().await
    }

    /// Kills every session and stops processing output.
    pub async fn close(&self) {
        self.engine.lock().await.shutdown();
        self.pump.abort();
    }
}
