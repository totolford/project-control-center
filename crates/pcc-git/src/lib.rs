//! Git integration through the `git` command line.
//!
//! Using the CLI (rather than libgit2) keeps behaviour identical to what the
//! user and the agents see, including hooks, credentials and config.
//! Every operation that can lose work is either refused or non-destructive:
//! merges refuse to run on a dirty tree, restores use `reset --keep`, and
//! snapshots are plain branches.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use pcc_core::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub has_commits: bool,
    pub dirty_files: Vec<String>,
    pub remote_url: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BranchDiff {
    pub base: String,
    pub branch: String,
    pub commits_ahead: u32,
    pub commits_behind: u32,
    pub files: Vec<FileChange>,
    /// Uncommitted changes in the agent worktree.
    pub uncommitted: Vec<String>,
    /// Files that would conflict when merging `branch` into `base`.
    pub conflicts: Vec<String>,
    pub mergeable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub branch: String,
    pub commit: String,
    pub created_at: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub merged: bool,
    pub commit: Option<String>,
    pub conflicts: Vec<String>,
    pub snapshot: Option<Snapshot>,
    pub message: String,
}

/// A repository rooted at `root` (the main working tree).
#[derive(Debug, Clone)]
pub struct Repo {
    pub root: PathBuf,
}

pub fn git_available() -> bool {
    run_in(Path::new("."), &["--version"]).is_ok()
}

