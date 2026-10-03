//! Multi-agent orchestration for Project Control Center.
//!
//! * `engine`  – sessions, delivery, scheduling, control requests, recovery.
//! * `work`    – agents, tasks, missions, memory operations.
//! * `missions` – mission queue, archive, brief for Central, analysis, observed activity.
//! * `connections` – project connections and their secrets.
//! * `admin`   – agent-driven connections, approvals, user requests, command journal.
//! * `autonomy` – decision journal, power, UNLOCKED, emergency stop, improvement loop.
//! * `gitops`  – agent branches, merges, snapshots.
//! * `tools`   – the in-process MCP server agents use to act.
//! * `policy`  – tool-call permission decisions.
//! * `launch`  – Claude Code launch specification per agent.
//! * `prompts` – system prompts and session input formatting.
//! * `providers` – agent runtimes (Claude Code adapter, detected others).
//! * `dto`     – shapes shared with the UI.

mod admin;
mod autonomy;
mod connections;
pub mod dto;
pub mod engine;
mod env_tools;
mod gitops;
pub mod launch;
pub mod missions;
pub mod policy;
pub mod prompts;
pub mod providers;
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
    ticker: Arc<tokio::task::JoinHandle<()>>,
    jobs: Arc<tokio::task::JoinHandle<()>>,
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
        let mut core = Engine::new(store.clone(), bus.clone(), claude, project_types, tx)?;
        let mut jobs = core.take_jobs().expect("fresh engine");
        let engine = Arc::new(Mutex::new(core));
        // Jobs from background work (deferred tool answers, probes) run under the engine lock.
        let e = engine.clone();
        let job_runner = tokio::spawn(async move {
            while let Some(job) = jobs.recv().await {
                let mut guard = e.lock().await;
                if let Err(err) = job(&mut guard) {
                    tracing::error!("background job failed: {err}");
                }
            }
        });
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
        // Minute tick: continuous-improvement scheduling.
        let e = engine.clone();
        let ticker = tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            interval.tick().await;
            loop {
                interval.tick().await;
                let mut guard = e.lock().await;
                if let Err(err) = guard.tick() {
                    guard.emit(pcc_core::Event::new(
                        pcc_core::EventKind::Error,
                        format!("Improvement cycle skipped: {err}"),
                        serde_json::Value::Null,
                    ));
                }
            }
        });
        Ok(Orchestrator {
            engine,
            store,
            bus,
            pump: Arc::new(pump),
            ticker: Arc::new(ticker),
            jobs: Arc::new(job_runner),
        })
    }

    pub async fn lock(&self) -> MutexGuard<'_, Engine> {
        self.engine.lock().await
    }

    /// Kills every session and stops processing output.
    pub async fn close(&self) {
        self.engine.lock().await.shutdown();
        self.pump.abort();
        self.ticker.abort();
        self.jobs.abort();
    }
}
