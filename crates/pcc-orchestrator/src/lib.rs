//! Multi-agent orchestration for Project Control Center.
//!
//! * `engine`  – sessions, delivery, scheduling, control requests, recovery.
//! * `work`    – agents, tasks, missions, memory operations.
//! * `missions` – mission queue, archive, brief for Central, analysis, observed activity.
//! * `connections` – project connections and their secrets.
//! * `admin`   – agent-driven connections, approvals, user requests, command journal.
//! * `autonomy` – decision journal, power, UNLOCKED, emergency stop, improvement loop.
//! * `gitops`  – agent branches, merges, snapshots.
//! * `hierarchy` – agent pyramid: delegation, routing, promotion, dormancy.
//! * `tools`   – the in-process MCP server agents use to act.
//! * `permission_manager` – persistent permission requests and their lifecycle.
//! * `journal` – journal entries about the Control Center itself.
//! * `policy`  – tool-call permission decisions.
//! * `launch`  – Claude Code launch specification per agent.
//! * `prompts` – system prompts and session input formatting.
//! * `providers` – agent runtimes (Claude Code adapter, detected others).
//! * `dto`     – shapes shared with the UI.
//! * `recovery` – process registry, mission checkpoints, interrupted missions, crash reports.
//! * `watchdog` – periodic health checks, soft recovery, automatic restarts, MCP supervision.
//! * `central` – RESUME pre-classifier, Central autonomy level, mission supervisor, MCP tool failure recovery.
//! * `resume` – the resume service: verified recovery report, sessions brought back, Central briefed.
//! * `usage`   – AI usage records of agent sessions and one-shot calls.

mod admin;
mod autonomy;
pub mod central;
mod connections;
pub mod dto;
pub mod engine;
mod env_tools;
mod gitops;
pub mod hierarchy;
mod idempotency;
mod journal;
pub mod launch;
pub mod missions;
pub mod permission_manager;
pub mod policy;
pub mod prompts;
pub mod providers;
pub mod recovery;
pub mod resume;
pub mod tools;
pub mod usage;
pub mod watchdog;
mod work;
pub mod world_tools;

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
    watchdog: Arc<tokio::task::JoinHandle<()>>,
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
        usage::install_sink(&store);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut core = Engine::new(store.clone(), bus.clone(), claude, project_types, tx)?;
        // Settings → Missions → Recovery → auto-resume: interrupted missions continue now.
        core.auto_resume_on_open();
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
                if let Err(err) = guard.expire_permissions() {
                    tracing::error!("permission expiry failed: {err}");
                }
                if let Err(err) = guard.hierarchy_tick() {
                    tracing::warn!("idle sessions not put to sleep: {err}");
                }
                if let Err(err) = guard.tick() {
                    guard.emit(pcc_core::Event::new(
                        pcc_core::EventKind::Error,
                        format!("Improvement cycle skipped: {err}"),
                        serde_json::Value::Null,
                    ));
                }
            }
        });
        // Watchdog: health checks, automatic recovery, periodic checkpoints.
        let e = engine.clone();
        let watchdog = tokio::spawn(async move {
            let mut interval = tokio::time::interval(crate::watchdog::TICK);
            interval.tick().await;
            let mut scanned = false;
            loop {
                interval.tick().await;
                if !scanned {
                    // Processes left by a previous run (slow: off the engine lock).
                    scanned = true;
                    let input = e.lock().await.orphan_scan_input();
                    if let Some(input) = input {
                        let found =
                            tokio::task::spawn_blocking(move || crate::recovery::scan_orphans(&input, true)).await;
                        if let Ok(found) = found {
                            e.lock().await.set_orphans(found);
                        }
                    }
                }
                let mut guard = e.lock().await;
                if let Err(err) = guard.watchdog_tick(std::time::Instant::now()) {
                    tracing::warn!("watchdog pass failed: {err}");
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
            watchdog: Arc::new(watchdog),
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
        self.watchdog.abort();
    }
}
