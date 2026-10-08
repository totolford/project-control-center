//! Platform: the OS NEXUS runs on (Windows or Ubuntu), its shells and
//! terminals, and the Platform Capability Matrix shown in the Environment
//! view. Everything is read from the machine (`pcc_platform`).

use std::path::PathBuf;

use pcc_core::Error;
use pcc_platform::capabilities::{Live, LiveState, Matrix};
use pcc_platform::PlatformInfo;
use tauri::State;

use crate::state::AppState;

type CmdResult<T> = Result<T, Error>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| Error::Process(e.to_string()))
}

/// OS, distribution, shells, terminals, credential store and service manager.
#[tauri::command]
pub async fn platform_info() -> CmdResult<PlatformInfo> {
    blocking(pcc_platform::info).await
}

/// The capability matrix with the live status of each row on this machine.
#[tauri::command]
pub async fn platform_capabilities() -> CmdResult<Matrix> {
    blocking(|| {
        let mut m = pcc_platform::capabilities::matrix();
        // Better checks than a PATH lookup for these two rows.
        m.set_live(
            "credentials",
            match pcc_connections::secrets::store_status() {
                Ok(name) => Live::new(LiveState::Available, format!("{name} answers")),
                Err(why) => Live::new(LiveState::Missing, why),
            },
        );
        m.set_live(
            "claude",
            match pcc_claude::find_claude() {
                Some(p) => Live::new(LiveState::Available, p.display().to_string()),
                None => Live::new(LiveState::Missing, "Claude Code not found"),
            },
        );
        m
    })
    .await
}

/// Opens the system terminal emulator (Windows Terminal, GNOME Terminal…) in
/// the project folder, or the home folder when no project is open. The
/// window belongs to the user and is not tied to NEXUS.
#[tauri::command]
pub async fn open_system_terminal(state: State<'_, AppState>) -> CmdResult<String> {
    let cwd: PathBuf = match state.orch().await {
        Ok(o) => o.store.root().to_path_buf(),
        Err(_) => pcc_platform::paths::home_dir(),
    };
    blocking(move || pcc_platform::shells::open_terminal(&cwd)).await?.map_err(Error::Process)
}
