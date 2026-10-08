//! Project compatibility, command interpreter, command journal, user
//! requests, SSH key setup, GitHub account and MASTER CONTROL status.
//! One-to-one with `src/lib/api.ts`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use pcc_connections::github;
use pcc_core::interpreter::Interpretation;
use pcc_core::{Access, AgentKind, CommandRecord, ConnectionKind, Error, PermissionSet};
use pcc_orchestrator::dto::ConnectionInput;
use pcc_pty::{PtyEvent, PtyInfo, PtySpec};
use pcc_store::compat::{self, BackupInfo, CompatibilityReport};

use crate::control_commands::PTY_CHANNEL;
use crate::state::AppState;

type CmdResult<T> = Result<T, Error>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| Error::Process(e.to_string()))
}

async fn root(state: &AppState) -> CmdResult<PathBuf> {
    Ok(state.orch().await?.store.root().to_path_buf())
}

// ---------------------------------------------------------------- compatibility

#[tauri::command]
pub async fn compatibility_report(path: String) -> CmdResult<CompatibilityReport> {
    blocking(move || compat::analyze(Path::new(&path))).await?
}

#[tauri::command]
pub async fn project_backups(path: String) -> CmdResult<Vec<BackupInfo>> {
    blocking(move || compat::list_backups(Path::new(&path))).await
}

/// Restores a backup of `.agent-project`. The project is closed first and must be reopened.
#[tauri::command]
pub async fn rollback_project(state: State<'_, AppState>, path: String, backup_id: String) -> CmdResult<BackupInfo> {
    state.close_project().await;
    blocking(move || compat::rollback(Path::new(&path), &backup_id)).await?
}

/// Backs up the project brain on demand.
#[tauri::command]
pub async fn backup_project(state: State<'_, AppState>, label: String) -> CmdResult<BackupInfo> {
    let r = root(&state).await?;
    let label: String = label.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
    blocking(move || compat::backup(&r, if label.is_empty() { "manual" } else { &label })).await?
}

// ---------------------------------------------------------------- interpreter & journal

#[tauri::command]
pub async fn interpret_command(state: State<'_, AppState>, line: String) -> CmdResult<Interpretation> {
    state.orch().await?.lock().await.interpret(&line)
}

/// Turns an interpreted `claude mcp add` / `ssh` line into a connection (reused when equivalent).
#[tauri::command]
pub async fn apply_command(state: State<'_, AppState>, line: String) -> CmdResult<Value> {
    let applied = state.orch().await?.lock().await.apply_command(&line)?;
    Ok(serde_json::to_value(applied)?)
}

#[tauri::command]
pub async fn list_commands(
    state: State<'_, AppState>,
    agent_id: Option<String>,
    before: Option<i64>,
    limit: u32,
) -> CmdResult<Vec<CommandRecord>> {
    state.orch().await?.store.list_commands(agent_id.as_deref(), before, limit)
}

// ---------------------------------------------------------------- user requests

#[tauri::command]
pub async fn provide_secret(state: State<'_, AppState>, id: String, value: String) -> CmdResult<()> {
    state.orch().await?.lock().await.provide_secret(&id, &value)
}

#[tauri::command]
pub async fn complete_user_request(state: State<'_, AppState>, id: String, note: Option<String>) -> CmdResult<()> {
    let note = note.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "The user completed the requested step.".into());
    state.orch().await?.lock().await.finish_user_request(&id, &note)
}

#[tauri::command]
pub async fn dismiss_user_request(state: State<'_, AppState>, id: String, reason: Option<String>) -> CmdResult<()> {
    let note = format!("The user declined the request{}.", reason.map(|r| format!(": {r}")).unwrap_or_default());
    state.orch().await?.lock().await.finish_user_request(&id, &note)
}

