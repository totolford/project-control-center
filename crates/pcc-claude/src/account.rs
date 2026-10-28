//! Claude Code accounts. Each account is its own config folder (`CLAUDE_CONFIG_DIR`): login,
//! settings and transcripts never mix. The selected account applies to every Claude Code process
//! started afterwards; running sessions keep the one they were started with.
//!
//! A session started on one account can continue on another: before `--resume`, the newest copy of
//! its transcript is copied into the active account (never moved, the original stays untouched).

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

pub const CONFIG_DIR_VAR: &str = "CLAUDE_CONFIG_DIR";

pub struct Account {
    pub id: &'static str,
    pub label: &'static str,
    /// Folder under the user's home.
    pub folder: &'static str,
}

pub const ACCOUNTS: &[Account] = &[
    Account { id: "10j", label: "Claude 10J", folder: ".claude-10j" },
    Account { id: "pro", label: "Claude Pro", folder: ".claude-pro" },
];

pub fn account(id: &str) -> Option<&'static Account> {
    ACCOUNTS.iter().find(|a| a.id == id)
}

pub fn config_dir(home: &Path, a: &Account) -> PathBuf {
    home.join(a.folder)
}

static INHERITED: OnceLock<Option<OsString>> = OnceLock::new();

/// `CLAUDE_CONFIG_DIR` as NEXUS was started with it (captured before the first change).
fn inherited() -> Option<&'static OsString> {
    INHERITED.get_or_init(|| std::env::var_os(CONFIG_DIR_VAR)).as_ref()
}

/// Selects the account of the Claude Code processes started from now on. `None` (or an unknown id)
/// restores the folder NEXUS was started with.
pub fn apply(id: Option<&str>) {
    let inherited = inherited();
    match id.and_then(account) {
        Some(a) => std::env::set_var(CONFIG_DIR_VAR, config_dir(&pcc_platform::paths::home_dir(), a)),
        None => match inherited {
            Some(v) => std::env::set_var(CONFIG_DIR_VAR, v),
            None => std::env::remove_var(CONFIG_DIR_VAR),
        },
    }
}

/// Config folder new sessions use: `CLAUDE_CONFIG_DIR`, else `~/.claude`.
pub fn active_dir() -> PathBuf {
    match std::env::var_os(CONFIG_DIR_VAR).filter(|v| !v.is_empty()) {
        Some(v) => PathBuf::from(v),
        None => pcc_platform::paths::home_dir().join(".claude"),
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let s = p.to_string_lossy().replace('\\', "/");
        let s = s.trim_end_matches('/').to_string();
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    norm(a) == norm(b)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountOption {
    pub id: String,
    pub label: String,
    pub config_dir: String,
    /// The folder exists (created by Claude Code at the first login).
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    /// Account matching the active folder, `None` for another folder.
    pub active_id: Option<String>,
    pub active_dir: String,
    /// Folder used when no account is selected (the one NEXUS was started with).
    pub startup_dir: String,
    pub accounts: Vec<AccountOption>,
}

pub fn status() -> AccountStatus {
    let home = pcc_platform::paths::home_dir();
    let active = active_dir();
    let accounts: Vec<AccountOption> = ACCOUNTS
        .iter()
        .map(|a| {
            let dir = config_dir(&home, a);
            AccountOption {
                id: a.id.into(),
                label: a.label.into(),
                exists: dir.is_dir(),
                config_dir: dir.to_string_lossy().into_owned(),
            }
        })
        .collect();
    let active_id = accounts.iter().find(|a| same_dir(Path::new(&a.config_dir), &active)).map(|a| a.id.clone());
    let startup = inherited().map(PathBuf::from).unwrap_or_else(|| home.join(".claude"));
    AccountStatus {
        active_id,
        active_dir: active.to_string_lossy().into_owned(),
        startup_dir: startup.to_string_lossy().into_owned(),
        accounts,
    }
}

/// Every config folder a session may live in: active first, then the accounts, the startup one and
/// `~/.claude`.
fn candidate_dirs() -> Vec<PathBuf> {
    let home = pcc_platform::paths::home_dir();
    let mut dirs = vec![active_dir()];
    dirs.extend(ACCOUNTS.iter().map(|a| config_dir(&home, a)));
    dirs.extend(inherited().map(PathBuf::from));
    dirs.push(home.join(".claude"));
    let mut out: Vec<PathBuf> = Vec::new();
    for d in dirs {
        if !out.iter().any(|o| same_dir(o, &d)) {
            out.push(d);
        }
    }
    out
}

/// `(project subfolder, transcript)` of `session_id` in `config`, if any.
fn find_transcript(config: &Path, session_id: &str) -> Option<(OsString, PathBuf)> {
    let file = format!("{session_id}.jsonl");
    fs::read_dir(config.join("projects")).ok()?.flatten().find_map(|e| {
        let p = e.path().join(&file);
        p.is_file().then(|| (e.file_name(), p))
    })
}

fn modified(p: &Path) -> Option<std::time::SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// Copies the files of `from` missing in `to` (sub-agent transcripts, tool results).
fn copy_missing(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)?.flatten() {
        let target = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_missing(&e.path(), &target)?;
        } else if !target.exists() {
            fs::copy(e.path(), &target)?;
        }
    }
    Ok(())
}

