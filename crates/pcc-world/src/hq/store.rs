//! world.json on disk: load (with migrations), atomic writes, snapshots before
//! every structural change, validation, rollback.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use pcc_core::{Error, Result};

use super::config::{migrate, WorldConfig};
use super::layout;
use super::ops::{self, OpContext, WorldOp};
use super::validate::{self, Issue};

/// Snapshots kept.
const KEEP_SNAPSHOTS: usize = 50;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub at: String,
    /// What it was taken before (operation name, `migration`, `rollback`...).
    pub label: String,
    pub revision: u64,
    pub rooms: usize,
}

/// Result of an applied operation.
#[derive(Debug, Clone)]
pub struct Applied {
    pub config: WorldConfig,
    pub message: String,
    pub snapshot: Option<SnapshotInfo>,
    pub warnings: Vec<Issue>,
}

/// `.agent-project/world/`.
#[derive(Debug, Clone)]
pub struct HqStore {
    dir: PathBuf,
}

fn stamp() -> String {
    pcc_core::now().chars().filter(|c| c.is_ascii_digit()).collect()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp~");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

impl HqStore {
    pub fn new(agent_dir: &Path) -> Self {
        HqStore { dir: agent_dir.join("world") }
    }

    /// For a project root (`<root>/.agent-project/world`).
    pub fn for_project(root: &Path) -> Self {
        Self::new(&root.join(".agent-project"))
    }

    pub fn file(&self) -> PathBuf {
        self.dir.join("world.json")
    }

    pub fn snapshots_dir(&self) -> PathBuf {
        self.dir.join("snapshots")
    }

    /// Modification time of world.json (cheap change detection for the bridge).
    pub fn modified(&self) -> Option<std::time::SystemTime> {
        std::fs::metadata(self.file()).and_then(|m| m.modified()).ok()
    }

    /// The current world, migrated if needed (the original is snapshotted
    /// first). `None` when the project has no world.json yet.
    pub fn load(&self) -> Result<Option<WorldConfig>> {
        let text = match std::fs::read_to_string(self.file()) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let raw: Value = serde_json::from_str(&text).map_err(|e| Error::invalid(format!("world.json: {e}")))?;
        let m = migrate(raw)?;
        if m.notes.is_empty() {
            return Ok(Some(m.config));
        }
        // Migrated: keep the original, arrange, validate, then write.
        self.snapshot_raw(&text, "migration", 0, 0)?;
        let mut cfg = m.config;
        layout::arrange(&mut cfg);
        if !validate::errors(&validate::validate(&cfg)).is_empty() {
            let locale = cfg.locale.clone();
            validate::repair(&mut cfg, &locale, &[]);
        }
        cfg.revision += 1;
        cfg.updated_at = pcc_core::now();
        self.save(&cfg)?;
        Ok(Some(cfg))
    }

    /// Loads, or creates the world with `init` (arranged, validated, written).
    pub fn load_or_init(&self, init: impl FnOnce() -> WorldConfig) -> Result<WorldConfig> {
        if let Some(c) = self.load()? {
            return Ok(c);
        }
        let mut cfg = init();
        layout::arrange(&mut cfg);
        let issues = validate::validate(&cfg);
        if let Some(e) = validate::errors(&issues).first() {
            return Err(Error::invalid(format!("default world is invalid: {}", e.message)));
        }
        cfg.revision = 1;
        cfg.updated_at = pcc_core::now();
        self.save(&cfg)?;
        Ok(cfg)
    }

    pub fn save(&self, cfg: &WorldConfig) -> Result<()> {
        write_atomic(&self.file(), &serde_json::to_vec_pretty(cfg)?)
    }

    fn snapshot_raw(&self, text: &str, label: &str, revision: u64, rooms: usize) -> Result<SnapshotInfo> {
        let label: String = label.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(32).collect();
        let base = format!("{}-r{revision}-{label}", stamp());
        let mut id = base.clone();
        let mut n = 1;
        while self.snapshots_dir().join(format!("{id}.json")).exists() {
            n += 1;
            id = format!("{base}-{n}");
        }
        write_atomic(&self.snapshots_dir().join(format!("{id}.json")), text.as_bytes())?;
        self.prune();
        Ok(SnapshotInfo { id, at: pcc_core::now(), label, revision, rooms })
    }

    /// Saves the current world.json under `snapshots/` before a change.
    pub fn snapshot(&self, label: &str) -> Result<Option<SnapshotInfo>> {
        let Ok(text) = std::fs::read_to_string(self.file()) else { return Ok(None) };
        let (rev, rooms) = serde_json::from_str::<WorldConfig>(&text)
            .map(|c| (c.revision, c.rooms.iter().filter(|r| r.active()).count()))
            .unwrap_or((0, 0));
        self.snapshot_raw(&text, label, rev, rooms).map(Some)
    }

    fn prune(&self) {
        let mut ids = self.snapshot_ids();
        if ids.len() <= KEEP_SNAPSHOTS {
            return;
        }
        ids.sort();
        for old in &ids[..ids.len() - KEEP_SNAPSHOTS] {
            let _ = std::fs::remove_file(self.snapshots_dir().join(format!("{old}.json")));
        }
    }

    fn snapshot_ids(&self) -> Vec<String> {
        std::fs::read_dir(self.snapshots_dir())
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".json")).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Newest first.
    pub fn snapshots(&self) -> Vec<SnapshotInfo> {
        let mut ids = self.snapshot_ids();
        ids.sort();
        ids.reverse();
        ids.into_iter()
            .map(|id| {
                let path = self.snapshots_dir().join(format!("{id}.json"));
                let at = std::fs::metadata(&path).and_then(|m| m.modified()).ok().map(chrono_like).unwrap_or_default();
                let parsed = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
                let revision = parsed.as_ref().and_then(|v| v.get("revision")).and_then(Value::as_u64).unwrap_or(0);
                let rooms = parsed
                    .as_ref()
                    .and_then(|v| v.get("rooms"))
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter(|r| r.get("archived") != Some(&Value::Bool(true))).count())
                    .unwrap_or(0);
                let label = id.splitn(3, '-').nth(2).unwrap_or("").to_string();
                SnapshotInfo { id, at, label, revision, rooms }
            })
            .collect()
    }

    /// Validates `next`, writes it, and puts the previous file back if anything fails.
    fn commit(&self, previous: Option<&WorldConfig>, mut next: WorldConfig) -> Result<(WorldConfig, Vec<Issue>)> {
        let issues = validate::validate(&next);
        if let Some(e) = validate::errors(&issues).first() {
            let at = e.room.as_deref().map(|r| format!(" ({r})")).unwrap_or_default();
            return Err(Error::invalid(format!("the change was refused, the world is unchanged: {}{at}", e.message)));
        }
        next.revision = previous.map(|p| p.revision).unwrap_or(0) + 1;
        next.updated_at = pcc_core::now();
        if let Err(e) = self.save(&next) {
            if let Some(p) = previous {
                let _ = self.save(p);
            }
            return Err(e);
        }
        Ok((next, issues.into_iter().filter(|i| i.severity != "error").collect()))
    }

    /// Snapshot (structural changes) → apply → arrange → validate → write, or rollback.
    pub fn apply(&self, op: &WorldOp, ctx: &OpContext) -> Result<Applied> {
        let current = self.load()?.ok_or_else(|| Error::not_found("AI World (world.json)"))?;
        let mut next = current.clone();
        let message = ops::apply(&mut next, op, ctx)?;
        layout::arrange(&mut next);
        let snapshot = if op.is_structural() { self.snapshot(op.name())? } else { None };
        match self.commit(Some(&current), next) {
            Ok((config, warnings)) => Ok(Applied { config, message, snapshot, warnings }),
            Err(e) => {
                // The snapshot of a refused change is useless.
                if let Some(s) = &snapshot {
                    let _ = std::fs::remove_file(self.snapshots_dir().join(format!("{}.json", s.id)));
                }
                Err(e)
            }
        }
    }

    /// Puts a snapshot back (after snapshotting the current world).
    pub fn restore(&self, id: &str) -> Result<WorldConfig> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(Error::invalid("invalid snapshot id"));
        }
        let text = std::fs::read_to_string(self.snapshots_dir().join(format!("{id}.json")))
            .map_err(|_| Error::not_found(format!("snapshot {id}")))?;
        let raw: Value = serde_json::from_str(&text).map_err(|e| Error::invalid(format!("snapshot {id}: {e}")))?;
        let mut cfg = migrate(raw)?.config;
        layout::arrange(&mut cfg);
        let current = self.load()?;
        self.snapshot("rollback")?;
        Ok(self.commit(current.as_ref(), cfg)?.0)
    }
}

