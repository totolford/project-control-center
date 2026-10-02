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

// ------------------------------------------------------------ account & repositories

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccount {
    pub login: String,
    pub name: Option<String>,
    pub url: Option<String>,
    /// OAuth scopes of the gh token, as reported by `gh auth status`.
    pub scopes: Vec<String>,
    pub organizations: Vec<String>,
    pub git_protocol: Option<String>,
    /// What the token allows (derived from its scopes).
    pub abilities: Vec<GithubAbility>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GithubAbility {
    pub action: String,
    pub allowed_by_token: bool,
    pub requires: String,
}

pub fn scopes_from_status(text: &str) -> Vec<String> {
    text.lines()
        .find_map(|l| l.split_once("Token scopes:").map(|(_, s)| s.to_string()))
        .map(|s| s.split(',').map(|x| x.trim().trim_matches('\'').to_string()).filter(|x| !x.is_empty()).collect())
        .unwrap_or_default()
}

pub fn abilities(scopes: &[String]) -> Vec<GithubAbility> {
    let has = |s: &str| scopes.iter().any(|x| x == s);
    let repo = has("repo");
    let row = |action: &str, ok: bool, requires: &str| GithubAbility {
        action: action.into(),
        allowed_by_token: ok,
        requires: requires.into(),
    };
    vec![
        row("Read public repositories", true, "-"),
        row("Read private repositories, issues and pull requests", repo, "repo"),
        row("Clone, create branches, commit and push", repo, "repo"),
        row("Create issues and pull requests", repo, "repo"),
        row("Read and trigger Actions workflows", repo && has("workflow"), "repo + workflow"),
        row("Create releases", repo, "repo"),
        row("Read organizations", has("read:org") || has("admin:org"), "read:org"),
        row("Delete repositories", has("delete_repo"), "delete_repo"),
    ]
}

/// Signed-in account with token scopes and organizations.
pub fn account(dir: &Path) -> Result<GithubAccount> {
    let user: Value = serde_json::from_str(&gh(dir, &["api", "user"])?)?;
    let status = std_command("gh")
        .args(["auth", "status"])
        .current_dir(dir)
        .output()
        .map_err(|e| Error::Process(e.to_string()))?;
    // gh writes its status to stderr on some versions, stdout on others.
    let text = format!("{}{}", String::from_utf8_lossy(&status.stdout), String::from_utf8_lossy(&status.stderr));
    let organizations = gh(dir, &["api", "user/orgs", "--jq", ".[].login"])
        .map(|s| s.lines().map(str::to_string).collect())
        .unwrap_or_default();
    let scopes = scopes_from_status(&text);
    Ok(GithubAccount {
        login: user.get("login").and_then(Value::as_str).unwrap_or_default().to_string(),
        name: user.get("name").and_then(Value::as_str).map(str::to_string),
        url: user.get("html_url").and_then(Value::as_str).map(str::to_string),
        abilities: abilities(&scopes),
        scopes,
        organizations,
        git_protocol: text
            .lines()
            .find_map(|l| l.split_once("Git operations protocol:").map(|(_, p)| p.trim().to_string())),
    })
}

/// Repositories of the account or of `owner`, optionally filtered by search words.
pub fn repositories(dir: &Path, owner: Option<&str>, query: Option<&str>, limit: u32) -> Result<Vec<Value>> {
    let limit = limit.clamp(1, 200).to_string();
    let fields =
        "name,nameWithOwner,description,visibility,isPrivate,isFork,updatedAt,url,defaultBranchRef,primaryLanguage";
    let mut args = vec!["repo", "list"];
    if let Some(o) = owner.filter(|o| !o.is_empty()) {
        args.push(o);
    }
    args.extend(["--limit", &limit, "--json", fields]);
    let mut list: Vec<Value> = serde_json::from_str(&gh(dir, &args)?)?;
    if let Some(q) = query.map(str::to_ascii_lowercase).filter(|q| !q.trim().is_empty()) {
        let words: Vec<String> = q.split_whitespace().map(str::to_string).collect();
        list.retain(|r| {
            let hay = format!(
                "{} {}",
                r.get("nameWithOwner").and_then(Value::as_str).unwrap_or(""),
                r.get("description").and_then(Value::as_str).unwrap_or("")
            )
            .to_ascii_lowercase();
            words.iter().all(|w| hay.contains(w.as_str()))
        });
    }
    Ok(list)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDetail {
    pub repo: String,
    pub info: Value,
    pub issues: Vec<Value>,
    pub pull_requests: Vec<Value>,
    pub runs: Vec<Value>,
    pub releases: Vec<Value>,
    pub branches: Vec<String>,
    pub commits: Vec<Value>,
    /// Sections gh refused (e.g. Actions disabled), with the reason.
    pub unavailable: Vec<String>,
}

const COMMITS_JQ: &str =
    "[.[] | {sha: .sha[0:7], message: (.commit.message | split(\"\\n\")[0]), author: .commit.author.name, date: .commit.author.date, url: .html_url}]";

pub fn repository_detail(dir: &Path, repo: &str) -> Result<RepositoryDetail> {
    let info: Value = serde_json::from_str(&gh(dir, &["api", &format!("repos/{repo}")])?)?;
    let mut unavailable = Vec::new();
    let mut json = |name: &str, args: &[&str]| -> Vec<Value> {
        match gh(dir, args).and_then(|s| serde_json::from_str::<Vec<Value>>(&s).map_err(Error::from)) {
            Ok(v) => v,
            Err(e) => {
                unavailable.push(format!("{name}: {e}"));
                vec![]
            }
        }
    };
    let issues = json(
        "issues",
        &["issue", "list", "-R", repo, "--limit", "30", "--json", "number,title,state,url,author,labels,updatedAt"],
    );
    let pull_requests = json(
        "pull requests",
        &[
            "pr",
            "list",
            "-R",
            repo,
            "--limit",
            "30",
            "--json",
            "number,title,state,headRefName,url,author,isDraft,updatedAt",
        ],
    );
    let runs = json(
        "actions",
        &[
            "run",
            "list",
            "-R",
            repo,
            "--limit",
            "20",
            "--json",
            "databaseId,name,status,conclusion,headBranch,event,createdAt,url",
        ],
    );
    let releases = json(
        "releases",
        &[
            "release",
            "list",
            "-R",
            repo,
            "--limit",
            "20",
            "--json",
            "tagName,name,isLatest,isDraft,isPrerelease,publishedAt",
        ],
    );
    let commits_path = format!("repos/{repo}/commits?per_page=20");
    let commits = json("commits", &["api", &commits_path, "--jq", COMMITS_JQ]);
    let branches_path = format!("repos/{repo}/branches?per_page=100");
    let branches = match gh(dir, &["api", &branches_path, "--jq", ".[].name"]) {
        Ok(s) => s.lines().map(str::to_string).collect(),
        Err(e) => {
            unavailable.push(format!("branches: {e}"));
            vec![]
        }
    };
    Ok(RepositoryDetail {
        repo: repo.into(),
        info,
        issues,
        pull_requests,
        runs,
        releases,
        branches,
        commits,
        unavailable,
    })
}

/// `gh repo clone owner/repo <parent>/<name>`; returns the new folder.
pub fn clone_repository(repo: &str, parent: &Path) -> Result<std::path::PathBuf> {
    let name =
        repo.rsplit('/').next().filter(|n| !n.is_empty()).ok_or_else(|| Error::invalid("expected owner/repo"))?;
    let dest = parent.join(name.trim_end_matches(".git"));
    if dest.exists() {
        return Err(Error::Conflict(format!("{} already exists", dest.display())));
    }
    gh(parent, &["repo", "clone", repo, &dest.to_string_lossy()])?;
    Ok(dest)
}

pub fn create_issue(dir: &Path, repo: &str, title: &str, body: &str) -> Result<String> {
    Ok(gh(dir, &["issue", "create", "-R", repo, "--title", title, "--body", body])?.trim().to_string())
}

/// Triggers a `workflow_dispatch` workflow.
pub fn run_workflow(dir: &Path, repo: &str, workflow: &str, git_ref: &str) -> Result<String> {
    gh(dir, &["workflow", "run", workflow, "-R", repo, "--ref", git_ref])?;
    Ok(format!("{workflow} dispatched on {git_ref}"))
}

#[cfg(test)]
mod account_tests {
    use super::*;

    #[test]
    fn scopes_and_abilities() {
        let text = "github.com\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n";
        let scopes = scopes_from_status(text);
        assert_eq!(scopes, vec!["gist", "read:org", "repo", "workflow"]);
        let a = abilities(&scopes);
        assert!(a.iter().find(|x| x.action.starts_with("Read and trigger Actions")).unwrap().allowed_by_token);
        assert!(!a.iter().find(|x| x.action == "Delete repositories").unwrap().allowed_by_token);
        assert!(scopes_from_status("not logged in").is_empty());
    }
}
