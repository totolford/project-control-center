//! GitHub access for the market through the user's `gh` CLI (its own login).
//!
//! Every call goes through [`Gh`] so the logic can be tested with fixtures;
//! [`GhCli`] runs `gh api`. Results carry the time they were fetched.

use std::path::PathBuf;

use serde_json::Value;

use super::{split_tools, GithubSkill, RepoSignal};
use crate::skills::parse_frontmatter;
use pcc_core::{Error, Result};

/// The two kinds of GitHub API calls the market makes.
pub trait Gh {
    /// JSON response of `gh api <path>`.
    fn json(&self, path: &str) -> Result<Value>;
    /// Raw bytes of a file or blob (`Accept: application/vnd.github.raw`).
    fn raw(&self, path: &str) -> Result<Vec<u8>>;
}

/// `gh api` (the GitHub CLI must be installed and logged in).
pub struct GhCli {
    pub exe: PathBuf,
}

impl GhCli {
    pub fn find() -> Option<GhCli> {
        pcc_platform::find_program(&pcc_platform::platform().executable_name("gh")).map(|exe| GhCli { exe })
    }

    fn run(&self, args: &[&str]) -> Result<Vec<u8>> {
        let out = crate::process::std_command(&self.exe)
            .args(args)
            .output()
            .map_err(|e| Error::Process(format!("gh: {e}")))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let msg = err.lines().find(|l| !l.trim().is_empty()).unwrap_or("gh api failed");
            return Err(Error::Process(format!("gh api: {}", msg.trim())));
        }
        Ok(out.stdout)
    }
}

impl Gh for GhCli {
    fn json(&self, path: &str) -> Result<Value> {
        let out = self.run(&["api", "-H", "Accept: application/vnd.github+json", path])?;
        Ok(serde_json::from_slice(&out)?)
    }
    fn raw(&self, path: &str) -> Result<Vec<u8>> {
        self.run(&["api", "-H", "Accept: application/vnd.github.raw", path])
    }
}

/// Percent-encodes a query string value.
pub fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn skill_dir_of(path: &str) -> Option<String> {
    let dir = path.strip_suffix("SKILL.md")?;
    (dir.is_empty() || dir.ends_with('/')).then(|| dir.trim_end_matches('/').to_string())
}

/// `(repo, folder)` pairs of a code search response for `filename:SKILL.md`.
pub fn parse_search(v: &Value) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for item in v.get("items").and_then(Value::as_array).into_iter().flatten() {
        let (Some(repo), Some(path)) =
            (item.pointer("/repository/full_name").and_then(Value::as_str), item.get("path").and_then(Value::as_str))
        else {
            continue;
        };
        let Some(dir) = skill_dir_of(path) else { continue };
        if !out.iter().any(|(r, d)| r == repo && *d == dir) {
            out.push((repo.to_string(), dir));
        }
    }
    out
}

/// One file of a repository tree.
#[derive(Debug, Clone, PartialEq)]
pub struct TreeFile {
    /// Path relative to the requested folder.
    pub path: String,
    pub size: u64,
    pub sha: String,
}