fn run_in(dir: &Path, args: &[&str]) -> Result<String> {
    let out = git_command(dir).args(args).output().map_err(|e| Error::Git(format!("cannot run git: {e}")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        Err(Error::Git(format!("git {}: {err}", args.join(" "))))
    }
}

fn git_command(dir: &Path) -> Command {
    let mut c = Command::new("git");
    c.current_dir(dir).env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C").stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

impl Repo {
    /// Returns the repository if `dir` is the top level of a git working tree.
    pub fn discover(dir: &Path) -> Option<Repo> {
        let top = run_in(dir, &["rev-parse", "--show-toplevel"]).ok()?;
        let top = PathBuf::from(top.trim());
        let same = |a: &Path, b: &Path| {
            let n = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_ascii_lowercase();
            n(a) == n(b)
        };
        if same(&top, dir) || dir.canonicalize().ok().zip(top.canonicalize().ok()).is_some_and(|(a, b)| a == b) {
            Some(Repo { root: dir.to_path_buf() })
        } else {
            // The project is a sub-folder of a bigger repository: still usable,
            // but worktrees would contain the whole parent repo, so we don't.
            None
        }
    }

    pub fn init(dir: &Path) -> Result<Repo> {
        run_in(dir, &["init", "-b", "main"])?;
        Ok(Repo { root: dir.to_path_buf() })
    }

    pub fn git(&self, args: &[&str]) -> Result<String> {
        run_in(&self.root, args)
    }

    pub fn git_at(&self, dir: &Path, args: &[&str]) -> Result<String> {
        run_in(dir, args)
    }

    pub fn has_commits(&self) -> bool {
        self.git(&["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
    }

    pub fn current_branch(&self) -> Option<String> {
        self.git(&["symbolic-ref", "--short", "-q", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    pub fn status(&self) -> RepoStatus {
        let has_commits = self.has_commits();
        let head = has_commits
            .then(|| self.git(&["rev-parse", "--short", "HEAD"]).ok())
            .flatten()
            .map(|s| s.trim().to_string());
        let dirty_files = self.dirty_files(&self.root).unwrap_or_default();
        let remote_url = self.git(&["remote", "get-url", "origin"]).ok().map(|s| s.trim().to_string());
        let (mut ahead, mut behind) = (None, None);
        if let Ok(s) = self.git(&["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]) {
            let mut it = s.split_whitespace().filter_map(|n| n.parse().ok());
            behind = it.next();
            ahead = it.next();
        }
        RepoStatus {
            is_repo: true,
            branch: self.current_branch(),
            head,
            has_commits,
            dirty_files,
            remote_url,
            ahead,
            behind,
        }
    }

    /// Paths with uncommitted changes (porcelain v1), ignoring `.agent-project` runtime files.
    pub fn dirty_files(&self, dir: &Path) -> Result<Vec<String>> {
        let out = run_in(dir, &["status", "--porcelain", "--untracked-files=all"])?;
        Ok(out
            .lines()
            .filter(|l| l.len() > 3)
            .map(|l| l[3..].trim_matches('"').to_string())
            .filter(|p| !p.starts_with(".agent-project/"))
            .collect())
    }

    pub fn branches(&self) -> Result<Vec<String>> {
        Ok(self
            .git(&["for-each-ref", "--format=%(refname:short)", "refs/heads"])?
            .lines()
            .map(str::to_string)
            .collect())
    }

    pub fn branch_exists(&self, name: &str) -> bool {
        self.git(&["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")]).is_ok()
    }

    pub fn log(&self, rev: &str, limit: u32) -> Result<Vec<Commit>> {
        let out = self.git(&["log", rev, &format!("-n{limit}"), "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s"])?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let p: Vec<&str> = l.split('\u{1f}').collect();
                (p.len() == 5).then(|| Commit {
                    hash: p[0].into(),
                    short: p[1].into(),
                    author: p[2].into(),
                    date: p[3].into(),
                    subject: p[4].into(),
                })
            })
            .collect())
    }

    // ------------------------------------------------------------ worktrees

    pub fn worktrees(&self) -> Result<Vec<Worktree>> {
        let out = self.git(&["worktree", "list", "--porcelain"])?;
        let mut v = Vec::new();
        let mut cur: Option<Worktree> = None;
        for line in out.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                if let Some(w) = cur.take() {
                    v.push(w);
                }
                cur = Some(Worktree { path: p.into(), branch: None, head: String::new() });
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                if let Some(w) = cur.as_mut() {
                    w.head = h.into();
                }
            } else if let Some(b) = line.strip_prefix("branch ") {
                if let Some(w) = cur.as_mut() {
                    w.branch = Some(b.trim_start_matches("refs/heads/").into());
                }
            }
        }
        v.extend(cur);
        Ok(v)
    }

    /// Creates (or reuses) a worktree at `path` on `branch`, branching from `base`.
    pub fn ensure_worktree(&self, path: &Path, branch: &str, base: &str) -> Result<()> {
        if !self.has_commits() {
            return Err(Error::Git("the repository has no commit yet; worktrees need at least one commit".into()));
        }
        let p = path.to_string_lossy().replace('\\', "/");
        let existing = self.worktrees()?;
        if existing.iter().any(|w| same_path(&w.path, &p)) {
            return Ok(());
        }
        // A stale registration (folder deleted by hand) blocks re-creation.
        let _ = self.git(&["worktree", "prune"]);
        if self.branch_exists(branch) {
            self.git(&["worktree", "add", &p, branch])?;
        } else {
            self.git(&["worktree", "add", "-b", branch, &p, base])?;
        }
        Ok(())
    }

    /// Removes the worktree folder; refuses when it has uncommitted changes.
    pub fn remove_worktree(&self, path: &Path) -> Result<()> {
        let p = path.to_string_lossy().replace('\\', "/");
        if path.exists() && !self.dirty_files(path)?.is_empty() {
            return Err(Error::Conflict(format!("worktree {p} has uncommitted changes; commit or discard them first")));
        }
        self.git(&["worktree", "remove", &p])?;
        Ok(())
    }

    /// Stages and commits everything in `dir`. Returns the new commit, or `None` if clean.
    pub fn commit_all(&self, dir: &Path, message: &str) -> Result<Option<String>> {
        if self.dirty_files(dir)?.is_empty() {
            return Ok(None);
        }
        run_in(dir, &["add", "-A", "--", ".", ":(exclude).agent-project"])?;
        // Nothing staged (e.g. only excluded files changed).
        if run_in(dir, &["diff", "--cached", "--quiet"]).is_ok() {
            return Ok(None);
        }
        let mut cmd = git_command(dir);
        let out = cmd
            .args(["-c", "user.useConfigOnly=false", "commit", "-m", message])
            .env("GIT_AUTHOR_NAME", env_or("GIT_AUTHOR_NAME", "Project Control Center"))
            .env("GIT_AUTHOR_EMAIL", env_or("GIT_AUTHOR_EMAIL", "agents@project-control-center.local"))
            .env("GIT_COMMITTER_NAME", env_or("GIT_COMMITTER_NAME", "Project Control Center"))
            .env("GIT_COMMITTER_EMAIL", env_or("GIT_COMMITTER_EMAIL", "agents@project-control-center.local"))
            .output()
            .map_err(|e| Error::Git(e.to_string()))?;
        if !out.status.success() {
            return Err(Error::Git(String::from_utf8_lossy(&out.stderr).trim().to_string()));
        }
        Ok(Some(run_in(dir, &["rev-parse", "--short", "HEAD"])?.trim().to_string()))
    }

    // ------------------------------------------------------------ diff / merge

    pub fn diff(&self, base: &str, branch: &str, worktree: Option<&Path>) -> Result<BranchDiff> {
        let counts = self.git(&["rev-list", "--left-right", "--count", &format!("{base}...{branch}")])?;
        let mut it = counts.split_whitespace().filter_map(|n| n.parse::<u32>().ok());
        let behind = it.next().unwrap_or(0);
        let ahead = it.next().unwrap_or(0);
        let range = format!("{base}...{branch}");
        let mut files: Vec<FileChange> = self
            .git(&["diff", "--name-status", &range])?
            .lines()
            .filter_map(|l| {
                let mut p = l.split('\t');
                let st = p.next()?.to_string();
                let path = p.next_back()?.to_string();
                Some(FileChange { path, status: st, additions: None, deletions: None })
            })
            .collect();
        for l in self.git(&["diff", "--numstat", &range])?.lines() {
            let p: Vec<&str> = l.split('\t').collect();
            if p.len() >= 3 {
                if let Some(f) = files.iter_mut().find(|f| f.path == p[p.len() - 1]) {
                    f.additions = p[0].parse().ok();
                    f.deletions = p[1].parse().ok();
                }
            }
        }
        let uncommitted = match worktree {
            Some(w) if w.exists() => self.dirty_files(w)?,
            _ => vec![],
        };
        let conflicts = self.merge_conflicts(base, branch)?;
        Ok(BranchDiff {
            base: base.into(),
            branch: branch.into(),
            commits_ahead: ahead,
            commits_behind: behind,
            mergeable: conflicts.is_empty(),
            files,
            uncommitted,
            conflicts,
        })
    }

    /// Computes merge conflicts without touching any working tree (`git merge-tree`, git >= 2.38).
    pub fn merge_conflicts(&self, base: &str, branch: &str) -> Result<Vec<String>> {
        let out = git_command(&self.root)
            .args(["merge-tree", "--write-tree", "--name-only", "--no-messages", base, branch])
            .output()
            .map_err(|e| Error::Git(e.to_string()))?;
        match out.status.code() {
            Some(0) => Ok(vec![]),
            Some(1) => {
                // First line is the tree id, then conflicted file names.
                Ok(String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .skip(1)
                    .filter(|l| !l.trim().is_empty())
                    .map(str::to_string)
                    .collect())
            }
            _ => Err(Error::Git(String::from_utf8_lossy(&out.stderr).trim().to_string())),
        }
    }

    /// Merges `branch` into the currently checked-out branch of the main working tree.
    /// Takes a snapshot first; refuses on a dirty tree or predicted conflicts.
    pub fn merge_branch(&self, branch: &str, message: &str) -> Result<MergeOutcome> {
        let dirty = self.dirty_files(&self.root)?;
        if !dirty.is_empty() {
            return Err(Error::Conflict(format!(
                "the project folder has {} uncommitted change(s); commit or stash them before merging",
                dirty.len()
            )));
        }
        let target =
            self.current_branch().ok_or_else(|| Error::Git("HEAD is detached; check out a branch first".into()))?;
        let conflicts = self.merge_conflicts(&target, branch)?;
        if !conflicts.is_empty() {
            return Ok(MergeOutcome {
                merged: false,
                commit: None,
                snapshot: None,
                message: format!("{} file(s) would conflict; resolve on {branch} first", conflicts.len()),
                conflicts,
            });
        }
        let snapshot = self.snapshot(&format!("before merging {branch}"))?;
        self.git(&["merge", "--no-ff", "--no-edit", "-m", message, branch])?;
        let commit = self.git(&["rev-parse", "--short", "HEAD"])?.trim().to_string();
        Ok(MergeOutcome {
            merged: true,
            commit: Some(commit),
            conflicts: vec![],
            snapshot: Some(snapshot),
            message: format!("{branch} merged into {target}"),
        })
    }

    // ------------------------------------------------------------ snapshots

    /// Records the current HEAD on a `pcc/snapshots/<timestamp>` branch.
    pub fn snapshot(&self, label: &str) -> Result<Snapshot> {
        let commit = self.git(&["rev-parse", "HEAD"])?.trim().to_string();
        let ts = chrono_like_stamp();
        let mut branch = format!("pcc/snapshots/{ts}");
        let mut n = 1;
        while self.branch_exists(&branch) {
            n += 1;
            branch = format!("pcc/snapshots/{ts}-{n}");
        }
        self.git(&["branch", &branch, &commit])?;
        Ok(Snapshot { branch, commit, created_at: pcc_core::now(), label: label.into() })
    }

    pub fn snapshots(&self) -> Result<Vec<Snapshot>> {
        let out = self.git(&[
            "for-each-ref",
            "--sort=-creatordate",
            "--format=%(refname:short)%1f%(objectname)%1f%(creatordate:iso-strict)",
            "refs/heads/pcc/snapshots",
        ])?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let p: Vec<&str> = l.split('\u{1f}').collect();
                (p.len() == 3).then(|| Snapshot {
                    branch: p[0].into(),
                    commit: p[1].into(),
                    created_at: p[2].into(),
                    label: String::new(),
                })
            })
            .collect())
    }

    /// Moves the current branch back to a snapshot with `reset --keep`, which
    /// aborts instead of overwriting uncommitted changes. A new snapshot of the
    /// current state is taken first so the restore itself can be undone.
    pub fn restore_snapshot(&self, snapshot_branch: &str) -> Result<Snapshot> {
        if !snapshot_branch.starts_with("pcc/snapshots/") || !self.branch_exists(snapshot_branch) {
            return Err(Error::not_found(format!("snapshot {snapshot_branch}")));
        }
        let undo = self.snapshot(&format!("before restoring {snapshot_branch}"))?;
        self.git(&["reset", "--keep", snapshot_branch])?;
        Ok(undo)
    }
}

