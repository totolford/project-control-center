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
    /// Raw Terminal sessions (application-wide, survive project switches).
    pub pty: pcc_pty::PtyManager,
    /// Unredacted MCP configs from the last Claude Code inspection; the UI only
    /// receives redacted copies (secrets stay in the backend).
    pub claude_mcp_configs: std::sync::Mutex<Vec<serde_json::Value>>,
}

/// Application-level settings (not tied to a project).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// Explicit Claude Code executable; auto-detected when empty.
    pub claude_path: Option<String>,
}

impl AppState {
    pub fn new(data_dir: PathBuf, log_dir: PathBuf) -> Self {
        AppState {
            project: RwLock::new(None),
            data_dir,
            log_dir,
            pty: pcc_pty::PtyManager::new(),
            claude_mcp_configs: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub fn app_settings_file(&self) -> PathBuf {
        self.data_dir.join("app-settings.json")
    }

    pub fn load_app_settings(&self) -> AppSettings {
        std::fs::read_to_string(self.app_settings_file())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Applies the Claude Code path override for this process (read by detection).
    pub fn apply_app_settings(s: &AppSettings) {
        match s.claude_path.as_deref().filter(|p| !p.trim().is_empty()) {
            Some(p) => std::env::set_var("PCC_CLAUDE_PATH", p),
            None => std::env::remove_var("PCC_CLAUDE_PATH"),
        }
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