/// Files of a recursive tree below `folder` (empty = whole repository). `None` when truncated.
pub fn parse_tree(v: &Value, folder: &str) -> Option<Vec<TreeFile>> {
    if v.get("truncated").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let folder = folder.trim_matches('/');
    let prefix = if folder.is_empty() { String::new() } else { format!("{folder}/") };
    let mut out: Vec<TreeFile> = v
        .get("tree")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|e| e.get("type").and_then(Value::as_str) == Some("blob"))
        .filter_map(|e| {
            let path = e.get("path")?.as_str()?;
            let rel = path.strip_prefix(&prefix)?;
            Some(TreeFile {
                path: rel.to_string(),
                size: e.get("size").and_then(Value::as_u64).unwrap_or(0),
                sha: e.get("sha")?.as_str()?.to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Some(out)
}

/// SKILL.md folders of a recursive tree (whole repository).
pub fn skill_folders(v: &Value) -> Vec<String> {
    let mut dirs: Vec<String> = parse_tree(v, "")
        .unwrap_or_default()
        .iter()
        .filter_map(|f| skill_dir_of(&f.path))
        .filter(|d| !d.split('/').any(|p| p == "node_modules" || (p.starts_with('.') && p != ".claude")))
        .collect();
    dirs.sort();
    dirs
}

pub fn parse_signal(v: &Value, fetched_at: &str) -> RepoSignal {
    RepoSignal {
        stars: v.get("stargazers_count").and_then(Value::as_u64).unwrap_or(0),
        pushed_at: v.get("pushed_at").and_then(Value::as_str).map(str::to_string),
        license: v
            .pointer("/license/spdx_id")
            .and_then(Value::as_str)
            .filter(|s| *s != "NOASSERTION")
            .map(str::to_string),
        archived: v.get("archived").and_then(Value::as_bool).unwrap_or(false),
        fetched_at: fetched_at.to_string(),
    }
}

/// A [`GithubSkill`] from the text of its SKILL.md.
pub fn skill_from_md(repo: &str, dir: &str, text: &str, origin: &str, query: Option<&str>, now: &str) -> GithubSkill {
    let (fm, _) = parse_frontmatter(text);
    let fallback =
        dir.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or_else(|| repo.rsplit('/').next().unwrap_or(repo));
    GithubSkill {
        repo: repo.to_string(),
        path: dir.to_string(),
        name: fm.get("name").cloned().unwrap_or_else(|| fallback.to_string()),
        description: fm.get("description").cloned().unwrap_or_default(),
        version: fm.get("version").or_else(|| fm.get("metadata.version")).cloned(),
        license: fm.get("license").cloned(),
        allowed_tools: split_tools(fm.get("allowed-tools").map(String::as_str)),
        origin: origin.to_string(),
        query: query.map(str::to_string),
        fetched_at: now.to_string(),
    }
}

fn md_path(dir: &str) -> String {
    if dir.is_empty() {
        "SKILL.md".into()
    } else {
        format!("{dir}/SKILL.md")
    }
}

fn read_skill(gh: &dyn Gh, repo: &str, dir: &str) -> Result<String> {
    let bytes = gh.raw(&format!("repos/{repo}/contents/{}", md_path(dir)))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// GitHub code search for SKILL.md files matching `query`; reads the frontmatter of up to `limit` hits.
pub fn search(gh: &dyn Gh, query: &str, limit: usize, now: &str) -> Result<Vec<GithubSkill>> {
    let q = format!("{} filename:SKILL.md", query.trim());
    let v = gh.json(&format!("search/code?q={}&per_page=50", encode(&q)))?;
    let mut out = Vec::new();
    for (repo, dir) in parse_search(&v).into_iter().take(limit) {
        if let Ok(text) = read_skill(gh, &repo, &dir) {
            out.push(skill_from_md(&repo, &dir, &text, "search", Some(query), now));
        }
    }
    Ok(out)
}

/// Every SKILL.md folder of a user-configured repository (at most `limit`).
pub fn scan_repo(gh: &dyn Gh, repo: &str, limit: usize, now: &str) -> Result<Vec<GithubSkill>> {
    let tree = gh.json(&format!("repos/{repo}/git/trees/HEAD?recursive=1"))?;
    let mut out = Vec::new();
    for dir in skill_folders(&tree).into_iter().take(limit) {
        let text = read_skill(gh, repo, &dir)?;
        out.push(skill_from_md(repo, &dir, &text, "user", None, now));
    }
    Ok(out)
}

pub fn signal(gh: &dyn Gh, repo: &str, now: &str) -> Result<RepoSignal> {
    Ok(parse_signal(&gh.json(&format!("repos/{repo}"))?, now))
}

/// Latest commit touching `folder` (or the default branch head).
pub fn latest_commit(gh: &dyn Gh, repo: &str, folder: &str) -> Result<String> {
    let folder = folder.trim_matches('/');
    let path = if folder.is_empty() {
        format!("repos/{repo}/commits?per_page=1")
    } else {
        format!("repos/{repo}/commits?per_page=1&path={}", encode(folder))
    };
    gh.json(&path)?
        .pointer("/0/sha")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| Error::not_found(format!("no commit for {repo}/{folder}")))
}

/// Whether `folder` changed between `installed` and the default branch head:
/// `Some(true)` when a newer commit touches it.
pub fn folder_changed(gh: &dyn Gh, repo: &str, folder: &str, installed: &str) -> Result<bool> {
    let latest = latest_commit(gh, repo, folder)?;
    if latest == installed {
        return Ok(false);
    }
    let v = gh.json(&format!("repos/{repo}/compare/{installed}...{latest}"))?;
    Ok(matches!(v.get("status").and_then(Value::as_str), Some("ahead" | "diverged")))
}

/// Head commit of the default branch (the reference files are read from).
pub fn head_commit(gh: &dyn Gh, repo: &str) -> Result<String> {
    gh.json(&format!("repos/{repo}/commits/HEAD"))?
        .get("sha")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| Error::not_found(format!("head commit of {repo}")))
}

/// Files below `folder` at commit `reference`.
pub fn list_files(gh: &dyn Gh, repo: &str, folder: &str, reference: &str) -> Result<Vec<TreeFile>> {
    let tree = gh.json(&format!("repos/{repo}/git/trees/{reference}?recursive=1"))?;
    parse_tree(&tree, folder)
        .ok_or_else(|| Error::invalid(format!("{repo} is too large to list through the GitHub API")))
}

pub fn blob(gh: &dyn Gh, repo: &str, sha: &str) -> Result<Vec<u8>> {
    gh.raw(&format!("repos/{repo}/git/blobs/{sha}"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    /// Answers from fixtures; unknown paths fail like a 404.
    #[derive(Default)]
    pub struct FakeGh {
        pub json: HashMap<String, Value>,
        pub raw: HashMap<String, Vec<u8>>,
    }

    impl Gh for FakeGh {
        fn json(&self, path: &str) -> Result<Value> {
            self.json.get(path).cloned().ok_or_else(|| Error::not_found(path.to_string()))
        }
        fn raw(&self, path: &str) -> Result<Vec<u8>> {
            self.raw.get(path).cloned().ok_or_else(|| Error::not_found(path.to_string()))
        }
    }

    #[test]
    fn search_reads_frontmatter_of_hits() {
        let mut gh = FakeGh::default();
        gh.json.insert(
            format!("search/code?q={}&per_page=50", encode("roblox filename:SKILL.md")),
            json!({"items": [
                {"path": "skills/roblox-luau/SKILL.md", "repository": {"full_name": "a/b"}},
                {"path": "skills/roblox-luau/SKILL.md", "repository": {"full_name": "a/b"}},
                {"path": "docs/NOT_SKILL.md", "repository": {"full_name": "a/b"}},
                {"path": "SKILL.md", "repository": {"full_name": "c/d"}}
            ]}),
        );
        gh.raw.insert(
            "repos/a/b/contents/skills/roblox-luau/SKILL.md".into(),
            b"---\nname: roblox-luau\ndescription: Luau\nallowed-tools: Read, Bash\nmetadata:\n  version: \"1.2\"\n---\nbody".to_vec(),
        );
        gh.raw.insert("repos/c/d/contents/SKILL.md".into(), b"no frontmatter".to_vec());
        let hits = search(&gh, "roblox", 10, "now").unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].name, "roblox-luau");
        assert_eq!(hits[0].version.as_deref(), Some("1.2"));
        assert_eq!(hits[0].allowed_tools, vec!["Read", "Bash"]);
        assert_eq!(hits[0].query.as_deref(), Some("roblox"));
        assert_eq!(hits[1].name, "d", "falls back to the repository name");
        assert_eq!(hits[1].path, "");
    }

    #[test]
    fn tree_and_signal_parsing() {
        let tree = json!({"truncated": false, "tree": [
            {"path": "skills/x/SKILL.md", "type": "blob", "size": 10, "sha": "s1"},
            {"path": "skills/x/scripts/run.sh", "type": "blob", "size": 5, "sha": "s2"},
            {"path": "skills/x/scripts", "type": "tree", "sha": "t"},
            {"path": "skills/xy/SKILL.md", "type": "blob", "size": 1, "sha": "s3"},
            {"path": "node_modules/p/SKILL.md", "type": "blob", "size": 1, "sha": "s4"},
            {"path": ".claude/skills/z/SKILL.md", "type": "blob", "size": 1, "sha": "s5"}
        ]});
        let files = parse_tree(&tree, "skills/x").unwrap();
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["SKILL.md", "scripts/run.sh"]);
        assert_eq!(skill_folders(&tree), vec![".claude/skills/z", "skills/x", "skills/xy"]);
        assert!(parse_tree(&json!({"truncated": true, "tree": []}), "").is_none());

        let s = parse_signal(
            &json!({"stargazers_count": 7, "pushed_at": "2026-09-01T00:00:00Z", "license": {"spdx_id": "NOASSERTION"}}),
            "t",
        );
        assert_eq!(s.stars, 7);
        assert_eq!(s.license, None);
        assert_eq!(encode("a b/c"), "a%20b%2Fc");
    }

    /// Real GitHub call (needs `gh` logged in): `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn real_github_signal() {
        let gh = GhCli::find().expect("gh on PATH");
        let s = signal(&gh, "anthropics/skills", "now").unwrap();
        assert!(s.stars > 0);
    }
}
