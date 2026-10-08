//! Locates the Claude Code CLI and reads its authentication status.
//!
//! The application never handles Claude credentials: it relies on the user's
//! existing Claude Code login (`claude auth login`), which the CLI reads itself.

use std::path::{Path, PathBuf};
use std::time::Duration;

use pcc_core::ClaudeInfo;
use serde_json::Value;

use crate::process::command;

/// Returns the path of the Claude Code executable, if installed.
///
/// Order: `PCC_CLAUDE_PATH`, `claude.exe` on PATH, native installer location,
/// npm global package.
pub fn find_claude() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("PCC_CLAUDE_PATH") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join(exe);
            if cand.is_file() {
                return Some(cand);
            }
            // npm shim directory: resolve the real binary next to it.
            if cfg!(windows) && dir.join("claude.cmd").is_file() {
                if let Some(p) = npm_binary(&dir) {
                    return Some(p);
                }
            }
        }
    }
    // A desktop launcher does not read ~/.bashrc: look where the installers put it.
    let home = pcc_platform::platform().home_dir();
    if let Some(h) = &home {
        for rel in [".local/bin", ".claude/local", ".claude/bin", ".npm-global/bin"] {
            let cand = h.join(rel).join(exe);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    if cfg!(windows) {
        if let Some(p) = pcc_platform::paths::config_dir().and_then(|appdata| npm_binary(&appdata.join("npm"))) {
            return Some(p);
        }
    }
    None
}

fn npm_binary(npm_dir: &Path) -> Option<PathBuf> {
    let base = npm_dir.join("node_modules").join("@anthropic-ai").join("claude-code");
    ["bin/claude.exe", "bin/claude"].iter().map(|r| base.join(r)).find(|p| p.is_file())
}

/// Full detection: executable, version, login state.
pub async fn detect() -> ClaudeInfo {
    let Some(path) = find_claude() else {
        return ClaudeInfo {
            installed: false,
            error: Some("Claude Code was not found on this computer.".into()),
            ..Default::default()
        };
    };
    let mut info =
        ClaudeInfo { installed: true, path: Some(path.to_string_lossy().into_owned()), ..Default::default() };
    match run(&path, &["--version"]).await {
        Ok(out) => info.version = out.split_whitespace().next().map(str::to_string),
        Err(e) => info.error = Some(format!("`claude --version` failed: {e}")),
    }
    match run(&path, &["auth", "status"]).await {
        Ok(out) => {
            if let Ok(v) = serde_json::from_str::<Value>(out.trim()) {
                info.logged_in = v.get("loggedIn").and_then(Value::as_bool);
                info.auth_method = v.get("authMethod").and_then(Value::as_str).map(str::to_string);
                info.subscription = v.get("subscriptionType").and_then(Value::as_str).map(str::to_string);
            }
        }
        // `auth status` exits non-zero when logged out.
        Err(_) => info.logged_in = Some(false),
    }
    info
}

async fn run(program: &Path, args: &[&str]) -> Result<String, String> {
    let fut = command(program).args(args).output();
    let out = tokio::time::timeout(Duration::from_secs(20), fut)
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
