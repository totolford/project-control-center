//! Recovery building blocks shared by the orchestrator and the application.
//!
//! * `registry`   – processes NEXUS depends on, persisted (`processes.json`).
//! * `watchdog`   – health diagnosis and restart budget (pure decisions).
//! * `checkpoint` – mission files and checkpoints in `.agent-project/missions`.
//! * `orphans`    – processes left by a previous run.
//! * `reports`    – crash reports and the clean-exit marker.
//! * `sys`        – read-only OS process inspection.
//!
//! Application-wide processes (AI Town, local AI runtimes, terminals) register
//! in [`app`]; each open project has its own registry in its engine.
//!
//! ```ignore
//! use pcc_recovery::{app, ProcessKind, Registration};
//! app().register("localai:ollama", Registration::new(ProcessKind::LocalAi, "Ollama").pid(Some(pid)));
//! app().heartbeat("localai:ollama", "health check", Some("GET /api/tags 200"));
//! app().ended("localai:ollama", false, Some(0), None);
//! ```

pub mod checkpoint;
pub mod orphans;
pub mod registry;
pub mod reports;
pub mod sys;
pub mod watchdog;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub use checkpoint::{Checkpoint, CheckpointSummary, FileState, LastAction, MissionFiles, MissionRecord};
pub use orphans::Orphan;
pub use registry::{ProcessKind, ProcessRecord, ProcessRegistry, ProcessState, Registration, RestartRecord};
pub use reports::{CrashReport, PreviousRun, ReportStore, Severity};
pub use watchdog::{diagnose, Diagnosis, RestartDecision, RestartPolicy, SessionObservation, Verdict, WatchAction};

/// Folder of runtime files inside `.agent-project` (git-ignored).
pub const RUNTIME_DIR: &str = "runtime";

static APP: OnceLock<ProcessRegistry> = OnceLock::new();
static APP_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Registry of application-wide processes. In memory until [`init_app`] gives
/// it a folder; registering before that is fine.
pub fn app() -> &'static ProcessRegistry {
    APP.get_or_init(ProcessRegistry::in_memory)
}

/// Persists the application registry in `<data_dir>/runtime` and returns the
/// snapshot the previous run left there.
pub fn init_app(data_dir: &Path) -> Option<registry::RegistrySnapshot> {
    let dir = runtime_dir(data_dir);
    let file = dir.join("processes.json");
    let previous = ProcessRegistry::load_previous(&file);
    let _ = APP_DIR.set(dir);
    app().set_path(file);
    previous
}

/// `<data_dir>/runtime` once [`init_app`] ran.
pub fn app_runtime_dir() -> Option<&'static Path> {
    APP_DIR.get().map(PathBuf::as_path)
}

/// Creates `dir/runtime` with a `.gitignore` that keeps it out of commits.
pub fn runtime_dir(dir: &Path) -> PathBuf {
    let rt = dir.join(RUNTIME_DIR);
    if !rt.join(".gitignore").is_file() {
        let _ = std::fs::create_dir_all(&rt);
        let _ = std::fs::write(rt.join(".gitignore"), "# NEXUS runtime state (processes, crash reports).\n*\n");
    }
    rt
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp{}~", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_dir_is_git_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let rt = runtime_dir(tmp.path());
        assert!(std::fs::read_to_string(rt.join(".gitignore")).unwrap().contains('*'));
    }
}
