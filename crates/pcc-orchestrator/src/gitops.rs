//! Git operations of the engine: agent branches, merges, snapshots.

use std::path::Path;

use serde_json::json;

use pcc_core::{AgentKind, AgentStatus, Error, Event, EventKind, Isolation, PermissionRequest, Result, Task};
use pcc_git::{MergeOutcome, Repo, Snapshot};

use crate::dto::{AgentBranch, GitOverview};
use crate::engine::{Engine, PendingKind};

impl Engine {
    pub(crate) fn repo(&self) -> Result<&Repo> {
        self.repo.as_ref().ok_or_else(|| Error::Git("the project is not a git repository".into()))
    }

    pub fn git_overview(&self) -> Result<Option<GitOverview>> {
        let Some(repo) = &self.repo else { return Ok(None) };
        let status = repo.status();
        let base = status.branch.clone().unwrap_or_else(|| "HEAD".into());
        let mut agents = Vec::new();
        for a in self.store.list_agents()? {
            let Some(branch) = a.branch.clone() else { continue };
            if a.kind == AgentKind::Central || !repo.branch_exists(&branch) {
                continue;
            }
            let wt = (a.isolation == Isolation::Worktree).then(|| Path::new(&a.workdir).to_path_buf());
            let (diff, error) = match repo.diff(&base, &branch, wt.as_deref()) {
                Ok(d) => (Some(d), None),
                Err(e) => (None, Some(e.to_string())),
            };
            agents.push(AgentBranch { agent_id: a.id, branch, workdir: a.workdir, diff, error });
        }
        let recent_commits = if status.has_commits { repo.log("HEAD", 20)? } else { vec![] };
        let snapshots = if status.has_commits { repo.snapshots()? } else { vec![] };
        Ok(Some(GitOverview { status, agents, recent_commits, snapshots }))
    }

    pub fn git_init(&mut self) -> Result<pcc_git::RepoStatus> {
        if self.repo.is_some() {
            return Err(Error::invalid("the project is already a git repository"));
        }
        let repo = Repo::init(self.store.root())?;
        let status = repo.status();
        self.repo = Some(repo);
        self.emit(Event::new(EventKind::GitChanged, "Git repository initialized", json!(status)));
        Ok(status)
    }

    /// Commits the agent's worktree (user action from the Git view).
    pub fn commit_agent_work(&mut self, agent: &str, message: &str) -> Result<Option<String>> {
        let a = self.store.agent(agent)?;
        if a.isolation != Isolation::Worktree {
            return Err(Error::invalid(format!("{agent} works in the shared folder; commit from your usual git tool")));
        }
        let c = self.repo()?.commit_all(Path::new(&a.workdir), message)?;
        self.emit(
            Event::new(
                EventKind::GitChanged,
                format!("Committed {agent}'s work{}", c.as_ref().map(|c| format!(" ({c})")).unwrap_or_default()),
                json!({"agent": agent, "commit": c}),
            )
            .agent(agent),
        );
        Ok(c)
    }

    /// Merges an agent branch into the current branch (snapshot first).
    pub fn merge_agent_branch(&mut self, agent: &str) -> Result<MergeOutcome> {
        let a = self.store.agent(agent)?;
        let branch = a.branch.clone().ok_or_else(|| Error::invalid(format!("{agent} has no branch")))?;
        let repo = self.repo()?;
        if a.isolation == Isolation::Worktree && a.status == AgentStatus::Working {
            return Err(Error::Conflict(format!("{agent} is working; wait until it is idle before merging")));
        }
        let wt = Path::new(&a.workdir);
        if a.isolation == Isolation::Worktree && wt.exists() && !repo.dirty_files(wt)?.is_empty() {
            return Err(Error::Conflict(format!("{agent}'s worktree has uncommitted changes; commit them first")));
        }
        let outcome = repo.merge_branch(&branch, &format!("Merge {branch} ({})", a.name))?;
        self.emit(Event::new(EventKind::GitChanged, outcome.message.clone(), json!(outcome)).agent(agent));
        Ok(outcome)
    }

