//! "Sync with AI Town upstream": compares the NEXUS copy of AI Town with the
//! latest a16z-infra/ai-town and prepares a migration plan. NEXUS changes are
//! never overwritten: files changed on both sides are 3-way merged with
//! `git merge-file`, and conflicting ones are left for a human.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use pcc_core::{Error, Result};
use serde::Serialize;

pub const UPSTREAM_REPO: &str = "https://github.com/a16z-infra/ai-town";

/// Never compared: generated, installed or NEXUS bookkeeping files.
const IGNORED: &[&str] = &["node_modules/", "nexus-upstream.json", ".env.local", ".nexus-install.json", "dist/"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PlanAction {
    /// Changed upstream only: take the upstream version.
    TakeUpstream,
    /// Added upstream.
    Add,
    /// Deleted upstream, untouched by NEXUS.
    Delete,
    /// Changed on both sides, merges without conflict.
    MergeClean,
    /// Changed on both sides with conflicts: manual resolution needed.
    Conflict,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub path: String,
    pub action: PlanAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflicts: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamReport {
    pub base: String,
    pub head: String,
    pub up_to_date: bool,
    /// Upstream commits since the base (subject lines, newest first).
    pub upstream_commits: Vec<String>,
    /// Files changed upstream since the base.
    pub upstream_changes: Vec<String>,
    /// Files NEXUS changed or added relative to the base.
    pub local_changes: Vec<String>,
    pub plan: Vec<PlanItem>,
    pub conflicts: usize,
    /// Whether `apply` can write to this copy (false for installed, read-only resources).
    pub writable: bool,
}

fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let out = pcc_claude::process::std_command("git").args(args).current_dir(dir).output()?;
    if !out.status.success() {
        return Err(Error::Invalid(format!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn git_bytes(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = pcc_claude::process::std_command("git").args(args).current_dir(dir).output().ok()?;
    out.status.success().then_some(out.stdout)
}

pub fn base_commit(source: &Path) -> Result<String> {
    let text = std::fs::read_to_string(source.join("nexus-upstream.json"))?;
    let v: serde_json::Value = serde_json::from_str(&text)?;
    v["commit"].as_str().map(str::to_string).ok_or_else(|| Error::Invalid("nexus-upstream.json has no commit".into()))
}

fn ignored(path: &str) -> bool {
    IGNORED.iter().any(|i| path == *i || path.starts_with(i))
}

fn list_files(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            if path.is_dir() {
                if !ignored(&format!("{rel}/")) {
                    stack.push(path);
                }
            } else if !ignored(&rel) {
                out.push(rel);
            }
        }
    }
    out.sort();
    out
}

/// Line endings differ between a Windows checkout and git objects.
fn normalized(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().copied().filter(|b| *b != b'\r').collect()
}

/// A fresh clone of upstream (blobs fetched on demand).
pub fn fetch_upstream(into: &Path) -> Result<()> {
    let parent = into.parent().unwrap_or(into);
    std::fs::create_dir_all(parent)?;
    let target = into.to_string_lossy().to_string();
    git(parent, &["clone", "--quiet", "--filter=blob:none", UPSTREAM_REPO, &target])?;
    Ok(())
}

/// Builds the report for `source` (a NEXUS ai-town folder) against the clone in `upstream`.
pub fn analyze(source: &Path, upstream: &Path) -> Result<UpstreamReport> {
    let base = base_commit(source)?;
    let head = git(upstream, &["rev-parse", "HEAD"])?.trim().to_string();
    let upstream_commits: Vec<String> =
        git(upstream, &["log", "--format=%h %s", &format!("{base}..{head}")])?.lines().map(str::to_string).collect();
    let mut upstream_status = BTreeMap::new();
    for line in git(upstream, &["diff", "--name-status", "--no-renames", &base, &head])?.lines() {
        let mut parts = line.split('\t');
        if let (Some(status), Some(path)) = (parts.next(), parts.next()) {
            if !ignored(path) {
                upstream_status.insert(path.to_string(), status.chars().next().unwrap_or('M'));
            }
        }
    }
    let base_files: Vec<String> = git(upstream, &["ls-tree", "-r", "--name-only", &base])?
        .lines()
        .filter(|p| !ignored(p))
        .map(str::to_string)
        .collect();
    let mut local_changes = Vec::new();
    for path in list_files(source) {
        let local = std::fs::read(source.join(&path)).unwrap_or_default();
        match git_bytes(upstream, &["show", &format!("{base}:{path}")]) {
            Some(original) if normalized(&original) == normalized(&local) => {}
            _ => local_changes.push(path),
        }
    }
    for path in &base_files {
        if !source.join(path).exists() {
            local_changes.push(path.clone());
        }
    }
    local_changes.sort();
    local_changes.dedup();

    let mut plan = Vec::new();
    let scratch = tempfile_dir()?;
    for (path, status) in &upstream_status {
        let changed_locally = local_changes.contains(path);
        let item = match (status, changed_locally) {
            ('A', false) => PlanItem { path: path.clone(), action: PlanAction::Add, conflicts: None },
            ('D', false) => PlanItem { path: path.clone(), action: PlanAction::Delete, conflicts: None },
            (_, false) => PlanItem { path: path.clone(), action: PlanAction::TakeUpstream, conflicts: None },
            ('D', true) => PlanItem { path: path.clone(), action: PlanAction::Conflict, conflicts: Some(1) },
            (_, true) => {
                let conflicts = merge(source, upstream, &base, &head, path, &scratch)?.1;
                PlanItem {
                    path: path.clone(),
                    action: if conflicts == 0 { PlanAction::MergeClean } else { PlanAction::Conflict },
                    conflicts: (conflicts > 0).then_some(conflicts),
                }
            }
        };
        plan.push(item);
    }
    let _ = std::fs::remove_dir_all(&scratch);
    let conflicts = plan.iter().filter(|p| p.action == PlanAction::Conflict).count();
    Ok(UpstreamReport {
        up_to_date: head.starts_with(&base) || base.starts_with(&head),
        base,
        head,
        upstream_commits,
        upstream_changes: upstream_status.keys().cloned().collect(),
        local_changes,
        plan,
        conflicts,
        writable: is_writable(source),
    })
}

fn tempfile_dir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("nexus-ai-town-merge-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(".nexus-write-probe");
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(probe);
    ok
}

/// 3-way merge of one file; returns (merged bytes, number of conflicts).
fn merge(
    source: &Path,
    upstream: &Path,
    base: &str,
    head: &str,
    path: &str,
    scratch: &Path,
) -> Result<(Vec<u8>, usize)> {
    let name = path.replace(['/', '\\'], "_");
    let ours = scratch.join(format!("{name}.ours"));
    let old = scratch.join(format!("{name}.base"));
    let theirs = scratch.join(format!("{name}.theirs"));
    std::fs::write(&ours, normalized(&std::fs::read(source.join(path)).unwrap_or_default()))?;
    std::fs::write(&old, normalized(&git_bytes(upstream, &["show", &format!("{base}:{path}")]).unwrap_or_default()))?;
    std::fs::write(
        &theirs,
        normalized(&git_bytes(upstream, &["show", &format!("{head}:{path}")]).unwrap_or_default()),
    )?;
    let out = pcc_claude::process::std_command("git")
        .args(["merge-file", "-p", "-L", "nexus", "-L", "base", "-L", "upstream"])
        .arg(&ours)
        .arg(&old)
        .arg(&theirs)
        .output()?;
    // Exit code = number of conflicts (negative on error).
    let code = out.status.code().unwrap_or(-1);
    if code < 0 {
        return Err(Error::Invalid(format!("git merge-file failed on {path}")));
    }
    Ok((out.stdout, code as usize))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub backup: String,
    pub applied: Vec<String>,
    /// Conflicting files: upstream version written next to them as `<file>.upstream`.
    pub left_for_review: Vec<String>,
    /// Base moved to the upstream head (only when nothing was left for review).
    pub new_base: Option<String>,
}

/// Applies the non-conflicting part of the plan after backing up `source`.
pub fn apply(source: &Path, upstream: &Path) -> Result<ApplyResult> {
    let report = analyze(source, upstream)?;
    if !report.writable {
        return Err(Error::Invalid(format!(
            "{} is read-only (installed copy); sync a source checkout instead",
            source.display()
        )));
    }
    let stamp = pcc_core::now().replace([':', '.'], "-");
    let backup = source.with_file_name(format!("ai-town-backup-{stamp}"));
    copy_tree(source, &backup)?;
    let scratch = tempfile_dir()?;
    let mut applied = Vec::new();
    let mut left = Vec::new();
    for item in &report.plan {
        let target = source.join(&item.path);
        match item.action {
            PlanAction::TakeUpstream | PlanAction::Add => {
                let bytes =
                    git_bytes(upstream, &["show", &format!("{}:{}", report.head, item.path)]).unwrap_or_default();
                if let Some(dir) = target.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                std::fs::write(&target, bytes)?;
                applied.push(item.path.clone());
            }
            PlanAction::Delete => {
                let _ = std::fs::remove_file(&target);
                applied.push(item.path.clone());
            }
            PlanAction::MergeClean => {
                let (bytes, _) = merge(source, upstream, &report.base, &report.head, &item.path, &scratch)?;
                std::fs::write(&target, bytes)?;
                applied.push(item.path.clone());
            }
            PlanAction::Conflict => {
                let bytes =
                    git_bytes(upstream, &["show", &format!("{}:{}", report.head, item.path)]).unwrap_or_default();
                std::fs::write(source.join(format!("{}.upstream", item.path)), bytes)?;
                left.push(item.path.clone());
            }
        }
    }
    let _ = std::fs::remove_dir_all(&scratch);
    let new_base = if left.is_empty() {
        let file = source.join("nexus-upstream.json");
        let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file)?)?;
        v["commit"] = serde_json::Value::String(report.head.clone());
        v["syncedAt"] = serde_json::Value::String(pcc_core::now());
        std::fs::write(&file, serde_json::to_string_pretty(&v)? + "\n")?;
        Some(report.head.clone())
    } else {
        None
    };
    Ok(ApplyResult { backup: backup.display().to_string(), applied, left_for_review: left, new_base })
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    for rel in list_files(from) {
        let dest = to.join(&rel);
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::copy(from.join(&rel), dest)?;
    }
    std::fs::copy(from.join("nexus-upstream.json"), to.join("nexus-upstream.json")).ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) {
        assert!(
            pcc_claude::process::std_command("git").args(args).current_dir(dir).status().unwrap().success(),
            "git {args:?}"
        );
    }

    /// A fake "upstream" repository with a base commit and a newer head.
    #[test]
    fn plans_merges_without_overwriting_local_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let up = tmp.path().join("upstream");
        std::fs::create_dir_all(&up).unwrap();
        run(&up, &["init", "-q"]);
        run(&up, &["config", "user.email", "t@example.com"]);
        run(&up, &["config", "user.name", "t"]);
        std::fs::write(up.join("a.ts"), "one\ntwo\nthree\nfour\nfive\n").unwrap();
        std::fs::write(up.join("b.ts"), "b\n").unwrap();
        std::fs::write(up.join("c.ts"), "c1\n").unwrap();
        run(&up, &["add", "."]);
        run(&up, &["commit", "-qm", "base"]);
        let base = git(&up, &["rev-parse", "HEAD"]).unwrap().trim().to_string();

        // NEXUS copy: edits the end of a.ts and c.ts, adds nexus.ts.
        let src = tmp.path().join("ai-town");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.ts"), "one\ntwo\nthree\nfour\nfive NEXUS\n").unwrap();
        std::fs::write(src.join("b.ts"), "b\n").unwrap();
        std::fs::write(src.join("c.ts"), "c-nexus\n").unwrap();
        std::fs::write(src.join("nexus.ts"), "nexus\n").unwrap();
        std::fs::write(src.join("nexus-upstream.json"), format!("{{\"commit\":\"{base}\"}}")).unwrap();

        // Upstream: edits the start of a.ts, b.ts and c.ts, adds d.ts.
        std::fs::write(up.join("a.ts"), "ONE\ntwo\nthree\nfour\nfive\n").unwrap();
        std::fs::write(up.join("b.ts"), "b2\n").unwrap();
        std::fs::write(up.join("c.ts"), "c-upstream\n").unwrap();
        std::fs::write(up.join("d.ts"), "d\n").unwrap();
        run(&up, &["add", "."]);
        run(&up, &["commit", "-qm", "upstream change"]);

        let report = analyze(&src, &up).unwrap();
        assert!(!report.up_to_date);
        assert_eq!(report.upstream_commits.len(), 1);
        assert!(report.local_changes.contains(&"nexus.ts".to_string()));
        let action = |p: &str| report.plan.iter().find(|i| i.path == p).map(|i| i.action.clone());
        assert_eq!(action("a.ts"), Some(PlanAction::MergeClean));
        assert_eq!(action("b.ts"), Some(PlanAction::TakeUpstream));
        assert_eq!(action("c.ts"), Some(PlanAction::Conflict));
        assert_eq!(action("d.ts"), Some(PlanAction::Add));
        assert_eq!(report.conflicts, 1);

        let result = apply(&src, &up).unwrap();
        assert_eq!(std::fs::read_to_string(src.join("a.ts")).unwrap(), "ONE\ntwo\nthree\nfour\nfive NEXUS\n");
        assert_eq!(std::fs::read_to_string(src.join("c.ts")).unwrap(), "c-nexus\n", "conflict kept as NEXUS wrote it");
        assert_eq!(std::fs::read_to_string(src.join("c.ts.upstream")).unwrap(), "c-upstream\n");
        assert_eq!(std::fs::read_to_string(src.join("nexus.ts")).unwrap(), "nexus\n");
        assert_eq!(result.left_for_review, vec!["c.ts".to_string()]);
        assert!(result.new_base.is_none(), "base only moves once conflicts are resolved");
        assert!(Path::new(&result.backup).join("c.ts").is_file());
    }
}
