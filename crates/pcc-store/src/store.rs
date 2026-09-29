//! Typed access to project state.
//!
//! SQLite is the source of truth. Selected entities are mirrored to readable
//! files inside `.agent-project` (task JSON, agent state, message journal,
//! mission plans) so the project folder stays inspectable without the app.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::db::{self, storage};
use crate::layout::{write_json_atomic, Layout, FORMAT_VERSION};
use crate::memory::{self, MemoryFile, MemoryScope};
use pcc_core::{
    ids, Agent, Connection as ProjectConnection, Error, Event, EventKind, LogEntry, LogKind, Message, Mission,
    MissionStatus, MissionView, ProjectInfo, ProjectSettings, Result, SessionRecord, Task, TaskStatus,
};

/// Maximum characters stored for one log line (tool results can be huge).
const MAX_LOG_TEXT: usize = 16_000;

pub struct ProjectStore {
    layout: Layout,
    conn: Mutex<Connection>,
    info: ProjectInfo,
    settings: Mutex<ProjectSettings>,
    raw_logs: Mutex<HashMap<(String, i64), fs::File>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskFilter {
    pub mission_id: Option<String>,
    pub agent: Option<String>,
    pub status: Option<TaskStatus>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EventFilter {
    pub agent_id: Option<String>,
    pub mission_id: Option<String>,
    pub task_id: Option<String>,
    /// Return events with `id < before`.
    pub before: Option<i64>,
    pub limit: Option<u32>,
}

impl ProjectStore {
    /// Creates `.agent-project` in `root` (or adopts an existing one) and opens it.
    pub fn create(root: &Path, name: &str) -> Result<Self> {
        let layout = Layout::new(root);
        if Layout::exists(root) {
            return Self::open(root);
        }
        layout.ensure()?;
        let info = ProjectInfo {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            root: root.to_string_lossy().into_owned(),
            created_at: pcc_core::now(),
            format_version: FORMAT_VERSION,
        };
        layout.write_project(&info)?;
        layout.write_settings(&ProjectSettings::default())?;
        Self::open(root)
    }

    pub fn open(root: &Path) -> Result<Self> {
        let layout = Layout::new(root);
        if !Layout::exists(root) {
            return Err(Error::not_found(format!(
                "{} is not a Project Control Center project (no .agent-project/project.json)",
                root.display()
            )));
        }
        layout.ensure()?;
        let mut info = layout.read_project()?;
        if info.format_version > FORMAT_VERSION {
            return Err(Error::Storage(format!(
                "project format v{} is newer than this application supports",
                info.format_version
            )));
        }
        // The folder may have been moved since creation.
        let actual = root.to_string_lossy().into_owned();
        if info.root != actual {
            info.root = actual;
            layout.write_project(&info)?;
        }
        let settings = layout.read_settings()?;
        let conn = db::open(&layout.db_path())?;
        Ok(ProjectStore {
            layout,
            conn: Mutex::new(conn),
            info,
            settings: Mutex::new(settings),
            raw_logs: Mutex::new(HashMap::new()),
        })
    }

    /// In-memory database over a real layout; used by tests.
    pub fn open_ephemeral(root: &Path, name: &str) -> Result<Self> {
        let layout = Layout::new(root);
        layout.ensure()?;
        let info = ProjectInfo {
            id: "test".into(),
            name: name.into(),
            root: root.to_string_lossy().into_owned(),
            created_at: pcc_core::now(),
            format_version: FORMAT_VERSION,
        };
        layout.write_project(&info)?;
        Ok(ProjectStore {
            layout,
            conn: Mutex::new(db::open_in_memory()?),
            info,
            settings: Mutex::new(ProjectSettings::default()),
            raw_logs: Mutex::new(HashMap::new()),
        })
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }
    pub fn root(&self) -> &Path {
        &self.layout.root
    }
    pub fn info(&self) -> &ProjectInfo {
        &self.info
    }
    pub fn settings(&self) -> ProjectSettings {
        self.settings.lock().clone()
    }
    pub fn save_settings(&self, s: ProjectSettings) -> Result<()> {
        self.layout.write_settings(&s)?;
        *self.settings.lock() = s;
        Ok(())
    }

    // ------------------------------------------------------------ helpers

    fn next_counter(&self, name: &str) -> Result<i64> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO counters(name, value) VALUES (?1, 1)
             ON CONFLICT(name) DO UPDATE SET value = value + 1",
            params![name],
        )
        .map_err(storage)?;
        c.query_row("SELECT value FROM counters WHERE name = ?1", params![name], |r| r.get(0)).map_err(storage)
    }

