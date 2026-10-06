//! SQLite schema. Entities are stored as JSON documents with indexed columns
//! for the fields we query on; high-volume data (logs, events) is columnar.

use std::path::Path;

use pcc_core::{Error, Result};
use rusqlite::Connection;

const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE agents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE missions (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE tasks (
        id TEXT PRIMARY KEY, mission_id TEXT, status TEXT NOT NULL, agent TEXT,
        created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX tasks_mission ON tasks(mission_id);
    CREATE INDEX tasks_agent ON tasks(agent, status);
    CREATE TABLE messages (
        id TEXT PRIMARY KEY, seq INTEGER NOT NULL, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
        task_id TEXT, mission_id TEXT, created_at TEXT NOT NULL, delivered_at TEXT, data TEXT NOT NULL);
    CREATE INDEX messages_seq ON messages(seq);
    CREATE INDEX messages_to ON messages(to_agent, delivered_at);
    CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, claude_session_id TEXT,
        pid INTEGER, started_at TEXT NOT NULL, ended_at TEXT, exit_code INTEGER,
        state TEXT NOT NULL, cost_usd REAL NOT NULL DEFAULT 0);
    CREATE INDEX sessions_agent ON sessions(agent_id);
    CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, session_id INTEGER NOT NULL,
        ts TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
    CREATE INDEX logs_agent ON logs(agent_id, id);
    CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL,
        agent_id TEXT, task_id TEXT, mission_id TEXT, summary TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX events_agent ON events(agent_id, id);
    CREATE INDEX events_mission ON events(mission_id, id);
    CREATE TABLE permission_rules (
        agent_id TEXT NOT NULL, rule_key TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, rule_key));
    CREATE TABLE connections (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    "#,
    // v2: permission decision journal
    r#"
    CREATE TABLE decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, agent_id TEXT NOT NULL,
        tool_name TEXT NOT NULL, capability TEXT, summary TEXT NOT NULL, decision TEXT NOT NULL,
        actor TEXT NOT NULL, reason TEXT);
    CREATE INDEX decisions_agent ON decisions(agent_id, id);
    "#,
    // v3: command journal
    r#"
    CREATE TABLE commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, source TEXT NOT NULL,
        tool_use_id TEXT, raw TEXT NOT NULL, program TEXT, parsed TEXT NOT NULL, target TEXT,
        capability TEXT, decision TEXT, started_at TEXT NOT NULL, ended_at TEXT, exit_code INTEGER,
        is_error INTEGER, output TEXT);
    CREATE INDEX commands_agent ON commands(agent_id, id);
    CREATE INDEX commands_tool ON commands(tool_use_id);
    "#,
    // v4: persistent permission requests, idempotency keys, event journal columns
    r#"
    CREATE TABLE permissions (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, agent_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        mission_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT,
        data TEXT NOT NULL);
    CREATE INDEX permissions_status ON permissions(status);
    CREATE INDEX permissions_agent ON permissions(agent_id, created_at);
    CREATE TABLE idempotency (
        key TEXT PRIMARY KEY, scope TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
    ALTER TABLE events ADD COLUMN name TEXT;
    ALTER TABLE events ADD COLUMN severity TEXT;
    ALTER TABLE events ADD COLUMN source TEXT;
    ALTER TABLE events ADD COLUMN pid INTEGER;
    UPDATE events SET source = 'engine',
        severity = CASE
            WHEN kind = 'EmergencyStop' THEN 'critical'
            WHEN kind IN ('Error', 'AgentCrashed', 'TaskFailed') THEN 'error'
            WHEN kind IN ('PermissionRequested', 'UserRequested', 'ReviewRequested') THEN 'warning'
            ELSE 'info' END;
    CREATE INDEX events_ts ON events(ts);
    CREATE INDEX events_name ON events(name);
    "#,
];

/// Schema version written by this build.
pub fn schema_version() -> i64 {
    MIGRATIONS.len() as i64
}

/// Opens a database without migrating or writing (compatibility mode).
pub fn open_read_only(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(storage)?;
    conn.execute_batch("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;").map_err(storage)?;
    Ok(conn)
}

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path).map_err(storage)?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory().map_err(storage)?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    // WAL + NORMAL sync: durable across application crashes, fast enough for log streaming.
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    )
    .map_err(storage)
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(storage)?;
    let current = version as usize;
    if current > MIGRATIONS.len() {
        return Err(Error::Storage(format!(
            "database schema v{current} is newer than this application supports (v{}); update Project Control Center",
            MIGRATIONS.len()
        )));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.unchecked_transaction().map_err(storage)?;
        tx.execute_batch(sql).map_err(storage)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64).map_err(storage)?;
        tx.commit().map_err(storage)?;
    }
    Ok(())
}

pub fn storage(e: rusqlite::Error) -> Error {
    Error::Storage(e.to_string())
}
