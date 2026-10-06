//! Mission files and checkpoints:
//!
//! ```text
//! .agent-project/missions/<id>/mission.json                 latest state
//! .agent-project/missions/<id>/checkpoints/checkpoint-NNN.json
//! .agent-project/missions/<id>/checkpoints/current.json     copy of the latest checkpoint
//! ```
//!
//! A checkpoint records where the mission stood (tasks, agents, their last
//! action) and the fingerprint of every uncommitted file, so that after an
//! interruption NEXUS can say exactly which files were written since.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use pcc_core::Result;

/// A file with uncommitted changes, with enough to tell a later write.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    /// Path relative to `location`'s root, with forward slashes.
    pub path: String,
    /// `main` (the project folder) or the agent id owning a worktree.
    pub location: String,
    /// Git porcelain code (` M`, `??`, ...) or `modified`.
    pub status: String,
    pub size: Option<u64>,
    pub modified_ms: Option<u64>,
}

impl FileState {
    pub fn label(&self) -> String {
        if self.location == "main" {
            self.path.clone()
        } else {
            format!("{} ({})", self.path, self.location)
        }
    }
}

/// Fingerprints `rel` under `root`.
pub fn file_state(root: &Path, rel: &str, location: &str, status: &str) -> FileState {
    let meta = std::fs::metadata(root.join(rel)).ok();
    FileState {
        path: rel.replace('\\', "/"),
        location: location.to_string(),
        status: status.to_string(),
        size: meta.as_ref().map(|m| m.len()),
        modified_ms: meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64),
    }
}

/// Files that are new or different in `now` compared with a checkpoint.
pub fn written_since(checkpoint: &[FileState], now: &[FileState]) -> Vec<FileState> {
    let before: BTreeMap<(&str, &str), &FileState> =
        checkpoint.iter().map(|f| ((f.location.as_str(), f.path.as_str()), f)).collect();
    now.iter()
        .filter(|f| match before.get(&(f.location.as_str(), f.path.as_str())) {
            None => true,
            Some(b) => b.size != f.size || b.modified_ms != f.modified_ms || b.status != f.status,
        })
        .cloned()
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LastAction {
    pub agent_id: String,
    pub tool: String,
    /// Human description (`Reading Workspace.X.Script`, `Running npm test`).
    pub description: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentState {
    pub agent_id: String,
    pub name: String,
    pub status: String,
    pub current_task: Option<String>,
    pub current_action: Option<String>,
    pub claude_session_id: Option<String>,
    pub workdir: Option<String>,
    pub last_action: Option<LastAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskState {
    pub id: String,
    pub title: String,
    pub status: String,
    pub agent: Option<String>,
    pub dependencies: Vec<String>,
    pub progress: Option<u8>,
}

/// `mission.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MissionRecord {
    pub id: String,
    pub title: String,
    pub status: String,
    /// What the mission was doing (task in progress, planning...).
    pub current_step: String,
    pub agents: Vec<String>,
    pub tasks: Vec<TaskState>,
    /// Task id → ids it depends on.
    pub dependencies: BTreeMap<String, Vec<String>>,
    /// File name of the latest checkpoint.
    pub last_checkpoint: Option<String>,
    pub last_checkpoint_at: Option<String>,
    pub last_known_agent_states: Vec<AgentState>,
    /// Uncommitted files (project folder and agent worktrees).
    pub files_changed: Vec<FileState>,
    /// Most recent tool call of any agent of the mission.
    pub last_action: Option<LastAction>,
    pub git_head: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub seq: u32,
    pub name: String,
    pub at: String,
    /// What triggered it (`task TASK-0003 in_progress → completed`, `before merge`, `periodic`).
    pub reason: String,
    pub mission: MissionRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSummary {
    pub seq: u32,
    pub name: String,
    pub at: String,
    pub reason: String,
    pub status: String,
    pub current_step: String,
    pub files: usize,
}

/// Checkpoints kept per mission (oldest removed first).
const KEEP: usize = 200;

/// Reader/writer of `.agent-project/missions`.
#[derive(Debug, Clone)]
pub struct MissionFiles {
    dir: PathBuf,
}

impl MissionFiles {
    /// `agent_dir` is the project's `.agent-project` directory.
    pub fn new(agent_dir: &Path) -> Self {
        MissionFiles { dir: agent_dir.join("missions") }
    }

    fn mission_dir(&self, id: &str) -> PathBuf {
        // Mission ids are generated (`M-0001`); anything else is neutralised.
        let safe: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
        self.dir.join(safe)
    }

    fn checkpoints_dir(&self, id: &str) -> PathBuf {
        self.mission_dir(id).join("checkpoints")
    }

    pub fn mission(&self, id: &str) -> Option<MissionRecord> {
        read_json(&self.mission_dir(id).join("mission.json"))
    }

    pub fn current(&self, id: &str) -> Option<Checkpoint> {
        read_json(&self.checkpoints_dir(id).join("current.json"))
    }

    pub fn checkpoint(&self, id: &str, seq: u32) -> Option<Checkpoint> {
        read_json(&self.checkpoints_dir(id).join(checkpoint_name(seq)))
    }

    fn seqs(&self, id: &str) -> Vec<u32> {
        let mut v: Vec<u32> = std::fs::read_dir(self.checkpoints_dir(id))
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| {
                        let n = e.file_name().to_string_lossy().into_owned();
                        n.strip_prefix("checkpoint-")?.strip_suffix(".json")?.parse().ok()
                    })
                    .collect()
            })
            .unwrap_or_default();
        v.sort_unstable();
        v
    }

    /// Newest first.
    pub fn list(&self, id: &str) -> Vec<CheckpointSummary> {
        self.seqs(id)
            .into_iter()
            .rev()
            .filter_map(|s| self.checkpoint(id, s))
            .map(|c| CheckpointSummary {
                seq: c.seq,
                name: c.name,
                at: c.at,
                reason: c.reason,
                status: c.mission.status,
                current_step: c.mission.current_step,
                files: c.mission.files_changed.len(),
            })
            .collect()
    }

    /// Writes a checkpoint unless nothing changed since the previous one
    /// (`force` writes anyway). Returns the checkpoint written.
    pub fn write(&self, mut record: MissionRecord, reason: &str, force: bool) -> Result<Option<Checkpoint>> {
        let previous = self.current(&record.id);
        if !force {
            if let Some(p) = &previous {
                if same_state(&p.mission, &record) {
                    return Ok(None);
                }
            }
        }
        let seq = self.seqs(&record.id).last().copied().unwrap_or(0) + 1;
        let name = checkpoint_name(seq);
        let at = pcc_core::now();
        record.last_checkpoint = Some(name.clone());
        record.last_checkpoint_at = Some(at.clone());
        record.updated_at = at.clone();
        let cp = Checkpoint { seq, name: name.clone(), at, reason: reason.to_string(), mission: record.clone() };
        let dir = self.checkpoints_dir(&record.id);
        let bytes = serde_json::to_vec_pretty(&cp)?;
        crate::write_atomic(&dir.join(&name), &bytes)?;
        crate::write_atomic(&dir.join("current.json"), &bytes)?;
        crate::write_atomic(&self.mission_dir(&record.id).join("mission.json"), &serde_json::to_vec_pretty(&record)?)?;
        let seqs = self.seqs(&record.id);
        for old in seqs.iter().take(seqs.len().saturating_sub(KEEP)) {
            let _ = std::fs::remove_file(dir.join(checkpoint_name(*old)));
        }
        Ok(Some(cp))
    }
}