/// Makes `session_id` resumable in the active account: when its newest transcript is in another
/// account, copies it into the active one (same project subfolder). Returns the copied transcript.
/// The other accounts are only read.
pub fn prepare_resume(session_id: &str) -> std::io::Result<Option<PathBuf>> {
    prepare_resume_in(&candidate_dirs(), session_id)
}

fn prepare_resume_in(dirs: &[PathBuf], session_id: &str) -> std::io::Result<Option<PathBuf>> {
    if session_id.is_empty() || session_id.contains(['/', '\\', '.']) {
        return Ok(None);
    }
    let Some(active) = dirs.first() else { return Ok(None) };
    let found: Vec<(usize, OsString, PathBuf)> = dirs
        .iter()
        .enumerate()
        .filter_map(|(i, d)| find_transcript(d, session_id).map(|(sub, p)| (i, sub, p)))
        .collect();
    // The newest copy holds the whole conversation (transcripts are append-only).
    let Some((i, sub, source)) = found.iter().max_by_key(|(i, _, p)| (modified(p), std::cmp::Reverse(*i))) else {
        return Ok(None);
    };
    if *i == 0 {
        return Ok(None);
    }
    let local = found.iter().find(|(j, _, _)| *j == 0).map(|(_, _, p)| p.clone());
    let target = local.unwrap_or_else(|| active.join("projects").join(sub).join(source.file_name().unwrap()));
    // Never shrink a transcript of the active account.
    let len = |p: &Path| fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    if target.exists() && len(&target) > len(source) {
        return Ok(None);
    }
    fs::create_dir_all(target.parent().unwrap())?;
    fs::copy(source, &target)?;
    let sidecar = source.with_extension("");
    if sidecar.is_dir() {
        copy_missing(&sidecar, &target.with_extension(""))?;
    }
    tracing::info!("session {session_id} continued in {}: copied from {}", active.display(), source.display());
    Ok(Some(target))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, s: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, s).unwrap();
    }

    #[test]
    fn copies_the_session_into_the_active_account_without_touching_the_other() {
        let tmp = tempfile::tempdir().unwrap();
        let (pro, tenj) = (tmp.path().join(".claude-pro"), tmp.path().join(".claude-10j"));
        let src = tenj.join("projects/C--proj/abc.jsonl");
        write(&src, "{\"a\":1}\n");
        write(&tenj.join("projects/C--proj/abc/subagents/x.jsonl"), "x");

        let copied = prepare_resume_in(&[pro.clone(), tenj.clone()], "abc").unwrap().unwrap();
        assert_eq!(copied, pro.join("projects/C--proj/abc.jsonl"));
        assert_eq!(fs::read_to_string(&copied).unwrap(), "{\"a\":1}\n");
        assert!(pro.join("projects/C--proj/abc/subagents/x.jsonl").is_file());
        assert_eq!(fs::read_to_string(&src).unwrap(), "{\"a\":1}\n");
        // Already up to date in the active account: nothing to do.
        assert_eq!(prepare_resume_in(&[pro, tenj], "abc").unwrap(), None);
    }

    #[test]
    fn newer_conversation_replaces_the_stale_copy_but_never_a_longer_one() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        write(&a.join("projects/p/s1.jsonl"), "1\n");
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(&b.join("projects/p/s1.jsonl"), "1\n2\n");
        prepare_resume_in(&[a.clone(), b.clone()], "s1").unwrap();
        assert_eq!(fs::read_to_string(a.join("projects/p/s1.jsonl")).unwrap(), "1\n2\n");

        write(&b.join("projects/p/s2.jsonl"), "1\n");
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(&a.join("projects/p/s2.jsonl"), "1\n2\n");
        assert_eq!(prepare_resume_in(&[a.clone(), b], "s2").unwrap(), None);
        assert_eq!(fs::read_to_string(a.join("projects/p/s2.jsonl")).unwrap(), "1\n2\n");
    }

    #[test]
    fn ignores_unknown_and_unsafe_ids() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(prepare_resume_in(&[tmp.path().to_path_buf()], "nope").unwrap(), None);
        assert_eq!(prepare_resume_in(&[tmp.path().to_path_buf()], "../x").unwrap(), None);
    }
}
