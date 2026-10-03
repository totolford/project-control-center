//! Analysis and installation of standalone GitHub skills.
//!
//! Files are listed and inspected before anything is written; the install
//! downloads exactly the files of the analyzed commit into a staging folder
//! next to the skills folder, then moves it into place and records its origin
//! in `.nexus-source.json`. Plugins are not handled here: they go through
//! `claude plugin install` (Claude Code's own mechanism).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::github::{self, Gh, TreeFile};
use super::security::{self, ScanFile, SecurityReport};
use super::{Provenance, PROVENANCE_FILE};
use crate::skills::{self, SkillRoots};
use pcc_core::{Error, Result};

/// Files larger than this are listed but not read.
pub const MAX_INSPECT_BYTES: u64 = 512 * 1024;
/// Total bytes read for an analysis.
const INSPECT_BUDGET: u64 = 8 * 1024 * 1024;
/// Most files read for an analysis.
const INSPECT_FILES: usize = 300;
/// A standalone skill bigger than this is refused.
pub const MAX_INSTALL_FILES: usize = 1000;
pub const MAX_INSTALL_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanFile {
    pub path: String,
    pub size: u64,
    /// `skill`, `text`, `script`, `data`, `asset`, `archive`, `binary`.
    pub kind: String,
    pub inspected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    /// Files that would be installed (or that the plugin contains).
    pub files: Vec<PlanFile>,
    /// `local` (marketplace clone / installed folder) or `github`.
    pub files_source: String,
    /// Folder or `owner/repo/path`.
    pub location: String,
    /// Commit the GitHub files were read at.
    pub reference: Option<String>,
    pub security: SecurityReport,
    /// The listing stopped at the file limit.
    pub truncated: bool,
}

fn report(files: &[(PlanFile, Option<Vec<u8>>)]) -> SecurityReport {
    let scan: Vec<ScanFile> =
        files.iter().map(|(f, c)| ScanFile { path: &f.path, size: f.size, content: c.as_deref() }).collect();
    security::analyze(&scan)
}

fn plan_file(path: &str, size: u64, inspected: bool) -> PlanFile {
    PlanFile { path: path.to_string(), size, kind: security::kind(path).into(), inspected }
}

/// Analyzes a folder on disk (marketplace clone or installed skill / plugin).
pub fn analyze_local(dir: &Path) -> Result<Analysis> {
    if !dir.is_dir() {
        return Err(Error::not_found(dir.display().to_string()));
    }
    let mut paths = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    let mut truncated = false;
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d)?.flatten() {
            let p = e.path();
            if p.is_dir() {
                if e.file_name() != ".git" {
                    stack.push(p);
                }
            } else if paths.len() >= MAX_INSTALL_FILES * 2 {
                truncated = true;
            } else {
                paths.push(p);
            }
        }
    }
    paths.sort();
    let mut budget = INSPECT_BUDGET;
    let mut read = 0;
    let files: Vec<(PlanFile, Option<Vec<u8>>)> = paths
        .iter()
        .filter_map(|p| {
            let rel = p.strip_prefix(dir).ok()?.to_string_lossy().replace('\\', "/");
            let size = p.metadata().map(|m| m.len()).unwrap_or(0);
            let content =
                (security::inspectable(&rel, size, MAX_INSPECT_BYTES) && size <= budget && read < INSPECT_FILES)
                    .then(|| fs::read(p).ok())
                    .flatten();
            if content.is_some() {
                budget -= size;
                read += 1;
            }
            Some((plan_file(&rel, size, content.is_some()), content))
        })
        .collect();
    Ok(Analysis {
        security: report(&files),
        files: files.into_iter().map(|(f, _)| f).collect(),
        files_source: "local".into(),
        location: dir.to_string_lossy().into_owned(),
        reference: None,
        truncated,
    })
}

