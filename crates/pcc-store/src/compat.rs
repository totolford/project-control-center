//! Project compatibility between NEXUS versions.
//!
//! * The manifest (`project.json`) records the layout `formatVersion`, the
//!   NEXUS version that created / last opened the project and the minimum
//!   version able to open it. Unknown fields are preserved on rewrite.
//! * Older formats are migrated step by step (`migrations()`), always after a
//!   full backup of `.agent-project` (worktrees and raw logs excluded), with an
//!   integrity check and a Markdown report. A backup can be restored (rollback).
//! * Newer formats open in compatibility mode: unknown data is kept untouched,
//!   and when the project or its database requires a newer NEXUS the store is
//!   opened read-only.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::OpenFlags;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db;
use crate::layout::{write_atomic, write_json_atomic, Layout};
use pcc_core::{Error, Result};

/// Layout format written by this version.
pub const CURRENT_FORMAT: u32 = 2;
/// Version of NEXUS (workspace version).
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Folder next to `.agent-project` holding migration backups.
pub const BACKUPS_DIR: &str = ".agent-project-backups";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompatStatus {
    /// Same format: opens normally.
    Compatible,
    /// Older format with a migration path: backup, migrate, open.
    MigrationAvailable,
    /// Newer format that this version can still open (unknown data kept).
    NewerFormat,
    /// The project (or its database) requires a newer NEXUS: read-only.
    RequiresNewerNexus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStep {
    pub from: u32,
    pub to: u32,
    pub title: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityReport {
    pub status: CompatStatus,
    pub project_format: u32,
    pub supported_format: u32,
    pub app_version: String,
    pub created_with: Option<String>,
    pub last_opened_with: Option<String>,
    pub minimum_nexus_version: Option<String>,
    pub database_schema: Option<i64>,
    pub supported_database_schema: i64,
    /// Manifest fields this version does not know (kept as-is).
    pub unknown_fields: Vec<String>,
    pub plan: Vec<MigrationStep>,
    /// Human explanations (features unavailable, why read-only...).
    pub notes: Vec<String>,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub id: String,
    pub path: String,
    pub created_at: String,
    pub format_version: Option<u32>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub from_format: u32,
    pub to_format: u32,
    pub backup: BackupInfo,
    pub steps: Vec<String>,
    pub integrity: Vec<String>,
    pub ok: bool,
    pub report_path: String,
}

struct Migration {
    from: u32,
    to: u32,
    title: &'static str,
    description: &'static str,
    apply: fn(&Layout, &mut Value) -> Result<Vec<String>>,
}

fn migrations() -> Vec<Migration> {
    vec![Migration {
        from: 1,
        to: 2,
        title: "Versioned manifest and new folders",
        description: "Adds createdWith / lastOpenedWith / minimumNexusVersion to project.json and creates settings/ (workspace layout), ai-world/ and migrations/.",
        apply: migrate_1_to_2,
    }]
}

fn migrate_1_to_2(layout: &Layout, manifest: &mut Value) -> Result<Vec<String>> {
    let mut done = Vec::new();
    let obj = manifest.as_object_mut().ok_or_else(|| Error::invalid("project.json is not an object"))?;
    if !obj.contains_key("createdWith") {
        // Format 1 was only written by 0.1.x.
        obj.insert("createdWith".into(), json!("0.1.x"));
        done.push("createdWith set to 0.1.x (format 1 predates version tracking)".into());
    }
    obj.insert("minimumNexusVersion".into(), json!("0.2.0"));
    done.push("minimumNexusVersion set to 0.2.0".into());
    for dir in ["settings", "ai-world", "migrations"] {
        let d = layout.dir.join(dir);
        if !d.exists() {
            fs::create_dir_all(&d)?;
            done.push(format!("created .agent-project/{dir}/"));
        }
    }
    Ok(done)
}

/// Parses `x.y.z` (pre-release suffixes ignored) for comparisons.
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut it = core.split('.').map(|p| p.parse::<u64>());
    let major = it.next()?.ok()?;
    let minor = it.next().unwrap_or(Ok(0)).ok()?;
    let patch = it.next().unwrap_or(Ok(0)).ok()?;
    Some((major, minor, patch))
}

fn version_lt(a: &str, b: &str) -> bool {
    matches!((parse_version(a), parse_version(b)), (Some(x), Some(y)) if x < y)
}

const KNOWN_FIELDS: &[&str] =
    &["id", "name", "root", "createdAt", "formatVersion", "createdWith", "lastOpenedWith", "minimumNexusVersion"];

fn read_manifest(layout: &Layout) -> Result<Value> {
    let text = fs::read_to_string(layout.project_json())?;
    serde_json::from_str(&text).map_err(|e| Error::Storage(format!("project.json is unreadable: {e}")))
}

fn database_schema(layout: &Layout) -> Option<i64> {
    let path = layout.db_path();
    if !path.is_file() {
        return None;
    }
    let c = rusqlite::Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    c.query_row("PRAGMA user_version", [], |r| r.get(0)).ok()
}

/// Inspects a project without modifying it.
pub fn analyze(root: &Path) -> Result<CompatibilityReport> {
    let layout = Layout::new(root);
    if !Layout::exists(root) {
        return Err(Error::not_found(format!("{} has no .agent-project/project.json", root.display())));
    }
    let m = read_manifest(&layout)?;
    let s = |k: &str| m.get(k).and_then(Value::as_str).map(str::to_string);
    let format = m.get("formatVersion").and_then(Value::as_u64).unwrap_or(1) as u32;
    let minimum = s("minimumNexusVersion");
    let db_schema = database_schema(&layout);
    let supported_db = db::schema_version();
    let unknown_fields: Vec<String> = m
        .as_object()
        .map(|o| o.keys().filter(|k| !KNOWN_FIELDS.contains(&k.as_str())).cloned().collect())
        .unwrap_or_default();
    let mut notes = Vec::new();
    let needs_newer_app = minimum.as_deref().is_some_and(|min| version_lt(APP_VERSION, min));
    let newer_db = db_schema.is_some_and(|v| v > supported_db);
    if needs_newer_app {
        notes.push(format!(
            "This project requires NEXUS {} or newer; this is {APP_VERSION}.",
            minimum.clone().unwrap_or_default()
        ));
    }
    if newer_db {
        notes.push(format!(
            "The database uses schema v{} (this version knows v{supported_db}); it is opened read-only so nothing is lost.",
            db_schema.unwrap_or_default()
        ));
    }
    if !unknown_fields.is_empty() {
        notes.push(format!("Unknown manifest fields are preserved: {}.", unknown_fields.join(", ")));
    }
    let plan: Vec<MigrationStep> = migrations()
        .into_iter()
        .filter(|mg| mg.from >= format && mg.to <= CURRENT_FORMAT)
        .map(|mg| MigrationStep {
            from: mg.from,
            to: mg.to,
            title: mg.title.into(),
            description: mg.description.into(),
        })
        .collect();
    let status = if needs_newer_app || newer_db {
        CompatStatus::RequiresNewerNexus
    } else if format > CURRENT_FORMAT {
        notes.push(format!(
            "Format {format} is newer than {CURRENT_FORMAT}: features added later are unavailable, their data is kept."
        ));
        CompatStatus::NewerFormat
    } else if format < CURRENT_FORMAT {
        CompatStatus::MigrationAvailable
    } else {
        CompatStatus::Compatible
    };
    Ok(CompatibilityReport {
        status,
        project_format: format,
        supported_format: CURRENT_FORMAT,
        app_version: APP_VERSION.into(),
        created_with: s("createdWith"),
        last_opened_with: s("lastOpenedWith"),
        minimum_nexus_version: minimum,
        database_schema: db_schema,
        supported_database_schema: supported_db,
        unknown_fields,
        plan,
        notes,
        read_only: status == CompatStatus::RequiresNewerNexus,
    })
}

fn backups_root(root: &Path) -> PathBuf {
    root.join(BACKUPS_DIR)
}

fn stamp() -> String {
    pcc_core::now().chars().filter(|c| c.is_ascii_digit()).take(14).collect()
}

/// Copies `.agent-project` (without worktrees and raw logs) to a new backup.
pub fn backup(root: &Path, reason: &str) -> Result<BackupInfo> {
    let layout = Layout::new(root);
    let format =
        read_manifest(&layout).ok().and_then(|m| m.get("formatVersion").and_then(Value::as_u64)).map(|v| v as u32);
    let id = format!(
        "{}-{}",
        stamp(),
        reason.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>()
    );
    let dest = backups_root(root).join(&id);
    copy_tree(&layout.dir, &dest, &["worktrees", "logs"])?;
    let info = BackupInfo {
        id,
        path: dest.to_string_lossy().into_owned(),
        created_at: pcc_core::now(),
        format_version: format,
        reason: reason.into(),
    };
    write_json_atomic(&dest.join("backup.json"), &info)?;
    Ok(info)
}

fn copy_tree(src: &Path, dst: &Path, skip: &[&str]) -> Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().into_owned();
        if skip.contains(&name.as_str()) {
            continue;
        }
        let to = dst.join(&name);
        if e.path().is_dir() {
            copy_tree(&e.path(), &to, &[])?;
        } else {
            fs::copy(e.path(), to)?;
        }
    }
    Ok(())
}

