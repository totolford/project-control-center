//! Project Control Center desktop application.

mod aitown_commands;
mod commands;
mod control_commands;
mod market_commands;
mod mission_commands;
mod ops_commands;
mod state;
mod world_commands;

use tauri::{Manager, RunEvent};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use state::AppState;

/// Display name. Provisional branding: also change `productName` in tauri.conf.json and `src/lib/brand.ts`.
pub const APP_NAME: &str = "NEXUS";

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
            tracing::info!("{} {} starting", APP_NAME, app.package_info().version);
            let state = AppState::new(data_dir, log_dir);
            AppState::apply_app_settings(&state.load_app_settings());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            market_commands::market_index,
            market_commands::market_refresh,
            market_commands::market_search_github,
            market_commands::market_details,
            market_commands::market_install,
            market_commands::market_uninstall,
            market_commands::market_update,
            market_commands::market_set_enabled,
            market_commands::market_plugin_options,
            market_commands::market_settings,
            market_commands::market_save_settings,
            market_commands::market_recommend,
            market_commands::market_status,
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
            commands::load_workspace,
            commands::save_workspace,
            commands::list_agent_providers,
            commands::open_path,
            commands::reveal_path,
            control_commands::app_settings,
            control_commands::save_app_settings,
            control_commands::claude_environment,
            control_commands::claude_command_tree,
            control_commands::run_claude_cli,
            control_commands::claude_mcp_add,
            control_commands::claude_mcp_remove,
            control_commands::claude_mcp_set_enabled,
            control_commands::test_mcp_config,
            control_commands::probe_connection,
            control_commands::import_claude_mcp,
            control_commands::reconnect_mcp,
            control_commands::reload_plugins,
            control_commands::claude_plugin_set_enabled,
            control_commands::list_skills,
            control_commands::skill_create,
            control_commands::skill_preview,
            control_commands::skill_read_file,
            control_commands::skill_diff,
            control_commands::skill_save,
            control_commands::skill_set_enabled,
            control_commands::skill_duplicate,
            control_commands::skill_delete,
            control_commands::skill_export,
            control_commands::skill_test,
            control_commands::set_agent_model,
            control_commands::apply_power,
            control_commands::emergency_stop,
            control_commands::release_emergency,
            control_commands::revoke_all_permissions,
            control_commands::list_decisions,
            control_commands::start_improvement_cycle,
            control_commands::system_report,
            control_commands::project_insights,
            control_commands::pty_spawn,
            control_commands::pty_write,
            control_commands::pty_resize,
            control_commands::pty_kill,
            control_commands::pty_close,
            control_commands::pty_list,
            control_commands::pty_scrollback,
            ops_commands::compatibility_report,
            ops_commands::project_backups,
            ops_commands::rollback_project,
            ops_commands::backup_project,
            ops_commands::interpret_command,
            ops_commands::apply_command,
            ops_commands::list_commands,
            ops_commands::provide_secret,
            ops_commands::complete_user_request,
            ops_commands::dismiss_user_request,
            ops_commands::ssh_key_setup,
            ops_commands::github_login,
            ops_commands::github_account,
            ops_commands::github_repositories,
            ops_commands::github_repository,
            ops_commands::github_clone,
            ops_commands::github_create_issue,
            ops_commands::github_run_workflow,
            ops_commands::master_status,
            aitown_commands::ai_town_status,
            aitown_commands::ai_town_install,
            aitown_commands::ai_town_start,
            aitown_commands::ai_town_stop,
            aitown_commands::ai_town_say,
            aitown_commands::ai_town_upstream_check,
            aitown_commands::ai_town_upstream_apply,
            aitown_commands::set_agent_appearance,
            world_commands::world_get,
            world_commands::world_providers,
            world_commands::world_analyze,
            world_commands::world_create,
            world_commands::world_save,
            world_commands::world_control,
            world_commands::world_delete,
            world_commands::world_characters_from_agents,
            world_commands::world_generate_characters,
            world_commands::world_converse,
            mission_commands::analyze_mission,
            mission_commands::create_mission_with,
            mission_commands::start_mission,
            mission_commands::set_mission_priority,
            mission_commands::archive_mission,
            mission_commands::mission_activity,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Stop every agent session and mark them for recovery on next start.
            let state = handle.state::<AppState>();
            state.pty.kill_all();
            tauri::async_runtime::block_on(state.close_project());
            tracing::info!("{APP_NAME} exited");
        }
    });
}