/// Analyzes `folder` of `repo` at commit `reference` (files fetched through `gh`).
pub fn analyze_github(gh: &dyn Gh, repo: &str, folder: &str, reference: &str) -> Result<Analysis> {
    let listed = github::list_files(gh, repo, folder, reference)?;
    let truncated = listed.len() > MAX_INSTALL_FILES * 2;
    let mut budget = INSPECT_BUDGET;
    let mut read = 0;
    let files: Vec<(PlanFile, Option<Vec<u8>>)> = listed
        .iter()
        .take(MAX_INSTALL_FILES * 2)
        .map(|f| {
            let content =
                (security::inspectable(&f.path, f.size, MAX_INSPECT_BYTES) && f.size <= budget && read < INSPECT_FILES)
                    .then(|| github::blob(gh, repo, &f.sha).ok())
                    .flatten();
            if content.is_some() {
                budget -= f.size;
                read += 1;
            }
            (plan_file(&f.path, f.size, content.is_some()), content)
        })
        .collect();
    let folder = folder.trim_matches('/');
    Ok(Analysis {
        security: report(&files),
        files: files.into_iter().map(|(f, _)| f).collect(),
        files_source: "github".into(),
        location: if folder.is_empty() { repo.to_string() } else { format!("{repo}/{folder}") },
        reference: Some(reference.to_string()),
        truncated,
    })
}

/// Folder name of a standalone skill: the last segment of its path, or the repository name.
pub fn folder_name(repo: &str, path: &str) -> Result<String> {
    let last = path.trim_matches('/').rsplit('/').next().filter(|s| !s.is_empty());
    let name =
        last.unwrap_or_else(|| repo.rsplit('/').next().unwrap_or(repo)).to_ascii_lowercase().replace(['_', '.'], "-");
    skills::validate_name(&name)?;
    Ok(name)
}

/// Rejects paths that could escape the skill folder.
fn safe_rel(path: &str) -> Result<PathBuf> {
    let bad = path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains(':')
        || path.split('/').any(|p| p.is_empty() || p == "." || p == "..");
    if bad || path == PROVENANCE_FILE {
        return Err(Error::invalid(format!("unsafe file path in the repository: {path}")));
    }
    Ok(path.split('/').collect())
}

/// Downloads `files` into `dir` (created).
fn download(gh: &dyn Gh, repo: &str, files: &[TreeFile], dir: &Path) -> Result<()> {
    let total: u64 = files.iter().map(|f| f.size).sum();
    if files.len() > MAX_INSTALL_FILES || total > MAX_INSTALL_BYTES {
        return Err(Error::invalid(format!(
            "{} file(s), {} MB: too large for a standalone skill",
            files.len(),
            total / 1024 / 1024
        )));
    }
    if !files.iter().any(|f| f.path == "SKILL.md") {
        return Err(Error::invalid("the folder has no SKILL.md at its root"));
    }
    let rels = files.iter().map(|f| safe_rel(&f.path)).collect::<Result<Vec<_>>>()?;
    for (f, rel) in files.iter().zip(rels) {
        let target = dir.join(rel);
        if let Some(p) = target.parent() {
            fs::create_dir_all(p)?;
        }
        fs::write(target, github::blob(gh, repo, &f.sha)?)?;
    }
    Ok(())
}

fn staging_dir(root: &Path, name: &str) -> PathBuf {
    root.join(format!(".nexus-staging-{name}"))
}

/// What to install: a folder of a repository at an analyzed commit.
pub struct InstallRequest<'a> {
    pub market_id: &'a str,
    pub repo: &'a str,
    pub path: &'a str,
    /// Commit that was analyzed and shown to the user.
    pub reference: &'a str,
    /// `~/.claude/skills` or `<project>/.claude/skills`.
    pub root: &'a Path,
    pub now: &'a str,
}