fn checkpoint_name(seq: u32) -> String {
    format!("checkpoint-{seq:03}.json")
}

/// Same mission state, ignoring bookkeeping timestamps.
fn same_state(a: &MissionRecord, b: &MissionRecord) -> bool {
    let strip = |m: &MissionRecord| {
        let mut m = m.clone();
        m.updated_at.clear();
        m.last_checkpoint = None;
        m.last_checkpoint_at = None;
        m
    };
    strip(a) == strip(b)
}

fn read_json<T: serde::de::DeserializeOwned>(p: &Path) -> Option<T> {
    let text = std::fs::read_to_string(p).ok()?;
    match serde_json::from_str(&text) {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("unreadable {}: {e}", p.display());
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(status: &str) -> MissionRecord {
        MissionRecord {
            id: "M-0001".into(),
            title: "Build".into(),
            status: status.into(),
            current_step: "TASK-0001 Build it".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            ..Default::default()
        }
    }

    #[test]
    fn writes_numbered_checkpoints_current_and_mission() {
        let tmp = tempfile::tempdir().unwrap();
        let mf = MissionFiles::new(tmp.path());
        let a = mf.write(record("active"), "mission started", false).unwrap().unwrap();
        assert_eq!(a.name, "checkpoint-001.json");
        // Unchanged state: no new checkpoint unless forced.
        assert!(mf.write(record("active"), "periodic", false).unwrap().is_none());
        let b = mf.write(record("active"), "before merge", true).unwrap().unwrap();
        assert_eq!(b.seq, 2);
        let c = mf.write(record("completed"), "task completed", false).unwrap().unwrap();
        assert_eq!(c.seq, 3);

        let dir = tmp.path().join("missions/M-0001");
        assert!(dir.join("checkpoints/checkpoint-001.json").is_file());
        assert!(dir.join("checkpoints/checkpoint-003.json").is_file());
        assert_eq!(mf.current("M-0001").unwrap().seq, 3);
        let m = mf.mission("M-0001").unwrap();
        assert_eq!(m.status, "completed");
        assert_eq!(m.last_checkpoint.as_deref(), Some("checkpoint-003.json"));
        let list = mf.list("M-0001");
        assert_eq!(list.iter().map(|c| c.seq).collect::<Vec<_>>(), vec![3, 2, 1]);
        assert_eq!(list[1].reason, "before merge");
    }

    #[test]
    fn detects_files_written_after_a_checkpoint() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "1").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "1").unwrap();
        let before = vec![file_state(tmp.path(), "a.txt", "main", " M"), file_state(tmp.path(), "b.txt", "main", " M")];
        assert!(written_since(&before, &before).is_empty());
        std::fs::write(tmp.path().join("b.txt"), "longer").unwrap();
        std::fs::write(tmp.path().join("c.txt"), "new").unwrap();
        let now = vec![
            file_state(tmp.path(), "a.txt", "main", " M"),
            file_state(tmp.path(), "b.txt", "main", " M"),
            file_state(tmp.path(), "c.txt", "main", "??"),
        ];
        let w: Vec<String> = written_since(&before, &now).iter().map(|f| f.path.clone()).collect();
        assert_eq!(w, vec!["b.txt", "c.txt"]);
        // Same path in a worktree is a different file.
        let wt = vec![file_state(tmp.path(), "a.txt", "builder", " M")];
        assert_eq!(written_since(&before, &wt)[0].label(), "a.txt (builder)");
    }
}