    /// Central asks to merge: the user decides through a permission prompt.
    pub(crate) fn request_merge(&mut self, requester: &str, agent: &str) -> Result<String> {
        let a = self.store.agent(agent)?;
        let branch = a.branch.clone().ok_or_else(|| Error::invalid(format!("{agent} has no branch to merge")))?;
        let repo = self.repo()?;
        let base = repo.current_branch().unwrap_or_else(|| "HEAD".into());
        let diff = repo.diff(&base, &branch, Some(Path::new(&a.workdir)))?;
        if diff.commits_ahead == 0 {
            return Ok(format!("{branch} has no commits ahead of {base}; nothing to merge."));
        }
        if !diff.conflicts.is_empty() {
            return Ok(format!(
                "{branch} would conflict with {base} on: {}. Ask {agent} to merge {base} into its branch and resolve the conflicts first (git merge {base}).",
                diff.conflicts.join(", ")
            ));
        }
        let req = PermissionRequest {
            id: format!("perm-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
            agent_id: requester.into(),
            tool_name: "merge_agent_work".into(),
            capability: "git_write".into(),
            summary: format!(
                "Merge {branch} into {base}: {} commit(s), {} file(s)",
                diff.commits_ahead,
                diff.files.len()
            ),
            input: json!({"agent": agent, "branch": branch, "base": base, "files": diff.files}),
            reason: "merging into the main working tree changes the project for everyone (a snapshot is taken first)"
                .into(),
            rule_key: format!("merge:{agent}"),
            created_at: pcc_core::now(),
        };
        self.ask_user(req, PendingKind::Merge { agent: agent.into() })?;
        Ok(format!(
            "Merge of {branch} into {base} submitted to the user for approval. You will be notified of the outcome."
        ))
    }

    /// Before a worktree agent starts a task, merge the branches of the agents
    /// that completed its dependencies so it builds on their work.
    pub(crate) fn sync_dependency_branches(&mut self, agent: &str, deps: &[Task]) -> Option<String> {
        let repo = self.repo.as_ref()?;
        let a = self.store.agent(agent).ok()?;
        if a.isolation != Isolation::Worktree {
            return None;
        }
        let mut merged = Vec::new();
        let mut problems = Vec::new();
        for d in deps {
            let Some(owner) = d.agent.as_deref().filter(|o| *o != agent) else { continue };
            if d.result.as_ref().and_then(|r| r.commit.as_ref()).is_none() {
                continue;
            }
            let Some(branch) = self.store.agent(owner).ok().and_then(|o| o.branch) else { continue };
            if merged.contains(&branch) {
                continue;
            }
            let wt = Path::new(&a.workdir);
            match repo.git_at(wt, &["merge", "--no-edit", &branch]) {
                Ok(_) => merged.push(branch),
                Err(e) => {
                    let _ = repo.git_at(wt, &["merge", "--abort"]);
                    problems.push(format!("{branch}: {e}"));
                }
            }
        }
        let mut note = String::new();
        if !merged.is_empty() {
            note.push_str(&format!("Your worktree now includes the work from: {}.", merged.join(", ")));
        }
        if !problems.is_empty() {
            note.push_str(&format!(
                " Could not merge automatically (conflicts): {}. Merge them yourself with `git merge <branch>` if you need that work.",
                problems.join("; ")
            ));
        }
        (!note.is_empty()).then_some(note)
    }

    pub fn create_snapshot(&mut self, label: &str) -> Result<Snapshot> {
        let s = self.repo()?.snapshot(label)?;
        self.emit(Event::new(EventKind::GitChanged, format!("Snapshot {} created", s.branch), json!(s)));
        Ok(s)
    }

    pub fn restore_snapshot(&mut self, branch: &str) -> Result<Snapshot> {
        let undo = self.repo()?.restore_snapshot(branch)?;
        self.emit(Event::new(
            EventKind::GitChanged,
            format!("Restored {branch} (undo point {})", undo.branch),
            json!({"restored": branch, "undo": undo}),
        ));
        Ok(undo)
    }
}