pub fn list_backups(root: &Path) -> Vec<BackupInfo> {
    let mut out: Vec<BackupInfo> = fs::read_dir(backups_root(root))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| fs::read_to_string(e.path().join("backup.json")).ok())
        .filter_map(|s| serde_json::from_str(&s).ok())
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

/// Runs every pending migration after a backup. The project must not be open.
pub fn migrate(root: &Path) -> Result<MigrationReport> {
    let layout = Layout::new(root);
    let before = analyze(root)?;
    if before.status != CompatStatus::MigrationAvailable {
        return Err(Error::invalid(format!("nothing to migrate (status {:?})", before.status)));
    }
    let backup = backup(root, &format!("before-format-{}", CURRENT_FORMAT))?;
    let mut manifest = read_manifest(&layout)?;
    let mut steps = Vec::new();
    let mut format = before.project_format;
    // Steps chain: each one starts where the previous ended.
    for mg in migrations() {
        if mg.from != format || mg.to > CURRENT_FORMAT {
            continue;
        }
        for line in (mg.apply)(&layout, &mut manifest)? {
            steps.push(format!("[{}→{}] {line}", mg.from, mg.to));
        }
        format = mg.to;
    }
    if let Some(o) = manifest.as_object_mut() {
        o.insert("formatVersion".into(), json!(format));
        o.insert("lastOpenedWith".into(), json!(APP_VERSION));
    }
    write_json_atomic(&layout.project_json(), &manifest)?;
    let integrity = verify(root);
    let ok = integrity.iter().all(|l| l.starts_with("ok"));
    let report_path =
        layout.dir.join("migrations").join(format!("{}-format-{}-to-{}.md", stamp(), before.project_format, format));
    let md = format!(
        "# Project migration\n\nFrom format {} to {} with NEXUS {APP_VERSION}.\n\nBackup: `{}`\n\n## Steps\n\n{}\n\n## Integrity\n\n{}\n\nResult: {}\n\nRollback: restore the backup from Settings → Compatibility.\n",
        before.project_format,
        format,
        backup.path,
        steps.iter().map(|s| format!("- {s}")).collect::<Vec<_>>().join("\n"),
        integrity.iter().map(|s| format!("- {s}")).collect::<Vec<_>>().join("\n"),
        if ok { "success" } else { "problems found — consider rolling back" }
    );
    write_atomic(&report_path, md.as_bytes())?;
    Ok(MigrationReport {
        from_format: before.project_format,
        to_format: format,
        backup,
        steps,
        integrity,
        ok,
        report_path: report_path.to_string_lossy().into_owned(),
    })
}