fn stage(gh: &dyn Gh, req: &InstallRequest, name: &str) -> Result<(PathBuf, Provenance)> {
    let files = github::list_files(gh, req.repo, req.path, req.reference)?;
    let staging = staging_dir(req.root, name);
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;
    let prov = Provenance {
        market_id: req.market_id.to_string(),
        repository: req.repo.to_string(),
        path: req.path.trim_matches('/').to_string(),
        reference: req.reference.to_string(),
        installed_at: req.now.to_string(),
        files: files.iter().map(|f| f.path.clone()).collect(),
    };
    let done =
        download(gh, req.repo, &files, &staging).and_then(|_| super::write_json(&staging.join(PROVENANCE_FILE), &prov));
    if let Err(e) = done {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    Ok((staging, prov))
}

/// Installs a standalone skill; refuses when a folder of that name exists (enabled or disabled).
pub fn install_github(gh: &dyn Gh, req: &InstallRequest) -> Result<(PathBuf, Provenance)> {
    let name = folder_name(req.repo, req.path)?;
    let target = req.root.join(&name);
    let disabled = req.root.with_file_name("skills-disabled").join(&name);
    if target.exists() || disabled.exists() {
        return Err(Error::Conflict(format!("a skill folder named {name} already exists in {}", req.root.display())));
    }
    fs::create_dir_all(req.root)?;
    let (staging, prov) = stage(gh, req, &name)?;
    fs::rename(&staging, &target)?;
    Ok((target, prov))
}

/// Provenance of a folder installed by NEXUS, if any.
pub fn provenance(dir: &Path) -> Option<Provenance> {
    let text = fs::read_to_string(dir.join(PROVENANCE_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Replaces an installed standalone skill with the files of `req.reference`;
/// the previous version goes to `skills-trash/` (recoverable).
pub fn update_github(gh: &dyn Gh, roots: &SkillRoots, dir: &Path, req: &InstallRequest) -> Result<(PathBuf, PathBuf)> {
    if provenance(dir).is_none() {
        return Err(Error::invalid("only skills installed by NEXUS (with .nexus-source.json) can be updated here"));
    }
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or_else(|| Error::invalid("bad folder"))?;
    let root = dir.parent().ok_or_else(|| Error::invalid("bad folder"))?;
    let (staging, _) = stage(gh, &InstallRequest { root, ..*req }, &name)?;
    let trashed = match trash(roots, dir) {
        Ok(t) => t,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    fs::rename(&staging, dir)?;
    Ok((dir.to_path_buf(), trashed))
}

/// Moves a skill installed by NEXUS to `skills-trash/` (recoverable).
pub fn uninstall_github(roots: &SkillRoots, dir: &Path) -> Result<PathBuf> {
    if provenance(dir).is_none() {
        return Err(Error::invalid("this skill was not installed by NEXUS: delete it from the Skills view"));
    }
    trash(roots, dir)
}

/// Moves a user / project skill folder to `skills-trash/<name>-<timestamp>` (unique).
fn trash(roots: &SkillRoots, dir: &Path) -> Result<PathBuf> {
    let root = dir.parent().ok_or_else(|| Error::invalid("bad skill folder"))?;
    let known = [&roots.user, &roots.project].into_iter().flatten().any(|r| r == root);
    if !known {
        return Err(Error::invalid(format!("{} is not in a user or project skills folder", dir.display())));
    }
    let name = dir.file_name().ok_or_else(|| Error::invalid("bad skill folder"))?.to_string_lossy().into_owned();
    let stamp: String = pcc_core::now().chars().filter(|c| c.is_ascii_digit()).take(14).collect();
    let bin = root.with_file_name("skills-trash");
    fs::create_dir_all(&bin)?;
    let mut target = bin.join(format!("{name}-{stamp}"));
    let mut n = 2;
    while target.exists() {
        target = bin.join(format!("{name}-{stamp}-{n}"));
        n += 1;
    }
    fs::rename(dir, &target)?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::super::github::tests::FakeGh;
    use super::*;
    use serde_json::json;

    const REPO: &str = "acme/skills";
    const SHA: &str = "c0ffee";

    fn fake() -> FakeGh {
        let mut gh = FakeGh::default();
        gh.json.insert(
            format!("repos/{REPO}/git/trees/{SHA}?recursive=1"),
            json!({"tree": [
                {"path": "skills/lint/SKILL.md", "type": "blob", "size": 40, "sha": "b1"},
                {"path": "skills/lint/scripts/run.sh", "type": "blob", "size": 20, "sha": "b2"},
                {"path": "skills/lint/logo.png", "type": "blob", "size": 4, "sha": "b3"},
                {"path": "skills/evil/SKILL.md", "type": "blob", "size": 1, "sha": "b1"},
                {"path": "skills/evil/../../x", "type": "blob", "size": 1, "sha": "b2"}
            ]}),
        );
        gh.raw.insert(
            format!("repos/{REPO}/git/blobs/b1"),
            b"---\nname: lint\ndescription: Lint\n---\nRun the linter.".to_vec(),
        );
        gh.raw.insert(format!("repos/{REPO}/git/blobs/b2"), b"#!/bin/sh\nnpx eslint .\n".to_vec());
        gh.raw.insert(format!("repos/{REPO}/git/blobs/b3"), vec![0x89, b'P', b'N', b'G']);
        gh
    }

    fn roots(tmp: &Path) -> SkillRoots {
        SkillRoots { user: Some(tmp.join(".claude").join("skills")), project: None, plugins: vec![] }
    }

    fn req<'a>(root: &'a Path, path: &'a str) -> InstallRequest<'a> {
        InstallRequest { market_id: "gh:acme/skills/skills/lint", repo: REPO, path, reference: SHA, root, now: "t" }
    }

    #[test]
    fn analysis_lists_files_before_install() {
        let gh = fake();
        let a = analyze_github(&gh, REPO, "skills/lint", SHA).unwrap();
        let paths: Vec<_> = a.files.iter().map(|f| (f.path.as_str(), f.kind.as_str(), f.inspected)).collect();
        assert_eq!(
            paths,
            vec![("SKILL.md", "skill", true), ("logo.png", "asset", false), ("scripts/run.sh", "script", true)]
        );
        assert_eq!(a.reference.as_deref(), Some(SHA));
        assert!(a.security.needs_confirmation, "contains a script");
        assert_eq!(a.location, "acme/skills/skills/lint");
    }

    #[test]
    fn install_update_uninstall_in_temp_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = roots(tmp.path());
        let root = roots.user.clone().unwrap();
        let gh = fake();
        let (dir, prov) = install_github(&gh, &req(&root, "skills/lint")).unwrap();
        assert_eq!(dir, root.join("lint"));
        assert!(dir.join("scripts").join("run.sh").is_file());
        assert_eq!(prov.files.len(), 3);
        assert_eq!(provenance(&dir).unwrap().reference, SHA);
        assert!(!staging_dir(&root, "lint").exists());

        // The listed skill is recognized as installed by NEXUS.
        let listed = skills::list(&roots);
        assert_eq!(listed.len(), 1);
        assert_eq!(super::super::read_provenance(&listed)[&listed[0].dir].repository, REPO);

        // Same name again: refused, nothing overwritten.
        assert!(matches!(install_github(&gh, &req(&root, "skills/lint")), Err(Error::Conflict(_))));

        let (_, trashed) = update_github(&gh, &roots, &dir, &req(&root, "skills/lint")).unwrap();
        assert!(trashed.join("SKILL.md").is_file() && dir.join("SKILL.md").is_file());

        let gone = uninstall_github(&roots, &dir).unwrap();
        assert!(!dir.exists() && gone.join(PROVENANCE_FILE).is_file());
    }

    #[test]
    fn unsafe_paths_and_foreign_skills_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = roots(tmp.path());
        let root = roots.user.clone().unwrap();
        let err = install_github(&fake(), &req(&root, "skills/evil")).unwrap_err();
        assert!(err.to_string().contains("unsafe"), "{err}");
        assert!(!root.join("evil").exists() && !staging_dir(&root, "evil").exists());

        let own = root.join("mine");
        fs::create_dir_all(&own).unwrap();
        fs::write(own.join("SKILL.md"), "---\nname: mine\n---\nx").unwrap();
        assert!(uninstall_github(&roots, &own).is_err());
        assert_eq!(folder_name("o/Repo_Name", "").unwrap(), "repo-name");
    }
}