    pub fn next_task_id(&self) -> Result<String> {
        Ok(ids::seq_id("TASK", self.next_counter("task")?))
    }
    pub fn next_mission_id(&self) -> Result<String> {
        Ok(ids::seq_id("M", self.next_counter("mission")?))
    }
    fn next_message_seq(&self) -> Result<i64> {
        self.next_counter("message")
    }

    pub fn meta_get(&self, key: &str) -> Result<Option<String>> {
        self.conn
            .lock()
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .map_err(storage)
    }
    pub fn meta_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn
            .lock()
            .execute(
                "INSERT INTO meta(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(storage)?;
        Ok(())
    }

    fn get_doc<T: DeserializeOwned>(&self, table: &str, id: &str) -> Result<Option<T>> {
        let sql = format!("SELECT data FROM {table} WHERE id = ?1");
        let s: Option<String> =
            self.conn.lock().query_row(&sql, params![id], |r| r.get(0)).optional().map_err(storage)?;
        s.map(|s| serde_json::from_str(&s).map_err(Error::from)).transpose()
    }

    fn list_docs<T: DeserializeOwned>(&self, sql: &str, p: &[&dyn rusqlite::ToSql]) -> Result<Vec<T>> {
        let c = self.conn.lock();
        let mut stmt = c.prepare(sql).map_err(storage)?;
        let rows = stmt.query_map(p, |r| r.get::<_, String>(0)).map_err(storage)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row.map_err(storage)?)?);
        }
        Ok(out)
    }

    // ------------------------------------------------------------ agents

    pub fn upsert_agent(&self, a: &Agent) -> Result<()> {
        self.conn
            .lock()
            .execute(
                "INSERT INTO agents(id, data) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                params![a.id, serde_json::to_string(a)?],
            )
            .map_err(storage)?;
        self.layout.ensure_agent_dir(&a.id, &a.role)?;
        write_json_atomic(&self.layout.agent_dir(&a.id).join("state.json"), a)
    }

    pub fn get_agent(&self, id: &str) -> Result<Option<Agent>> {
        self.get_doc("agents", id)
    }

    pub fn agent(&self, id: &str) -> Result<Agent> {
        self.get_agent(id)?.ok_or_else(|| Error::not_found(format!("agent {id}")))
    }

    pub fn list_agents(&self) -> Result<Vec<Agent>> {
        let mut v: Vec<Agent> = self.list_docs("SELECT data FROM agents", &[])?;
        // Central first, then creation order.
        v.sort_by(|a, b| {
            (a.kind != pcc_core::AgentKind::Central, &a.created_at)
                .cmp(&(b.kind != pcc_core::AgentKind::Central, &b.created_at))
        });
        Ok(v)
    }

    // ------------------------------------------------------------ missions

    pub fn upsert_mission(&self, m: &Mission) -> Result<()> {
        self.conn
            .lock()
            .execute(
                "INSERT INTO missions(id, status, created_at, data) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data",
                params![m.id, status_str(&m.status), m.created_at, serde_json::to_string(m)?],
            )
            .map_err(storage)?;
        self.write_mission_plan(m)
    }

    pub fn get_mission(&self, id: &str) -> Result<Option<Mission>> {
        self.get_doc("missions", id)
    }

    pub fn list_missions(&self) -> Result<Vec<MissionView>> {
        let missions: Vec<Mission> = self.list_docs("SELECT data FROM missions ORDER BY created_at DESC", &[])?;
        let c = self.conn.lock();
        let mut stmt = c
            .prepare(
                "SELECT mission_id, status, COUNT(*) FROM tasks WHERE mission_id IS NOT NULL
                 GROUP BY mission_id, status",
            )
            .map_err(storage)?;
        let mut counts: HashMap<String, (u32, u32, u32)> = HashMap::new();
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, u32>(2)?)))
            .map_err(storage)?;
        for row in rows {
            let (mid, status, n) = row.map_err(storage)?;
            let e = counts.entry(mid).or_default();
            if status != "cancelled" {
                e.0 += n;
            }
            if status == "completed" {
                e.1 += n;
            }
            if status == "failed" {
                e.2 += n;
            }
        }
        Ok(missions
            .into_iter()
            .map(|m| {
                let (t, d, f) = counts.get(&m.id).copied().unwrap_or_default();
                MissionView { mission: m, task_total: t, task_done: d, task_failed: f }
            })
            .collect())
    }

    pub fn active_mission_ids(&self) -> Result<Vec<String>> {
        Ok(self
            .list_docs::<Mission>(
                "SELECT data FROM missions WHERE status IN ('planning','active') ORDER BY created_at",
                &[],
            )?
            .into_iter()
            .map(|m| m.id)
            .collect())
    }

    fn write_mission_plan(&self, m: &Mission) -> Result<()> {
        let tasks = self.list_tasks(&TaskFilter { mission_id: Some(m.id.clone()), ..Default::default() })?;
        let mut md = format!(
            "# {} — {}\n\nStatus: {}\nCreated: {}\n\n## Request\n\n{}\n\n## Tasks\n\n",
            m.id,
            m.title,
            status_str(&m.status),
            m.created_at,
            m.prompt
        );
        if tasks.is_empty() {
            md.push_str("_No tasks yet._\n");
        }
        for t in &tasks {
            md.push_str(&format!(
                "- [{}] **{}** {} — {}{}\n",
                if t.status == TaskStatus::Completed { "x" } else { " " },
                t.id,
                t.title,
                t.status.as_str(),
                t.agent.as_ref().map(|a| format!(" (@{a})")).unwrap_or_default()
            ));
        }
        if let Some(s) = &m.summary {
            md.push_str(&format!("\n## Summary\n\n{s}\n"));
        }
        crate::layout::write_atomic(&self.layout.plans_dir().join(format!("{}.md", m.id)), md.as_bytes())
    }

    // ------------------------------------------------------------ tasks

    pub fn upsert_task(&self, t: &Task) -> Result<()> {
        self.conn
            .lock()
            .execute(
                "INSERT INTO tasks(id, mission_id, status, agent, created_at, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET mission_id = excluded.mission_id,
                   status = excluded.status, agent = excluded.agent, data = excluded.data",
                params![t.id, t.mission_id, t.status.as_str(), t.agent, t.created_at, serde_json::to_string(t)?],
            )
            .map_err(storage)?;
        self.mirror_task(t)?;
        if let Some(mid) = &t.mission_id {
            if let Some(m) = self.get_mission(mid)? {
                self.write_mission_plan(&m)?;
            }
        }
        Ok(())
    }

    /// Keeps exactly one JSON copy of the task in the bucket matching its status.
    fn mirror_task(&self, t: &Task) -> Result<()> {
        let bucket = match t.status {
            TaskStatus::Completed => "completed",
            TaskStatus::Failed | TaskStatus::Cancelled => "failed",
            _ => "active",
        };
        for b in ["active", "completed", "failed"] {
            let p = self.layout.tasks_dir(b).join(format!("{}.json", t.id));
            if b == bucket {
                write_json_atomic(&p, t)?;
            } else if p.exists() {
                fs::remove_file(p)?;
            }
        }
        if let (TaskStatus::Completed, Some(r)) = (t.status, &t.result) {
            let md = format!(
                "# {} — {}\n\nAgent: {}\nCompleted: {}\n\n## Summary\n\n{}\n\n## Files\n\n{}\n\n## Tests\n\n{}\n\n## Potential issues\n\n{}\n",
                t.id,
                t.title,
                t.agent.as_deref().unwrap_or("-"),
                t.completed_at.as_deref().unwrap_or("-"),
                r.summary,
                if r.files_changed.is_empty() { "_none reported_".to_string() } else { r.files_changed.iter().map(|f| format!("- {f}")).collect::<Vec<_>>().join("\n") },
                r.tests.as_deref().unwrap_or("_not reported_"),
                r.issues.as_deref().unwrap_or("_none reported_"),
            );
            crate::layout::write_atomic(
                &self.layout.tasks_dir("completed").join(format!("{}.md", t.id)),
                md.as_bytes(),
            )?;
        }
        Ok(())
    }

    pub fn get_task(&self, id: &str) -> Result<Option<Task>> {
        self.get_doc("tasks", id)
    }

    pub fn task(&self, id: &str) -> Result<Task> {
        self.get_task(id)?.ok_or_else(|| Error::not_found(format!("task {id}")))
    }

    pub fn list_tasks(&self, f: &TaskFilter) -> Result<Vec<Task>> {
        let status = f.status.map(|s| s.as_str().to_string());
        self.list_docs(
            "SELECT data FROM tasks
             WHERE (?1 IS NULL OR mission_id = ?1) AND (?2 IS NULL OR agent = ?2) AND (?3 IS NULL OR status = ?3)
             ORDER BY created_at, id",
            &[&f.mission_id, &f.agent, &status],
        )
    }

    // ------------------------------------------------------------ messages

    pub fn insert_message(&self, m: &Message) -> Result<()> {
        let seq = self.next_message_seq()?;
        self.conn
            .lock()
            .execute(
                "INSERT INTO messages(id, seq, from_agent, to_agent, task_id, mission_id, created_at, delivered_at, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![m.id, seq, m.from, m.to, m.task_id, m.mission_id, m.created_at, m.delivered_at, serde_json::to_string(m)?],
            )
            .map_err(storage)?;
        self.journal_message(m)
    }

    pub fn mark_delivered(&self, id: &str, at: &str) -> Result<Option<Message>> {
        let Some(mut m) = self.get_doc::<Message>("messages", id)? else {
            return Ok(None);
        };
        m.delivered_at = Some(at.to_string());
        self.conn
            .lock()
            .execute(
                "UPDATE messages SET delivered_at = ?2, data = ?3 WHERE id = ?1",
                params![id, at, serde_json::to_string(&m)?],
            )
            .map_err(storage)?;
        Ok(Some(m))
    }

    /// Messages to `agent` that were never written to its session.
    pub fn undelivered_for(&self, agent: &str) -> Result<Vec<Message>> {
        self.list_docs("SELECT data FROM messages WHERE to_agent = ?1 AND delivered_at IS NULL ORDER BY seq", &[&agent])
    }

    /// Latest messages involving `agent` (or all), newest last.
    pub fn list_messages(&self, agent: Option<&str>, limit: u32) -> Result<Vec<Message>> {
        let mut v: Vec<Message> = self.list_docs(
            "SELECT data FROM messages WHERE (?1 IS NULL OR from_agent = ?1 OR to_agent = ?1)
             ORDER BY seq DESC LIMIT ?2",
            &[&agent, &limit],
        )?;
        v.reverse();
        Ok(v)
    }

    fn journal_message(&self, m: &Message) -> Result<()> {
        let day = m.created_at.get(..10).unwrap_or("unknown");
        let path = self.layout.messages_dir().join(format!("{day}.jsonl"));
        let mut f = OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(f, "{}", serde_json::to_string(m)?)?;
        Ok(())
    }

    // ------------------------------------------------------------ sessions

    pub fn start_session(&self, agent: &str, claude_session_id: Option<&str>, pid: Option<u32>) -> Result<i64> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO sessions(agent_id, claude_session_id, pid, started_at, state) VALUES (?1, ?2, ?3, ?4, 'running')",
            params![agent, claude_session_id, pid, pcc_core::now()],
        )
        .map_err(storage)?;
        let id = c.last_insert_rowid();
        drop(c);
        self.write_session_file(id)?;
        Ok(id)
    }

    pub fn end_session(&self, id: i64, state: &str, exit_code: Option<i32>) -> Result<()> {
        self.conn
            .lock()
            .execute(
                "UPDATE sessions SET state = ?2, exit_code = ?3, ended_at = ?4 WHERE id = ?1 AND ended_at IS NULL",
                params![id, state, exit_code, pcc_core::now()],
            )
            .map_err(storage)?;
        self.raw_logs.lock().retain(|(_, s), _| *s != id);
        self.write_session_file(id)
    }

    pub fn set_session_cost(&self, id: i64, cost: f64) -> Result<()> {
        self.conn
            .lock()
            .execute("UPDATE sessions SET cost_usd = ?2 WHERE id = ?1", params![id, cost])
            .map_err(storage)?;
        Ok(())
    }

    pub fn get_session(&self, id: i64) -> Result<Option<SessionRecord>> {
        self.conn
            .lock()
            .query_row(
                "SELECT id, agent_id, claude_session_id, pid, started_at, ended_at, exit_code, state, cost_usd FROM sessions WHERE id = ?1",
                params![id],
                row_to_session,
            )
            .optional()
            .map_err(storage)
    }

    /// Sessions still marked `running`: after a restart these belong to dead processes.
    pub fn running_sessions(&self) -> Result<Vec<SessionRecord>> {
        self.query_sessions("WHERE state = 'running' ORDER BY id", &[])
    }

    pub fn list_sessions(&self, agent: &str) -> Result<Vec<SessionRecord>> {
        self.query_sessions("WHERE agent_id = ?1 ORDER BY id DESC LIMIT 50", &[&agent])
    }

    fn query_sessions(&self, clause: &str, p: &[&dyn rusqlite::ToSql]) -> Result<Vec<SessionRecord>> {
        let sql = format!("SELECT id, agent_id, claude_session_id, pid, started_at, ended_at, exit_code, state, cost_usd FROM sessions {clause}");
        let c = self.conn.lock();
        let mut stmt = c.prepare(&sql).map_err(storage)?;
        let rows = stmt.query_map(p, row_to_session).map_err(storage)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(storage)
    }

    fn write_session_file(&self, id: i64) -> Result<()> {
        if let Some(s) = self.get_session(id)? {
            write_json_atomic(&self.layout.sessions_dir().join(format!("{:06}-{}.json", s.id, s.agent_id)), &s)?;
        }
        Ok(())
    }

    // ------------------------------------------------------------ logs

    pub fn append_log(&self, agent: &str, session: i64, kind: LogKind, text: &str) -> Result<LogEntry> {
        let text = if text.chars().count() > MAX_LOG_TEXT {
            let mut t: String = text.chars().take(MAX_LOG_TEXT).collect();
            t.push_str("\n[… truncated …]");
            t
        } else {
            text.to_string()
        };
        let ts = pcc_core::now();
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO logs(agent_id, session_id, ts, kind, text) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![agent, session, ts, kind.as_str(), text],
        )
        .map_err(storage)?;
        Ok(LogEntry { id: c.last_insert_rowid(), agent_id: agent.into(), session_id: session, ts, kind, text })
    }

    /// Page of log lines, newest last. `before` = exclusive upper id bound.
    pub fn list_logs(&self, agent: &str, before: Option<i64>, limit: u32) -> Result<Vec<LogEntry>> {
        let c = self.conn.lock();
        let mut stmt = c
            .prepare(
                "SELECT id, agent_id, session_id, ts, kind, text FROM logs
                 WHERE agent_id = ?1 AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT ?3",
            )
            .map_err(storage)?;
        let rows = stmt
            .query_map(params![agent, before, limit], |r| {
                Ok(LogEntry {
                    id: r.get(0)?,
                    agent_id: r.get(1)?,
                    session_id: r.get(2)?,
                    ts: r.get(3)?,
                    kind: LogKind::parse(&r.get::<_, String>(4)?),
                    text: r.get(5)?,
                })
            })
            .map_err(storage)?;
        let mut v = rows.collect::<std::result::Result<Vec<_>, _>>().map_err(storage)?;
        v.reverse();
        Ok(v)
    }

    /// Raw stream-json line, kept on disk for debugging and audits.
    pub fn append_raw(&self, agent: &str, session: i64, line: &str) -> Result<()> {
        let mut files = self.raw_logs.lock();
        let key = (agent.to_string(), session);
        if !files.contains_key(&key) {
            let dir = self.layout.logs_dir().join("agents").join(agent);
            fs::create_dir_all(&dir)?;
            let f =
                OpenOptions::new().create(true).append(true).open(dir.join(format!("session-{session:06}.jsonl")))?;
            files.insert(key.clone(), f);
        }
        let f = files.get_mut(&key).expect("inserted above");
        writeln!(f, "{line}")?;
        Ok(())
    }

    // ------------------------------------------------------------ events

    /// Persists the event (if it belongs on the timeline) and sets its id.
    pub fn insert_event(&self, e: &mut Event) -> Result<()> {
        if !e.kind.is_persistent() {
            return Ok(());
        }
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO events(ts, kind, agent_id, task_id, mission_id, summary, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                e.ts,
                serde_json::to_string(&e.kind)?.trim_matches('"'),
                e.agent_id,
                e.task_id,
                e.mission_id,
                e.summary,
                serde_json::to_string(&e.payload)?
            ],
        )
        .map_err(storage)?;
        e.id = c.last_insert_rowid();
        Ok(())
    }

    /// Newest first.
    pub fn list_events(&self, f: &EventFilter) -> Result<Vec<Event>> {
        let limit = f.limit.unwrap_or(200).min(2000);
        let c = self.conn.lock();
        let mut stmt = c
            .prepare(
                "SELECT id, ts, kind, agent_id, task_id, mission_id, summary, payload FROM events
                 WHERE (?1 IS NULL OR agent_id = ?1) AND (?2 IS NULL OR mission_id = ?2)
                   AND (?3 IS NULL OR task_id = ?3) AND (?4 IS NULL OR id < ?4)
                 ORDER BY id DESC LIMIT ?5",
            )
            .map_err(storage)?;
        let rows = stmt
            .query_map(params![f.agent_id, f.mission_id, f.task_id, f.before, limit], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                ))
            })
            .map_err(storage)?;
        let mut out = Vec::new();
        for row in rows {
            let (id, ts, kind, agent_id, task_id, mission_id, summary, payload) = row.map_err(storage)?;
            let kind: EventKind = serde_json::from_str(&format!("\"{kind}\""))?;
            out.push(Event {
                id,
                ts,
                kind,
                agent_id,
                task_id,
                mission_id,
                summary,
                payload: serde_json::from_str(&payload)?,
            });
        }
        Ok(out)
    }

    // ------------------------------------------------------------ permission rules

    pub fn add_permission_rule(&self, agent: &str, rule_key: &str) -> Result<()> {
        self.conn
            .lock()
            .execute(
                "INSERT OR IGNORE INTO permission_rules(agent_id, rule_key, created_at) VALUES (?1, ?2, ?3)",
                params![agent, rule_key, pcc_core::now()],
            )
            .map_err(storage)?;
        Ok(())
    }

    pub fn has_permission_rule(&self, agent: &str, rule_key: &str) -> Result<bool> {
        Ok(self
            .conn
            .lock()
            .query_row(
                "SELECT 1 FROM permission_rules WHERE agent_id = ?1 AND rule_key = ?2",
                params![agent, rule_key],
                |_| Ok(()),
            )
            .optional()
            .map_err(storage)?
            .is_some())
    }

    pub fn list_permission_rules(&self, agent: &str) -> Result<Vec<String>> {
        let c = self.conn.lock();
        let mut stmt = c
            .prepare("SELECT rule_key FROM permission_rules WHERE agent_id = ?1 ORDER BY created_at")
            .map_err(storage)?;
        let rows = stmt.query_map(params![agent], |r| r.get(0)).map_err(storage)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(storage)
    }

    pub fn remove_permission_rule(&self, agent: &str, rule_key: &str) -> Result<()> {
        self.conn
            .lock()
            .execute("DELETE FROM permission_rules WHERE agent_id = ?1 AND rule_key = ?2", params![agent, rule_key])
            .map_err(storage)?;
        Ok(())
    }

    // ------------------------------------------------------------ connections

    pub fn upsert_connection(&self, c: &ProjectConnection) -> Result<()> {
        self.conn
            .lock()
            .execute(
                "INSERT INTO connections(id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                params![c.id, serde_json::to_string(c)?],
            )
            .map_err(storage)?;
        Ok(())
    }

    pub fn get_connection(&self, id: &str) -> Result<Option<ProjectConnection>> {
        self.get_doc("connections", id)
    }

    pub fn list_connections(&self) -> Result<Vec<ProjectConnection>> {
        let mut v: Vec<ProjectConnection> = self.list_docs("SELECT data FROM connections", &[])?;
        v.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(v)
    }

    pub fn delete_connection(&self, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM connections WHERE id = ?1", params![id]).map_err(storage)?;
        Ok(())
    }

    // ------------------------------------------------------------ memory

    pub fn read_memory(&self, scope: &MemoryScope) -> Result<MemoryFile> {
        memory::read(&self.layout, scope)
    }
    pub fn write_memory(&self, scope: &MemoryScope, content: &str) -> Result<()> {
        memory::write(&self.layout, scope, content)
    }
    pub fn append_memory(&self, scope: &MemoryScope, author: &str, entry: &str) -> Result<()> {
        memory::append(&self.layout, scope, author, entry)
    }
    pub fn memory_budgeted(&self, scope: &MemoryScope, max_chars: usize) -> Result<String> {
        memory::read_budgeted(&self.layout, scope, max_chars)
    }
    pub fn list_memory(&self) -> Result<Vec<MemoryFile>> {
        let agents: Vec<String> = self.list_agents()?.into_iter().map(|a| a.id).collect();
        memory::list(&self.layout, &agents)
    }

    /// The saved workspace layout, if any.
    pub fn load_workspace(&self) -> Result<Option<serde_json::Value>> {
        match fs::read_to_string(self.layout.workspace_json()) {
            Ok(s) => Ok(Some(serde_json::from_str(&s)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save_workspace(&self, layout: &serde_json::Value) -> Result<()> {
        if !layout.is_object() {
            return Err(Error::invalid("the workspace layout must be a JSON object"));
        }
        let text = serde_json::to_string_pretty(layout)?;
        if text.len() > 1_000_000 {
            return Err(Error::invalid("the workspace layout is too large"));
        }
        crate::layout::write_atomic(&self.layout.workspace_json(), text.as_bytes())
    }

    pub fn snapshots_file(&self) -> PathBuf {
        self.layout.snapshots_dir().join("snapshots.json")
    }
}

fn row_to_session(r: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRecord> {
    Ok(SessionRecord {
        id: r.get(0)?,
        agent_id: r.get(1)?,
        claude_session_id: r.get(2)?,
        pid: r.get(3)?,
        started_at: r.get(4)?,
        ended_at: r.get(5)?,
        exit_code: r.get(6)?,
        state: r.get(7)?,
        cost_usd: r.get(8)?,
    })
}

fn status_str(s: &MissionStatus) -> &'static str {
    match s {
        MissionStatus::Planning => "planning",
        MissionStatus::Active => "active",
        MissionStatus::Completed => "completed",
        MissionStatus::Failed => "failed",
        MissionStatus::Cancelled => "cancelled",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcc_core::{AgentKind, AgentStatus, Isolation, MessageKind, PermissionSet, Priority};

    fn sample_task(id: &str, mission: Option<&str>, status: TaskStatus) -> Task {
        Task {
            id: id.into(),
            mission_id: mission.map(Into::into),
            title: format!("title {id}"),
            description: "d".into(),
            status,
            priority: Priority::High,
            agent: Some("movement".into()),
            dependencies: vec![],
            requires_review: false,
            progress: None,
            status_reason: None,
            result: None,
            created_by: "central".into(),
            created_at: pcc_core::now(),
            updated_at: pcc_core::now(),
            started_at: None,
            completed_at: None,
        }
    }

    #[test]
    fn create_reopen_persists_state() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let s = ProjectStore::create(tmp.path(), "AERIS").unwrap();
            let id = s.next_task_id().unwrap();
            assert_eq!(id, "TASK-0001");
            s.upsert_task(&sample_task(&id, None, TaskStatus::Pending)).unwrap();
        }
        let s = ProjectStore::open(tmp.path()).unwrap();
        assert_eq!(s.info().name, "AERIS");
        assert_eq!(s.task("TASK-0001").unwrap().status, TaskStatus::Pending);
        assert_eq!(s.next_task_id().unwrap(), "TASK-0002");
        assert!(tmp.path().join(".agent-project/tasks/active/TASK-0001.json").is_file());
    }

    #[test]
    fn task_mirror_moves_between_buckets() {
        let tmp = tempfile::tempdir().unwrap();
        let s = ProjectStore::open_ephemeral(tmp.path(), "t").unwrap();
        let mut t = sample_task("TASK-0001", None, TaskStatus::InProgress);
        s.upsert_task(&t).unwrap();
        t.status = TaskStatus::Completed;
        t.result = Some(pcc_core::TaskResult { summary: "done".into(), ..Default::default() });
        s.upsert_task(&t).unwrap();
        let d = tmp.path().join(".agent-project/tasks");
        assert!(!d.join("active/TASK-0001.json").exists());
        assert!(d.join("completed/TASK-0001.json").exists());
        assert!(d.join("completed/TASK-0001.md").exists());
    }

    #[test]
    fn mission_counters() {
        let tmp = tempfile::tempdir().unwrap();
        let s = ProjectStore::open_ephemeral(tmp.path(), "t").unwrap();
        let m = Mission {
            id: "M-0001".into(),
            title: "x".into(),
            prompt: "p".into(),
            status: MissionStatus::Active,
            summary: None,
            created_at: pcc_core::now(),
            updated_at: pcc_core::now(),
            completed_at: None,
        };
        s.upsert_mission(&m).unwrap();
        s.upsert_task(&sample_task("TASK-0001", Some("M-0001"), TaskStatus::Completed)).unwrap();
        s.upsert_task(&sample_task("TASK-0002", Some("M-0001"), TaskStatus::InProgress)).unwrap();
        s.upsert_task(&sample_task("TASK-0003", Some("M-0001"), TaskStatus::Cancelled)).unwrap();
        let v = s.list_missions().unwrap();
        assert_eq!((v[0].task_total, v[0].task_done), (2, 1));
        let plan = fs::read_to_string(tmp.path().join(".agent-project/plans/M-0001.md")).unwrap();
        assert!(plan.contains("TASK-0002"));
    }

    #[test]
    fn messages_delivery_and_journal() {
        let tmp = tempfile::tempdir().unwrap();
        let s = ProjectStore::open_ephemeral(tmp.path(), "t").unwrap();
        let m = Message {
            id: "m1".into(),
            from: "frontend".into(),
            to: "central".into(),
            kind: MessageKind::Request,
            subject: None,
            body: "need API".into(),
            task_id: None,
            mission_id: None,
            created_at: pcc_core::now(),
            delivered_at: None,
        };
        s.insert_message(&m).unwrap();
        assert_eq!(s.undelivered_for("central").unwrap().len(), 1);
        s.mark_delivered("m1", &pcc_core::now()).unwrap();
        assert!(s.undelivered_for("central").unwrap().is_empty());
        assert_eq!(s.list_messages(Some("frontend"), 10).unwrap().len(), 1);
        let journal = fs::read_dir(tmp.path().join(".agent-project/messages")).unwrap().count();
        assert_eq!(journal, 1);
    }

    #[test]
    fn sessions_logs_events_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let s = ProjectStore::open_ephemeral(tmp.path(), "t").unwrap();
        let sid = s.start_session("central", Some("abc"), Some(42)).unwrap();
        assert_eq!(s.running_sessions().unwrap().len(), 1);
        for i in 0..5 {
            s.append_log("central", sid, LogKind::AssistantText, &format!("line {i}")).unwrap();
        }
        let page = s.list_logs("central", None, 3).unwrap();
        assert_eq!(page.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["line 2", "line 3", "line 4"]);
        let older = s.list_logs("central", Some(page[0].id), 10).unwrap();
        assert_eq!(older.len(), 2);
        s.end_session(sid, "stopped", Some(0)).unwrap();
        assert!(s.running_sessions().unwrap().is_empty());

        let mut e = Event::new(EventKind::TaskCreated, "created", serde_json::json!({"a": 1})).task("TASK-0001");
        s.insert_event(&mut e).unwrap();
        assert!(e.id > 0);
        let mut transient = Event::new(EventKind::AgentUpdated, "x", serde_json::Value::Null);
        s.insert_event(&mut transient).unwrap();
        assert_eq!(transient.id, 0);
        let ev = s.list_events(&EventFilter::default()).unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].kind, EventKind::TaskCreated);

        s.add_permission_rule("frontend", "Bash:npm test").unwrap();
        assert!(s.has_permission_rule("frontend", "Bash:npm test").unwrap());
        assert!(!s.has_permission_rule("backend", "Bash:npm test").unwrap());
    }

    #[test]
    fn workspace_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let s = ProjectStore::open_ephemeral(tmp.path(), "t").unwrap();
        assert_eq!(s.load_workspace().unwrap(), None);
        let w = serde_json::json!({"version": 1, "tabs": []});
        s.save_workspace(&w).unwrap();
        assert_eq!(s.load_workspace().unwrap(), Some(w));
        assert!(tmp.path().join(".agent-project/settings/workspace.json").is_file());
        assert!(s.save_workspace(&serde_json::json!([1])).is_err());
    }

    #[test]
    fn agents_sorted_central_first() {
        let tmp = tempfile::tempdir().unwrap();
        let s = ProjectStore::open_ephemeral(tmp.path(), "t").unwrap();
        let mk = |id: &str, kind| Agent {
            id: id.into(),
            name: id.into(),
            kind,
            provider: pcc_core::CLAUDE_CODE_PROVIDER.into(),
            role: "r".into(),
            instructions: String::new(),
            status: AgentStatus::Offline,
            model: None,
            permissions: PermissionSet::worker_default(),
            connections: vec![],
            isolation: Isolation::Shared,
            workdir: ".".into(),
            branch: None,
            current_task: None,
            current_action: None,
            progress: None,
            claude_session_id: None,
            total_cost_usd: 0.0,
            created_by: "user".into(),
            created_at: pcc_core::now(),
            updated_at: pcc_core::now(),
        };
        s.upsert_agent(&mk("alpha", AgentKind::Worker)).unwrap();
        s.upsert_agent(&mk("central", AgentKind::Central)).unwrap();
        let ids: Vec<_> = s.list_agents().unwrap().into_iter().map(|a| a.id).collect();
        assert_eq!(ids, ["central", "alpha"]);
        assert!(tmp.path().join(".agent-project/agents/alpha/memory.md").is_file());
        assert!(tmp.path().join(".agent-project/agents/alpha/state.json").is_file());
    }
}