fn same_path(a: &str, b: &str) -> bool {
    let n = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase();
    n(a) == n(b)
}

fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

fn chrono_like_stamp() -> String {
    // `2026-09-29T13:10:01.436Z` -> `20260929-131001`
    let n = pcc_core::now();
    let digits: String = n.chars().filter(|c| c.is_ascii_digit()).collect();
    format!("{}-{}", &digits[..8], &digits[8..14])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo() -> (tempfile::TempDir, Repo) {
        let tmp = tempfile::tempdir().unwrap();
        let r = Repo::init(tmp.path()).unwrap();
        r.git(&["config", "user.email", "t@t"]).unwrap();
        r.git(&["config", "user.name", "t"]).unwrap();
        fs::write(tmp.path().join("a.txt"), "one\n").unwrap();
        r.git(&["add", "."]).unwrap();
        r.git(&["commit", "-m", "init"]).unwrap();
        (tmp, r)
    }

    #[test]
    fn discover_and_status() {
        let (tmp, r) = repo();
        assert!(Repo::discover(tmp.path()).is_some());
        let st = r.status();
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert!(st.has_commits);
        fs::write(tmp.path().join("b.txt"), "x").unwrap();
        assert_eq!(r.status().dirty_files, vec!["b.txt"]);
        let sub = tmp.path().join("sub");
        fs::create_dir(&sub).unwrap();
        assert!(Repo::discover(&sub).is_none());
        assert!(Repo::discover(tempfile::tempdir().unwrap().path()).is_none());
    }

    #[test]
    fn worktree_commit_diff_merge_snapshot() {
        let (tmp, r) = repo();
        let wt = tmp.path().join(".agent-project/worktrees/movement");
        r.ensure_worktree(&wt, "agent/movement", "main").unwrap();
        // Idempotent.
        r.ensure_worktree(&wt, "agent/movement", "main").unwrap();
        fs::write(wt.join("a.txt"), "one\ntwo\n").unwrap();
        fs::write(wt.join("new.txt"), "n\n").unwrap();
        let c = r.commit_all(&wt, "TASK-0001: change").unwrap();
        assert!(c.is_some());
        assert_eq!(r.commit_all(&wt, "nothing").unwrap(), None);

        let d = r.diff("main", "agent/movement", Some(&wt)).unwrap();
        assert_eq!(d.commits_ahead, 1);
        assert_eq!(d.files.len(), 2);
        assert!(d.mergeable);

        // Conflicting change on main.
        fs::write(tmp.path().join("a.txt"), "uno\n").unwrap();
        r.git(&["commit", "-am", "main change"]).unwrap();
        let conflicts = r.merge_conflicts("main", "agent/movement").unwrap();
        assert_eq!(conflicts, vec!["a.txt"]);
        let out = r.merge_branch("agent/movement", "merge").unwrap();
        assert!(!out.merged);

        // Resolve on the agent branch by taking main's content, then merge.
        r.git_at(&wt, &["merge", "main", "-X", "theirs", "-m", "sync"]).unwrap();
        let out = r.merge_branch("agent/movement", "Merge agent/movement").unwrap();
        assert!(out.merged, "{}", out.message);
        assert!(tmp.path().join("new.txt").exists());
        let snap = out.snapshot.unwrap();
        assert!(r.snapshots().unwrap().iter().any(|s| s.branch == snap.branch));

        // Restore to before the merge.
        r.restore_snapshot(&snap.branch).unwrap();
        assert!(!tmp.path().join("new.txt").exists());

        r.remove_worktree(&wt).unwrap();
        assert!(!wt.exists());
    }

    #[test]
    fn merge_refuses_dirty_tree() {
        let (tmp, r) = repo();
        r.git(&["branch", "feature"]).unwrap();
        fs::write(tmp.path().join("a.txt"), "dirty").unwrap();
        assert!(matches!(r.merge_branch("feature", "m"), Err(Error::Conflict(_))));
    }
}
