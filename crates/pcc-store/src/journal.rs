//! Event journal queries (the Activity page) and idempotency keys.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::storage;
use crate::store::ProjectStore;
use pcc_core::{Event, EventKind, Result, Severity};

/// Filters of the event journal. Every field is optional.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JournalFilter {
    /// Events at or after this RFC 3339 timestamp.
    pub since: Option<String>,
    /// Events before this RFC 3339 timestamp.
    pub until: Option<String>,
    pub agent: Option<String>,
    pub mission: Option<String>,
    /// Minimum severity.
    pub severity: Option<Severity>,
    /// Emitter (`engine`, `ui`, `runtime`...).
    pub source: Option<String>,
    /// Dotted name or prefix (`permission.`, `agent.crashed`).
    pub name: Option<String>,
    /// Paging: events with `id < before`.
    pub before: Option<i64>,
    /// Default 200, at most 2000.
    pub limit: Option<u32>,
}

/// Reads one `events` row selected as
/// `id, ts, kind, agent_id, task_id, mission_id, summary, payload, name, severity, source, pid`.
pub(crate) fn row_to_event(r: &rusqlite::Row<'_>) -> rusqlite::Result<Result<Event>> {
    let kind: String = r.get(2)?;
    let payload: String = r.get(7)?;
    let name: Option<String> = r.get(8)?;
    let severity: Option<String> = r.get(9)?;
    let source: Option<String> = r.get(10)?;
    let fields = (
        r.get::<_, i64>(0)?,
        r.get::<_, String>(1)?,
        r.get::<_, Option<String>>(3)?,
        r.get::<_, Option<String>>(4)?,
        r.get::<_, Option<String>>(5)?,
        r.get::<_, String>(6)?,
        r.get::<_, Option<u32>>(11)?,
    );
    Ok((|| {
        let (id, ts, agent_id, task_id, mission_id, summary, pid) = fields;
        let kind: EventKind = serde_json::from_str(&format!("\"{kind}\""))?;
        let mut e = Event::new(kind, summary, serde_json::from_str(&payload)?);
        e.id = id;
        e.ts = ts;
        e.agent_id = agent_id;
        e.task_id = task_id;
        e.mission_id = mission_id;
        // Rows written before the journal columns existed get derived values.
        e.name = name.unwrap_or_default();
        e.ensure_name();
        if let Some(s) = severity {
            e.severity = Severity::parse(&s);
        }
        e.source = source.unwrap_or_else(|| "engine".into());
        e.pid = pid;
        Ok(e)
    })())
}

impl ProjectStore {
    /// Newest first.
    pub fn journal(&self, f: &JournalFilter) -> Result<Vec<Event>> {
        let limit = f.limit.unwrap_or(200).clamp(1, 2000);
        let severities = f.severity.map(|min| {
            let list: Vec<&str> = Severity::ALL.iter().filter(|s| **s >= min).map(|s| s.as_str()).collect();
            format!(",{},", list.join(","))
        });
        let c = self.db();
        let mut stmt = c
            .prepare(
                "SELECT id, ts, kind, agent_id, task_id, mission_id, summary, payload, name, severity, source, pid FROM events
                 WHERE (?1 IS NULL OR ts >= ?1) AND (?2 IS NULL OR ts < ?2)
                   AND (?3 IS NULL OR agent_id = ?3) AND (?4 IS NULL OR mission_id = ?4)
                   AND (?5 IS NULL OR instr(?5, ',' || COALESCE(severity, 'info') || ',') > 0)
                   AND (?6 IS NULL OR COALESCE(source, 'engine') = ?6)
                   AND (?7 IS NULL OR name = ?7 OR name LIKE ?7 || '%')
                   AND (?8 IS NULL OR id < ?8)
                 ORDER BY id DESC LIMIT ?9",
            )
            .map_err(storage)?;
        let rows = stmt
            .query_map(
                params![f.since, f.until, f.agent, f.mission, severities, f.source, f.name, f.before, limit],
                row_to_event,
            )
            .map_err(storage)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(storage)??);
        }
        Ok(out)
    }

    // ------------------------------------------------------------ idempotency

    /// Result recorded for a client-supplied idempotency key.
    pub fn idempotency_get(&self, key: &str) -> Result<Option<String>> {
        self.db()
            .query_row("SELECT result FROM idempotency WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .map_err(storage)
    }

    /// Records the result of the first call made with `key` (later calls keep the first).
    pub fn idempotency_put(&self, key: &str, scope: &str, result: &str) -> Result<()> {
        self.writable()?;
        self.db()
            .execute(
                "INSERT OR IGNORE INTO idempotency(key, scope, result, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![key, scope, result, pcc_core::now()],
            )
            .map_err(storage)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn journal_filters_and_names() {
        let tmp = tempfile::tempdir().unwrap();
        let s = ProjectStore::create(tmp.path(), "J").unwrap();
        let mut a = Event::new(EventKind::AgentStarted, "ops started", json!({})).agent("ops").with_pid(Some(42));
        s.insert_event(&mut a).unwrap();
        let mut b = Event::new(EventKind::AgentCrashed, "ops crashed", json!({})).agent("ops");
        s.insert_event(&mut b).unwrap();
        let mut c = Event::new(EventKind::PermissionResolved, "denied", json!({"id": "perm-1", "decision": "reject"}));
        s.insert_event(&mut c).unwrap();
        let mut d = Event::new(EventKind::SystemNotice, "renderer back", json!({}))
            .named("ui.rendererRecovered")
            .with_source("ui");
        s.insert_event(&mut d).unwrap();
        // Name is set before the event is published.
        assert_eq!(a.name, "agent.started");
        assert_eq!(c.name, "permission.denied");

        let all = s.journal(&JournalFilter::default()).unwrap();
        assert_eq!(all.len(), 4);
        assert_eq!(all[3].pid, Some(42));
        let errors = s.journal(&JournalFilter { severity: Some(Severity::Error), ..Default::default() }).unwrap();
        assert_eq!(errors.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["agent.crashed"]);
        let ops = s.journal(&JournalFilter { agent: Some("ops".into()), ..Default::default() }).unwrap();
        assert_eq!(ops.len(), 2);
        let perms = s.journal(&JournalFilter { name: Some("permission.".into()), ..Default::default() }).unwrap();
        assert_eq!(perms.len(), 1);
        let ui = s.journal(&JournalFilter { source: Some("ui".into()), ..Default::default() }).unwrap();
        assert_eq!(ui[0].name, "ui.rendererRecovered");
        let future = s.journal(&JournalFilter { since: Some("2999-01-01T00:00:00Z".into()), ..Default::default() });
        assert!(future.unwrap().is_empty());
        let limited = s.journal(&JournalFilter { limit: Some(1), ..Default::default() }).unwrap();
        assert_eq!(limited[0].id, d.id);
    }

    #[test]
    fn idempotency_keeps_first_result() {
        let tmp = tempfile::tempdir().unwrap();
        let s = ProjectStore::create(tmp.path(), "J").unwrap();
        assert_eq!(s.idempotency_get("k").unwrap(), None);
        s.idempotency_put("k", "mission", "M-0001").unwrap();
        s.idempotency_put("k", "mission", "M-0002").unwrap();
        assert_eq!(s.idempotency_get("k").unwrap().as_deref(), Some("M-0001"));
    }
}