/// Checks the manifest, settings and database after a migration.
pub fn verify(root: &Path) -> Vec<String> {
    let layout = Layout::new(root);
    let mut out = Vec::new();
    match layout.read_project() {
        Ok(p) => out.push(format!("ok: project.json readable (format {})", p.format_version)),
        Err(e) => out.push(format!("error: project.json: {e}")),
    }
    match layout.read_settings() {
        Ok(_) => out.push("ok: settings.json readable".into()),
        Err(e) => out.push(format!("error: settings.json: {e}")),
    }
    match rusqlite::Connection::open_with_flags(layout.db_path(), OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => match c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)) {
            Ok(r) if r == "ok" => out.push("ok: database integrity_check".into()),
            Ok(r) => out.push(format!("error: database integrity_check: {r}")),
            Err(e) => out.push(format!("error: database: {e}")),
        },
        Err(_) if !layout.db_path().exists() => out.push("ok: no database yet".into()),
        Err(e) => out.push(format!("error: database: {e}")),
    }
    out
}

/// Restores a backup. The current `.agent-project` is itself backed up first.
pub fn rollback(root: &Path, backup_id: &str) -> Result<BackupInfo> {
    let source = backups_root(root).join(backup_id);
    if backup_id.contains(['/', '\\']) || !source.join("backup.json").is_file() {
        return Err(Error::not_found(format!("backup {backup_id}")));
    }
    let layout = Layout::new(root);
    let undo = backup(root, "before-rollback")?;
    // Keep worktrees and logs (not part of backups) in place.
    for e in fs::read_dir(&layout.dir)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().into_owned();
        if matches!(name.as_str(), "worktrees" | "logs") {
            continue;
        }
        if e.path().is_dir() {
            fs::remove_dir_all(e.path())?;
        } else {
            fs::remove_file(e.path())?;
        }
    }
    copy_tree(&source, &layout.dir, &["backup.json"])?;
    Ok(undo)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProjectStore;

    fn v1_project(root: &Path) {
        let l = Layout::new(root);
        l.ensure().unwrap();
        fs::write(
            l.project_json(),
            r#"{"id":"x","name":"Old","root":"r","createdAt":"2026-09-01T00:00:00Z","formatVersion":1,"futureThing":{"a":1}}"#,
        )
        .unwrap();
    }

    #[test]
    fn versions() {
        assert_eq!(parse_version("v0.2.1-beta"), Some((0, 2, 1)));
        assert!(version_lt("0.1.9", "0.2.0"));
        assert!(!version_lt("0.10.0", "0.2.0"));
    }

    #[test]
    fn migrates_v1_with_backup_report_and_rollback() {
        let tmp = tempfile::tempdir().unwrap();
        v1_project(tmp.path());
        let a = analyze(tmp.path()).unwrap();
        assert_eq!(a.status, CompatStatus::MigrationAvailable);
        assert_eq!(a.plan.len(), 1);
        assert_eq!(a.unknown_fields, vec!["futureThing"]);

        let r = migrate(tmp.path()).unwrap();
        assert!(r.ok, "{:?}", r.integrity);
        assert_eq!((r.from_format, r.to_format), (1, 2));
        assert!(Path::new(&r.report_path).is_file());
        let m: Value =
            serde_json::from_str(&fs::read_to_string(Layout::new(tmp.path()).project_json()).unwrap()).unwrap();
        assert_eq!(m["formatVersion"], 2);
        assert_eq!(m["futureThing"]["a"], 1, "unknown data preserved");
        assert_eq!(analyze(tmp.path()).unwrap().status, CompatStatus::Compatible);
        assert_eq!(list_backups(tmp.path()).len(), 1);

        rollback(tmp.path(), &r.backup.id).unwrap();
        assert_eq!(analyze(tmp.path()).unwrap().project_format, 1);
        assert_eq!(list_backups(tmp.path()).len(), 2, "rollback keeps an undo backup");
    }

    #[test]
    fn newer_projects_open_in_compatibility_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let l = Layout::new(tmp.path());
        l.ensure().unwrap();
        fs::write(l.project_json(), r#"{"id":"x","name":"Future","root":"r","createdAt":"t","formatVersion":9,"minimumNexusVersion":"0.1.0","novel":true}"#).unwrap();
        assert_eq!(analyze(tmp.path()).unwrap().status, CompatStatus::NewerFormat);
        let s = ProjectStore::open(tmp.path()).unwrap();
        assert!(!s.read_only());
        drop(s);
        let m: Value = serde_json::from_str(&fs::read_to_string(l.project_json()).unwrap()).unwrap();
        assert_eq!(m["novel"], true, "unknown fields survive a rewrite");
        assert_eq!(m["formatVersion"], 9, "format never downgraded");

        fs::write(
            l.project_json(),
            r#"{"id":"x","name":"Future","root":"r","createdAt":"t","formatVersion":9,"minimumNexusVersion":"99.0.0"}"#,
        )
        .unwrap();
        let a = analyze(tmp.path()).unwrap();
        assert_eq!(a.status, CompatStatus::RequiresNewerNexus);
        let s = ProjectStore::open(tmp.path()).unwrap();
        assert!(s.read_only());
        assert!(s.next_task_id().is_err(), "writes refused in read-only mode");
    }
}
