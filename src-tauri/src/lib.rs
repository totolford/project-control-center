//! Project Control Center desktop application.

mod commands;
mod state;

use tauri::{Manager, RunEvent};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use state::AppState;

fn init_logging(log_dir: &std::path::Path) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    std::fs::create_dir_all(log_dir).ok()?;
    let file = tracing_appender::rolling::daily(log_dir, "app.log");
    let (writer, guard) = tracing_appender::non_blocking(file);
    let filter = EnvFilter::try_from_env("PCC_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(writer).with_ansi(false))
        .with(fmt::layer().with_writer(std::io::stderr))
        .try_init()
        .ok()?;
    Some(guard)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let log_dir = app.path().app_log_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            if let Some(guard) = init_logging(&log_dir) {
                // Flushes the file logger when the app exits.
                app.manage(guard);
            }
            tracing::info!("Project Control Center {} starting", app.package_info().version);
            app.manage(AppState::new(data_dir, log_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::detect_claude,
            commands::recent_projects,
            commands::forget_recent,
            commands::inspect_folder,
            commands::create_project,
            commands::open_project,
            commands::close_project,
            commands::project_snapshot,
            commands::project_environment,
            commands::save_settings,
            commands::recover_sessions,
            commands::discard_recovery,
            commands::create_mission,
            commands::cancel_mission,
            commands::create_agent,
            commands::update_agent,
            commands::start_agent,
            commands::stop_agent,
            commands::restart_agent,
            commands::interrupt_agent,
            commands::retire_agent,
            commands::stop_all_agents,
            commands::send_user_message,
            commands::agent_logs,
            commands::agent_sessions,
            commands::permission_rules,
            commands::remove_permission_rule,
            commands::create_task,
            commands::update_task,
            commands::retry_task,
            commands::list_messages,
            commands::list_events,
            commands::resolve_permission,
            commands::memory_files,
            commands::save_memory,
            commands::consolidate_memory,
            commands::add_connection,
            commands::update_connection,
            commands::delete_connection,
            commands::check_connection,
            commands::connection_secret_keys,
            commands::roblox_detect,
            commands::known_mcp_servers,
            commands::git_overview,
            commands::git_init,
            commands::merge_agent_branch,
            commands::commit_agent_work,
            commands::create_snapshot,
            commands::restore_snapshot,
            commands::github_status,
            commands::github_overview,
            commands::create_pull_request,
            commands::open_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Project Control Center");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Stop every agent session and mark them for recovery on next start.
            let state = handle.state::<AppState>();
            tauri::async_runtime::block_on(state.close_project());
            tracing::info!("Project Control Center exited");
        }
    });
}
