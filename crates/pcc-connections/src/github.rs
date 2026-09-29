//! GitHub through the user's existing `gh` CLI login. No token is stored by
//! the application.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use pcc_claude::process::std_command;
use pcc_core::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub cli_installed: bool,
    pub authenticated: bool,
    pub account: Option<String>,
    pub repo: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GithubOverview {
    pub repo: String,
    pub description: Option<String>,
    pub default_branch: Option<String>,
    pub visibility: Option<String>,
    pub url: Option<String>,
    pub pull_requests: Vec<Value>,
    pub issues: Vec<Value>,
    pub branches: Vec<String>,
}

fn gh(dir: &Path, args: &[&str]) -> Result<String> {
    let out = std_command("gh")
        .args(args)
        .current_dir(dir)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .output()
        .map_err(|e| Error::Process(format!("cannot run gh: {e}")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(Error::Process(String::from_utf8_lossy(&out.stderr).trim().to_string()))
    }
}

/// `https://github.com/o/r(.git)` or `git@github.com:o/r(.git)` -> `o/r`.
pub fn parse_repo(remote: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches(".git").trim_end_matches('/');
    let rest = r
        .strip_prefix("https://github.com/")
        .or_else(|| r.strip_prefix("http://github.com/"))
        .or_else(|| r.strip_prefix("git@github.com:"))
        .or_else(|| r.strip_prefix("ssh://git@github.com/"))?;
    let parts: Vec<&str> = rest.split('/').collect();
    (parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty()).then(|| format!("{}/{}", parts[0], parts[1]))
}

pub fn status(dir: &Path, remote_url: Option<&str>) -> GithubStatus {
    let mut s = GithubStatus { repo: remote_url.and_then(parse_repo), ..Default::default() };
    if gh(dir, &["--version"]).is_err() {
        s.detail = Some("GitHub CLI (gh) is not installed.".into());
        return s;
    }
    s.cli_installed = true;
    match gh(dir, &["api", "user", "--jq", ".login"]) {
        Ok(login) => {
            s.authenticated = true;
            s.account = Some(login.trim().to_string());
        }
        Err(_) => s.detail = Some("Run `gh auth login` to connect your GitHub account.".into()),
    }
    s
}

pub fn overview(dir: &Path, repo: &str) -> Result<GithubOverview> {
    let info: Value = serde_json::from_str(&gh(dir, &["api", &format!("repos/{repo}")])?)?;
    let prs: Vec<Value> = serde_json::from_str(&gh(
        dir,
        &[
            "pr",
            "list",
            "-R",
            repo,
            "--limit",
            "20",
            "--json",
            "number,title,state,headRefName,url,author,isDraft,updatedAt",
        ],
    )?)?;
    let issues: Vec<Value> = serde_json::from_str(&gh(
        dir,
        &["issue", "list", "-R", repo, "--limit", "20", "--json", "number,title,state,url,author,labels,updatedAt"],
    )?)
    .unwrap_or_default();
    let branches = gh(dir, &["api", &format!("repos/{repo}/branches?per_page=100"), "--jq", ".[].name"])?
        .lines()
        .map(str::to_string)
        .collect();
    Ok(GithubOverview {
        repo: repo.into(),
        description: info.get("description").and_then(Value::as_str).map(str::to_string),
        default_branch: info.get("default_branch").and_then(Value::as_str).map(str::to_string),
        visibility: info.get("visibility").and_then(Value::as_str).map(str::to_string),
        url: info.get("html_url").and_then(Value::as_str).map(str::to_string),
        pull_requests: prs,
        issues,
        branches,
    })
}

/// Pushes `branch` and opens a pull request. Only called on an explicit user action.
pub fn create_pull_request(
    dir: &Path,
    repo: &str,
    branch: &str,
    base: &str,
    title: &str,
    body: &str,
) -> Result<String> {
    let push = std_command("git")
        .args(["push", "-u", "origin", branch])
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| Error::Git(e.to_string()))?;
    if !push.status.success() {
        return Err(Error::Git(String::from_utf8_lossy(&push.stderr).trim().to_string()));
    }
    let url =
        gh(dir, &["pr", "create", "-R", repo, "--head", branch, "--base", base, "--title", title, "--body", body])?;
    Ok(url.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remotes() {
        assert_eq!(parse_repo("https://github.com/totolford/aeris.git").as_deref(), Some("totolford/aeris"));
        assert_eq!(parse_repo("git@github.com:a/b").as_deref(), Some("a/b"));
        assert_eq!(parse_repo("https://gitlab.com/a/b"), None);
        assert_eq!(parse_repo("https://github.com/a"), None);
    }
}