/// RFC 3339 of a file time (seconds precision) without pulling chrono in.
fn chrono_like(t: std::time::SystemTime) -> String {
    let secs = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::super::config::Room;
    use super::*;

    fn init() -> WorldConfig {
        let mut c = WorldConfig::default();
        for k in ["central_hq", "coding_office", "server_room"] {
            c.rooms.push(Room::of_kind(k, "en"));
        }
        c
    }

    fn ctx() -> OpContext<'static> {
        OpContext { actor: "user", agents: &[] }
    }

    #[test]
    fn init_snapshot_apply_and_rollback() {
        let tmp = tempfile::tempdir().unwrap();
        let s = HqStore::new(tmp.path());
        assert!(s.load().unwrap().is_none());
        let c = s.load_or_init(init).unwrap();
        assert_eq!((c.revision, c.rooms.len()), (1, 3));
        let op = WorldOp::CreateRoom {
            kind: Some("database_room".into()),
            name: None,
            purpose: None,
            size: None,
            position: None,
            temporary: false,
            agents: vec![],
            required_connections: vec![],
        };
        let a = s.apply(&op, &ctx()).unwrap();
        assert_eq!(a.config.revision, 2);
        let snap = a.snapshot.expect("structural change snapshotted");
        assert_eq!(snap.revision, 1);
        assert_eq!(s.load().unwrap().unwrap().rooms.len(), 4);
        let list = s.snapshots();
        assert_eq!(list[0].id, snap.id);
        assert_eq!((list[0].label.as_str(), list[0].rooms), ("create_room", 3));
        // Rollback puts revision 1's rooms back as a new revision.
        let back = s.restore(&snap.id).unwrap();
        assert_eq!((back.rooms.len(), back.revision), (3, 3));
        assert!(s.snapshots().iter().any(|x| x.label == "rollback"));
        assert!(s.restore("../../etc").is_err());
    }

    #[test]
    fn a_refused_change_leaves_the_world_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let s = HqStore::new(tmp.path());
        let before = s.load_or_init(init).unwrap();
        let n = s.snapshots().len();
        // Moving a room onto HQ: the validator refuses it.
        let hq = before.hq().unwrap().position;
        let err =
            s.apply(&WorldOp::MoveRoom { room: "server_room".into(), x: hq.x + 1, y: hq.y + 1 }, &ctx()).unwrap_err();
        assert!(err.to_string().contains("refused"), "{err}");
        assert_eq!(s.load().unwrap().unwrap(), before);
        assert_eq!(s.snapshots().len(), n, "no snapshot left for a refused change");
        // Non-structural operations take no snapshot.
        let a = s.apply(&WorldOp::ChangeLanguage { language: "fr".into(), locale: None }, &ctx()).unwrap();
        assert!(a.snapshot.is_none());
        assert_eq!(a.config.room("server_room").unwrap().name, "Salle des serveurs");
    }

    #[test]
    fn legacy_files_are_migrated_with_a_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let s = HqStore::new(tmp.path());
        std::fs::create_dir_all(s.file().parent().unwrap()).unwrap();
        std::fs::write(
            s.file(),
            r#"{"zones":[{"id":"central_hq","name":"Central HQ","purpose":"p","x":42,"y":16,"w":8,"h":5},{"id":"server_room","name":"Server Room","purpose":"","x":37,"y":26,"w":8,"h":4}]}"#,
        )
        .unwrap();
        let c = s.load().unwrap().unwrap();
        assert_eq!(c.version, super::super::config::WORLD_VERSION);
        assert!(validate::errors(&validate::validate(&c)).is_empty());
        assert_eq!(s.snapshots()[0].label, "migration");
        // Second load: already current, no new snapshot.
        s.load().unwrap();
        assert_eq!(s.snapshots().len(), 1);
    }

    #[test]
    fn file_times() {
        assert_eq!(chrono_like(std::time::UNIX_EPOCH), "1970-01-01T00:00:00Z");
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        assert_eq!(chrono_like(t), "2023-11-14T22:13:20Z");
    }
}
