//! Crash reports: after any recovery, what happened, the possible cause, the
//! affected component, what was preserved, restarted and lost. Shown once
//! ("NEXUS recovered from an unexpected failure") and kept in history.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use pcc_core::Result;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    #[default]
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CrashReport {
    pub id: String,
    pub at: String,
    pub title: String,
    /// `nexus`, `claude-session`, `mcp`, `ai-town`, `local-ai`, `orphans`...
    pub component: String,
    pub severity: Severity,
    pub what_happened: String,
    pub possible_cause: String,
    pub preserved: Vec<String>,
    pub restarted: Vec<String>,
    pub lost: Vec<String>,
    /// Facts gathered by the diagnosis (exit code, stderr tail, PIDs...).
    pub details: Vec<String>,
    pub agent_id: Option<String>,
    pub mission_id: Option<String>,
    /// Project folder for project reports, `None` for application reports.
    pub project: Option<String>,
    /// The user has seen it.
    pub acknowledged: bool,
}

impl CrashReport {
    pub fn new(component: &str, title: impl Into<String>) -> Self {
        let now = chrono::Utc::now();
        CrashReport {
            id: format!("CR-{}-{}", now.format("%Y%m%d-%H%M%S"), &uuid::Uuid::new_v4().simple().to_string()[..6]),
            at: pcc_core::now(),
            title: title.into(),
            component: component.into(),
            ..Default::default()
        }
    }
}

/// Reports kept per store.
const KEEP: usize = 200;

/// A directory of `<id>.json` reports.
#[derive(Debug, Clone)]
pub struct ReportStore {
    dir: PathBuf,
}

impl ReportStore {
    pub fn new(dir: PathBuf) -> Self {
        ReportStore { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn add(&self, r: &CrashReport) -> Result<()> {
        crate::write_atomic(&self.dir.join(format!("{}.json", r.id)), &serde_json::to_vec_pretty(r)?)?;
        let all = self.list();
        for old in all.iter().skip(KEEP) {
            let _ = std::fs::remove_file(self.dir.join(format!("{}.json", old.id)));
        }
        Ok(())
    }

    /// Newest first.
    pub fn list(&self) -> Vec<CrashReport> {
        let mut v: Vec<CrashReport> = std::fs::read_dir(&self.dir)
            .map(|rd| {
                rd.flatten()
                    .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
                    .filter_map(|e| std::fs::read_to_string(e.path()).ok())
                    .filter_map(|t| serde_json::from_str(&t).ok())
                    .collect()
            })
            .unwrap_or_default();
        v.sort_by(|a: &CrashReport, b| b.at.cmp(&a.at).then(b.id.cmp(&a.id)));
        v
    }

    pub fn acknowledge(&self, id: &str) -> Result<bool> {
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Ok(false);
        }
        let path = self.dir.join(format!("{id}.json"));
        let Ok(text) = std::fs::read_to_string(&path) else { return Ok(false) };
        let mut r: CrashReport = serde_json::from_str(&text)?;
        if !r.acknowledged {
            r.acknowledged = true;
            crate::write_atomic(&path, &serde_json::to_vec_pretty(&r)?)?;
        }
        Ok(true)
    }
}

/// Marker of a running NEXUS instance, to tell a clean exit from a crash,
/// a kill or a reboot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstanceMarker {
    pub pid: u32,
    pub pid_start_ms: Option<u64>,
    pub started_at: String,
    pub clean_exit_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PreviousRun {
    /// No marker: first run with this version.
    Unknown,
    Clean {
        at: String,
    },
    /// The previous instance ended without closing (crash, kill, reboot, power loss).
    Unexpected {
        pid: u32,
        started_at: String,
    },
    /// Another NEXUS process still has it open.
    StillRunning {
        pid: u32,
    },
}

/// Reads the previous marker in `file` and writes this instance's one.
pub fn begin_instance(file: &Path) -> PreviousRun {
    let previous: Option<InstanceMarker> =
        std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok());
    let me = crate::sys::current_pid();
    let result = match previous {
        None => PreviousRun::Unknown,
        Some(m) if m.clean_exit_at.is_some() => PreviousRun::Clean { at: m.clean_exit_at.unwrap_or_default() },
        Some(m) if m.pid != me && still_same_process(m.pid, m.pid_start_ms) => PreviousRun::StillRunning { pid: m.pid },
        Some(m) => PreviousRun::Unexpected { pid: m.pid, started_at: m.started_at },
    };
    let marker = InstanceMarker {
        pid: me,
        pid_start_ms: crate::sys::process_info(me).and_then(|i| i.created_ms),
        started_at: pcc_core::now(),
        clean_exit_at: None,
    };
    if let Ok(bytes) = serde_json::to_vec_pretty(&marker) {
        if let Err(e) = crate::write_atomic(file, &bytes) {
            tracing::warn!("cannot write instance marker: {e}");
        }
    }
    result
}

/// Records a clean exit of this instance.
pub fn end_instance(file: &Path) {
    let Some(mut m) = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<InstanceMarker>(&t).ok())
    else {
        return;
    };
    if m.pid != crate::sys::current_pid() {
        return;
    }
    m.clean_exit_at = Some(pcc_core::now());
    if let Ok(bytes) = serde_json::to_vec_pretty(&m) {
        let _ = crate::write_atomic(file, &bytes);
    }
}

fn still_same_process(pid: u32, start: Option<u64>) -> bool {
    match crate::sys::process_info(pid) {
        None => false,
        Some(i) => crate::sys::same_start(i.created_ms, start).unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_round_trip_and_acknowledge() {
        let tmp = tempfile::tempdir().unwrap();
        let s = ReportStore::new(tmp.path().join("crash-reports"));
        let mut a = CrashReport::new("claude-session", "Builder crashed");
        a.at = "2026-01-01T00:00:00.000Z".into();
        a.lost.push("The turn in progress".into());
        let b = CrashReport::new("mcp", "MCP reconnected");
        s.add(&a).unwrap();
        s.add(&b).unwrap();
        let list = s.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, b.id, "newest first");
        assert!(s.acknowledge(&a.id).unwrap());
        assert!(s.list().iter().find(|r| r.id == a.id).unwrap().acknowledged);
        assert!(!s.acknowledge("../evil").unwrap());
    }

    #[test]
    fn instance_marker_tells_clean_from_unexpected() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("instance.json");
        assert_eq!(begin_instance(&f), PreviousRun::Unknown);
        end_instance(&f);
        assert!(matches!(begin_instance(&f), PreviousRun::Clean { .. }));
        // Not closed: the same process opening it again counts as unexpected
        // (a dead previous instance looks exactly like this).
        assert!(matches!(begin_instance(&f), PreviousRun::Unexpected { .. }));
        // A marker of a process that no longer exists.
        let dead =
            InstanceMarker { pid: 0xFFFF_FFF1, pid_start_ms: Some(1), started_at: "x".into(), clean_exit_at: None };
        std::fs::write(&f, serde_json::to_string(&dead).unwrap()).unwrap();
        assert_eq!(begin_instance(&f), PreviousRun::Unexpected { pid: 0xFFFF_FFF1, started_at: "x".into() });
    }
}