/// Runs `command` in a visible terminal that stays open afterwards:
/// PowerShell on Windows, the user's shell on Linux (`command` must be
/// written for that shell).
fn spawn_terminal(app: &AppHandle, state: &AppState, title: &str, cwd: &Path, command: &str) -> CmdResult<PtyInfo> {
    let (program, args) = pcc_platform::shells::run_and_stay(command)
        .ok_or_else(|| Error::Process("no shell found to open a terminal".into()))?;
    let app2 = app.clone();
    let info = state.pty.spawn(
        PtySpec {
            title: title.into(),
            program,
            args,
            cwd: cwd.to_string_lossy().into_owned(),
            env: vec![],
            cols: 120,
            rows: 32,
        },
        move |e: PtyEvent| {
            let _ = app2.emit(PTY_CHANNEL, e);
        },
    )?;
    Ok(info)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeySetup {
    pub key_path: String,
    pub created_key: bool,
    pub terminal: PtyInfo,
}

/// Creates (or reuses) a dedicated key for an SSH connection, switches the
/// connection to key auth and opens a terminal that installs the public key on
/// the host: the user types the remote password there, once.
#[tauri::command]
pub async fn ssh_key_setup(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
) -> CmdResult<SshKeySetup> {
    let orch = state.orch().await?;
    let c = orch
        .store
        .get_connection(&connection_id)?
        .ok_or_else(|| Error::not_found(format!("connection {connection_id}")))?;
    if !matches!(c.kind, ConnectionKind::Ssh | ConnectionKind::Sftp) {
        return Err(Error::invalid("only SSH/SFTP connections use keys"));
    }
    let g = |k: &str| c.config.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let (host, user) = (g("host"), g("user"));
    let port = c.config.get("port").and_then(Value::as_u64).unwrap_or(22);
    let home = pcc_platform::paths::home_dir();
    let ssh_dir = pcc_platform::paths::ssh_dir();
    std::fs::create_dir_all(&ssh_dir)?;
    let key = ssh_dir.join(format!("nexus_{}", c.id.replace('-', "_")));
    let created_key = !key.is_file();
    if created_key {
        let k = key.clone();
        let comment = format!("nexus-{}", c.id);
        let out = blocking(move || {
            pcc_claude::process::std_command("ssh-keygen")
                .args(["-t", "ed25519", "-N", "", "-C", &comment, "-f", &k.to_string_lossy()])
                .output()
        })
        .await?
        .map_err(|e| Error::Process(format!("ssh-keygen: {e}")))?;
        if !out.status.success() {
            return Err(Error::Process(format!("ssh-keygen failed: {}", String::from_utf8_lossy(&out.stderr).trim())));
        }
    }
    let mut config = c.config.clone();
    config["keyPath"] = json!(key.to_string_lossy());
    config["auth"] = json!("key");
    orch.lock().await.update_connection(
        &c.id,
        ConnectionInput { name: c.name.clone(), kind: c.kind, config, secrets: None, enabled: None },
    )?;
    let pubkey = key.with_extension("pub");
    let command = ssh_key_install_command(&user, &host, port, &pubkey.to_string_lossy(), cfg!(windows));
    let terminal = spawn_terminal(&app, &state, &format!("SSH key setup · {}", c.name), &home, &command)?;
    Ok(SshKeySetup { key_path: key.to_string_lossy().into_owned(), created_key, terminal })
}

/// The terminal line that appends a public key to the host's
/// `authorized_keys` (PowerShell on Windows, POSIX shell elsewhere).
fn ssh_key_install_command(user: &str, host: &str, port: u64, pubkey: &str, powershell: bool) -> String {
    let remote = "\"mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo NEXUS-KEY-INSTALLED\"";
    let ssh = format!("ssh -p {port} -o StrictHostKeyChecking=accept-new {user}@{host} {remote}");
    let note = format!("Installing the NEXUS key on {user}@{host}. Type the remote password when asked.");
    if powershell {
        format!("Write-Host '{note}'; Get-Content '{}' | {ssh}", pubkey.replace('\'', "''"))
    } else {
        format!("echo '{note}'; cat {} | {ssh}", pcc_platform::install::sh_quote(pubkey))
    }
}

/// Opens the official GitHub CLI sign-in (browser device flow) in a terminal.
#[tauri::command]
pub async fn github_login(app: AppHandle, state: State<'_, AppState>) -> CmdResult<PtyInfo> {
    let home = pcc_platform::paths::home_dir();
    spawn_terminal(
        &app,
        &state,
        "GitHub sign-in",
        &home,
        "gh auth login --hostname github.com --git-protocol https --web",
    )
}

// ---------------------------------------------------------------- GitHub

fn gh_dir() -> PathBuf {
    std::env::temp_dir()
}

#[tauri::command]
pub async fn github_account() -> CmdResult<github::GithubAccount> {
    blocking(|| github::account(&gh_dir())).await?
}

#[tauri::command]
pub async fn github_repositories(owner: Option<String>, query: Option<String>) -> CmdResult<Vec<Value>> {
    blocking(move || github::repositories(&gh_dir(), owner.as_deref(), query.as_deref(), 200)).await?
}

#[tauri::command]
pub async fn github_repository(repo: String) -> CmdResult<github::RepositoryDetail> {
    blocking(move || github::repository_detail(&gh_dir(), &repo)).await?
}

#[tauri::command]
pub async fn github_clone(repo: String, parent: String) -> CmdResult<String> {
    let dest = blocking(move || github::clone_repository(&repo, Path::new(&parent))).await??;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn github_create_issue(repo: String, title: String, body: String) -> CmdResult<String> {
    if title.trim().is_empty() {
        return Err(Error::invalid("an issue needs a title"));
    }
    blocking(move || github::create_issue(&gh_dir(), &repo, title.trim(), &body)).await?
}

#[tauri::command]
pub async fn github_run_workflow(repo: String, workflow: String, git_ref: String) -> CmdResult<String> {
    blocking(move || github::run_workflow(&gh_dir(), &repo, &workflow, &git_ref)).await?
}

// ---------------------------------------------------------------- MASTER CONTROL

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterDomain {
    pub key: String,
    pub label: String,
    /// Opened by the user in MASTER CONTROL.
    pub enabled: bool,
    /// Really usable on this machine/project right now.
    pub available: bool,
    /// 0..1: share of the domain's capabilities Central effectively has.
    pub level: f32,
    pub detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterStatus {
    pub active: bool,
    pub domains: Vec<MasterDomain>,
    pub central_permissions: PermissionSet,
}

/// What MASTER CONTROL really gives Central: per domain, the user's choice,
/// the availability on this machine and the effective permission level.
#[tauri::command]
pub async fn master_status(state: State<'_, AppState>) -> CmdResult<MasterStatus> {
    let orch = state.orch().await?;
    let settings = orch.store.settings();
    let central = orch
        .store
        .list_agents()?
        .into_iter()
        .find(|a| a.kind == AgentKind::Central)
        .ok_or_else(|| Error::not_found("Central agent"))?;
    let perms = pcc_orchestrator::policy::effective_permissions(&central, &settings.autonomy, &settings.master_control);
    let connections = orch.store.list_connections()?;
    let count = |kinds: &[ConnectionKind]| connections.iter().filter(|c| c.enabled && kinds.contains(&c.kind)).count();
    let level = |caps: &[pcc_core::Capability]| {
        caps.iter()
            .map(|c| match perms.get(*c) {
                Access::Allow => 1.0,
                Access::Ask => 0.5,
                Access::Deny => 0.0,
            })
            .sum::<f32>()
            / caps.len() as f32
    };
    let claude = pcc_claude::detect().await;
    let r = orch.store.root().to_path_buf();
    let gh = blocking(move || github::status(&r, None)).await?;
    let m = &settings.master_control;
    use pcc_core::Capability::*;
    let skills = central.profile.skills_enabled && m.skills;
    let domains = vec![
        MasterDomain {
            key: "claude".into(),
            label: "Claude".into(),
            enabled: true,
            available: claude.installed && claude.logged_in != Some(false),
            level: if claude.installed { 1.0 } else { 0.0 },
            detail: claude.version.map(|v| format!("Claude Code {v}")).unwrap_or_else(|| "not detected".into()),
        },
        MasterDomain {
            key: "pc".into(),
            label: "PC".into(),
            enabled: m.pc,
            available: true,
            level: level(&[FsRead, FsWrite, FsExecute, Network, GitRead, GitWrite]),
            detail: "files, terminal, processes, git, network".into(),
        },
        MasterDomain {
            key: "github".into(),
            label: "GitHub".into(),
            enabled: m.github,
            available: gh.authenticated,
            level: level(&[GithubRead, GithubWrite, GithubAdmin]),
            detail: gh
                .account
                .map(|a| format!("signed in as {a}"))
                .unwrap_or_else(|| gh.detail.unwrap_or_else(|| "not signed in".into())),
        },
        MasterDomain {
            key: "mcp".into(),
            label: "MCP".into(),
            enabled: m.mcp,
            available: count(&[ConnectionKind::Mcp, ConnectionKind::RobloxStudio]) > 0,
            level: level(&[Mcp]),
            detail: format!("{} MCP connection(s)", count(&[ConnectionKind::Mcp, ConnectionKind::RobloxStudio])),
        },
        MasterDomain {
            key: "ssh".into(),
            label: "SSH".into(),
            enabled: m.ssh,
            available: count(&[ConnectionKind::Ssh, ConnectionKind::Sftp]) > 0,
            level: level(&[SshRead, SshExecute]),
            detail: format!("{} SSH/SFTP connection(s)", count(&[ConnectionKind::Ssh, ConnectionKind::Sftp])),
        },
        MasterDomain {
            key: "skills".into(),
            label: "Skills".into(),
            enabled: m.skills,
            available: true,
            level: if skills { 1.0 } else { 0.0 },
            detail: if skills { "enabled for Central".into() } else { "disabled for Central".into() },
        },
    ];
    Ok(MasterStatus { active: m.active, domains, central_permissions: perms })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_key_install_line_matches_the_shell() {
        let ps = ssh_key_install_command("pi", "srv", 22, r"C:\Users\o'neil\.ssh\nexus_x.pub", true);
        assert!(ps.starts_with("Write-Host 'Installing the NEXUS key on pi@srv."));
        assert!(ps.contains(r"Get-Content 'C:\Users\o''neil\.ssh\nexus_x.pub' | ssh -p 22"));
        let sh = ssh_key_install_command("pi", "srv", 2222, "/home/ada/.ssh/nexus x.pub", false);
        assert!(sh.starts_with("echo 'Installing the NEXUS key on pi@srv."));
        assert!(
            sh.contains("cat '/home/ada/.ssh/nexus x.pub' | ssh -p 2222 -o StrictHostKeyChecking=accept-new pi@srv")
        );
        assert!(sh.ends_with("echo NEXUS-KEY-INSTALLED\""));
    }
}
