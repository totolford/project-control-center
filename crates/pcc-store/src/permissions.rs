//! Persistent permission requests (`permissions` table). Every state change
//! of a request is written here before it is announced.

use rusqlite::params;

use crate::db::storage;
use crate::store::ProjectStore;
use pcc_core::{PermissionKind, PermissionRecord, PermissionStatus, Result};

impl ProjectStore {
    pub fn upsert_permission(&self, r: &PermissionRecord) -> Result<()> {
        self.writable()?;
        self.db()
            .execute(
                "INSERT INTO permissions(id, status, agent_id, tool_name, mission_id, created_at, updated_at, expires_at, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET status = excluded.status, mission_id = excluded.mission_id,
                   updated_at = excluded.updated_at, expires_at = excluded.expires_at, data = excluded.data",
                params![
                    r.id,
                    r.status.as_str(),
                    r.agent_id,
                    r.tool_name,
                    r.mission_id,
                    r.created_at,
                    r.updated_at,
                    r.expires_at,
                    serde_json::to_string(r)?
                ],
            )
            .map_err(storage)?;
        Ok(())
    }

    pub fn get_permission(&self, id: &str) -> Result<Option<PermissionRecord>> {
        Ok(self.query_permissions("WHERE id = ?1", &[&id])?.into_iter().next())
    }

    /// Requests still waiting for a decision, oldest first.
    pub fn open_permissions(&self) -> Result<Vec<PermissionRecord>> {
        self.query_permissions("WHERE status IN ('pending', 'recovered') ORDER BY created_at, id", &[])
    }

    /// Newest first; `agent`/`status` narrow the list.
    pub fn list_permissions(
        &self,
        agent: Option<&str>,
        status: Option<PermissionStatus>,
        limit: u32,
    ) -> Result<Vec<PermissionRecord>> {
        let status = status.map(|s| s.as_str());
        self.query_permissions(
            "WHERE (?1 IS NULL OR agent_id = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY created_at DESC, id DESC LIMIT ?3",
            &[&agent, &status, &limit.clamp(1, 2000)],
        )
    }

    /// Most recent tool request of `agent` lost with its session, for the same
    /// tool and input, created at or after `since`: the one a new identical
    /// request should be re-linked to.
    pub fn find_lost_permission(
        &self,
        agent: &str,
        tool: &str,
        input: &serde_json::Value,
        since: &str,
    ) -> Result<Option<PermissionRecord>> {
        Ok(self
            .query_permissions(
                "WHERE agent_id = ?1 AND tool_name = ?2 AND status = 'lost' AND created_at >= ?3 ORDER BY updated_at DESC",
                &[&agent, &tool, &since],
            )?
            .into_iter()
            .find(|r| r.kind == PermissionKind::Tool && r.same_action(agent, tool, input)))
    }

    fn query_permissions(&self, clause: &str, p: &[&dyn rusqlite::ToSql]) -> Result<Vec<PermissionRecord>> {
        let sql = format!("SELECT data FROM permissions {clause}");
        let c = self.db();
        let mut stmt = c.prepare(&sql).map_err(storage)?;
        let rows = stmt.query_map(p, |r| r.get::<_, String>(0)).map_err(storage)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row.map_err(storage)?)?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcc_core::PermissionRequest;
    use serde_json::json;

    fn rec(id: &str, input: serde_json::Value) -> PermissionRecord {
        PermissionRecord::new(
            PermissionRequest {
                id: id.into(),
                agent_id: "ops".into(),
                tool_name: "Bash".into(),
                capability: "shell".into(),
                summary: "Bash".into(),
                input,
                reason: String::new(),
                rule_key: "Bash:rm".into(),
                created_at: pcc_core::now(),
            },
            PermissionKind::Tool,
        )
    }

    #[test]
    fn records_survive_reopen_and_lost_ones_are_found() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let s = ProjectStore::create(tmp.path(), "P").unwrap();
            s.upsert_permission(&rec("perm-a", json!({"command": "rm -rf build"}))).unwrap();
            let mut b = rec("perm-b", json!({"command": "rm -rf dist"}));
            b.status = PermissionStatus::Lost;
            s.upsert_permission(&b).unwrap();
        }
        let s = ProjectStore::open(tmp.path()).unwrap();
        let open = s.open_permissions().unwrap();
        assert_eq!(open.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["perm-a"]);
        let lost = s.find_lost_permission("ops", "Bash", &json!({"command": "rm -rf dist"}), "2000-01-01").unwrap();
        assert_eq!(lost.unwrap().id, "perm-b");
        assert!(s.find_lost_permission("ops", "Bash", &json!({"command": "ls"}), "2000-01-01").unwrap().is_none());
        assert!(s.find_lost_permission("ops", "Bash", &json!({"command": "rm -rf dist"}), "2999").unwrap().is_none());

        let mut a = s.get_permission("perm-a").unwrap().unwrap();
        a.status = PermissionStatus::Consumed;
        s.upsert_permission(&a).unwrap();
        assert!(s.open_permissions().unwrap().is_empty());
        assert_eq!(s.list_permissions(Some("ops"), Some(PermissionStatus::Consumed), 10).unwrap().len(), 1);
        assert_eq!(s.list_permissions(None, None, 10).unwrap().len(), 2);
    }
}
