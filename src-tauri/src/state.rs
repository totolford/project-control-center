//! Application state: at most one open project at a time.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

use pcc_core::{Error, Result};
use pcc_orchestrator::Orchestrator;

pub const EVENT_CHANNEL: &str = "pcc://event";
pub const LOG_CHANNEL: &str = "pcc://log";

pub struct OpenProject {
    pub orch: Orchestrator,
    forwarders: Vec<JoinHandle<()>>,
}

impl OpenProject {
    /// Relays engine events and log lines to the webview.
    pub fn new(app: &AppHandle, orch: Orchestrator) -> Self {
        let mut events = orch.bus.subscribe();
        let a = app.clone();
        let ev = tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(e) => {
                        let _ = a.emit(EVENT_CHANNEL, e);
                    }
                    // The UI resynchronises with a snapshot; nothing to do here.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("event relay lagged by {n}")
                    }
                    Err(_) => break,
                }
            }
        });
        let mut logs = orch.bus.subscribe_logs();
        let a = app.clone();
        let lg = tokio::spawn(async move {
            loop {
                match logs.recv().await {
                    Ok(l) => {
                        let _ = a.emit(LOG_CHANNEL, l);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("log relay lagged by {n}")
                    }
                    Err(_) => break,
                }
            }
        });
        OpenProject { orch, forwarders: vec![ev, lg] }
    }

    pub async fn close(self) {
        self.orch.close().await;
        for f in self.forwarders {
            f.abort();
        }
    }
}

pub struct AppState {
    pub project: RwLock<Option<OpenProject>>,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
}

impl AppState {
    pub fn new(data_dir: PathBuf, log_dir: PathBuf) -> Self {
        AppState { project: RwLock::new(None), data_dir, log_dir }
    }

    pub fn recent_file(&self) -> PathBuf {
        self.data_dir.join("recent-projects.json")
    }

    pub async fn orch(&self) -> Result<Orchestrator> {
        self.project.read().await.as_ref().map(|p| p.orch.clone()).ok_or(Error::NoProject)
    }

    pub async fn close_project(&self) {
        if let Some(p) = self.project.write().await.take() {
            p.close().await;
        }
    }
}
