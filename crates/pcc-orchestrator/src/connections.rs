//! Project connections management (configuration, secrets, health checks).

use serde_json::{json, Value};

use pcc_connections::{github, kinds, secrets};
use pcc_core::{ids, Connection, ConnectionKind, ConnectionStatus, Error, Event, EventKind, Result};

use crate::dto::ConnectionInput;
use crate::engine::Engine;

impl Engine {
    /// Local folder, git and GitHub connections derived from the folder itself.
    pub fn ensure_default_connections(&mut self) -> Result<()> {
        let existing = self.store.list_connections()?;
        let has = |k: ConnectionKind| existing.iter().any(|c| c.kind == k);
        let add = |id: &str, name: &str, kind: ConnectionKind| -> Result<()> {
            let c = Connection {
                id: id.into(),
                name: name.into(),
                kind,
                config: json!({}),
                credential_ref: None,
                status: ConnectionStatus::Unknown,
                status_detail: None,
                last_checked: None,
                created_at: pcc_core::now(),
                enabled: true,
                last_used: None,
            };
            self.store.upsert_connection(&c)?;
            self.emit(Event::new(EventKind::ConnectionChanged, format!("Connection {name} added"), json!(c)));
            Ok(())
        };
        if !has(ConnectionKind::Local) {
            add("local", "Local project", ConnectionKind::Local)?;
        }
        if let Some(repo) = self.repo.clone() {
            if !has(ConnectionKind::Git) {
                add("git", "Git", ConnectionKind::Git)?;
            }
            let remote = repo.status().remote_url;
            if !has(ConnectionKind::Github) && remote.as_deref().and_then(github::parse_repo).is_some() {
                add("github", "GitHub", ConnectionKind::Github)?;
            }
        }
        Ok(())
    }

    fn unique_connection_id(&self, name: &str) -> Result<String> {
        let base = match ids::slugify(name) {
            s if s.is_empty() => "connection".to_string(),
            s => s,
        };
        let existing: Vec<String> = self.store.list_connections()?.into_iter().map(|c| c.id).collect();
        if !existing.contains(&base) && base != crate::launch::PCC_SERVER {
            return Ok(base);
        }
        (2..1000)
            .map(|n| format!("{base}-{n}"))
            .find(|c| !existing.contains(c))
            .ok_or_else(|| Error::invalid("too many connections with this name"))
    }

    pub fn add_connection(&mut self, input: ConnectionInput) -> Result<Connection> {
        if input.name.trim().is_empty() {
            return Err(Error::invalid("a connection needs a name"));
        }
        let config = if input.config.is_null() { json!({}) } else { input.config };
        kinds::validate(input.kind, &config)?;
        let credential_ref = match input.secrets.filter(|s| !s.is_empty()) {
            Some(values) => {
                let r = secrets::new_ref();
                secrets::set(&r, &values)?;
                Some(r)
            }
            None => None,
        };
        let c = Connection {
            id: self.unique_connection_id(&input.name)?,
            name: input.name.trim().into(),
            kind: input.kind,
            config,
            credential_ref,
            status: ConnectionStatus::Unknown,
            status_detail: None,
            last_checked: None,
            created_at: pcc_core::now(),
            enabled: input.enabled.unwrap_or(true),
            last_used: None,
        };
        self.store.upsert_connection(&c)?;
        self.emit(Event::new(EventKind::ConnectionChanged, format!("Connection {} added", c.name), json!(c)));
        Ok(c)
    }

    /// Updates a connection. Secret values replace the stored ones only when provided.
    pub fn update_connection(&mut self, id: &str, input: ConnectionInput) -> Result<Connection> {
        let mut c = self.store.get_connection(id)?.ok_or_else(|| Error::not_found(format!("connection {id}")))?;
        if input.kind != c.kind {
            return Err(Error::invalid("the kind of a connection cannot change; create a new one"));
        }
        let config = if input.config.is_null() { json!({}) } else { input.config };
        kinds::validate(c.kind, &config)?;
        // The last health check stays valid unless the target or its credentials change.
        let changed = c.config != config || input.secrets.as_ref().is_some_and(|s| !s.is_empty());
        if let Some(values) = input.secrets.filter(|s| !s.is_empty()) {
            let r = c.credential_ref.clone().unwrap_or_else(secrets::new_ref);
            let mut merged = secrets::get(&r)?;
            merged.extend(values.into_iter().filter(|(_, v)| !v.is_empty()));
            secrets::set(&r, &merged)?;
            c.credential_ref = Some(r);
        }
        c.name = input.name.trim().to_string();
        c.config = config;
        if let Some(enabled) = input.enabled {
            c.enabled = enabled;
        }
        if changed {
            c.status = ConnectionStatus::Unknown;
            c.status_detail = None;
        }
        self.store.upsert_connection(&c)?;
        self.emit(Event::new(EventKind::ConnectionChanged, format!("Connection {} updated", c.name), json!(c)));
        Ok(c)
    }

    pub fn delete_connection(&mut self, id: &str) -> Result<()> {
        let c = self.store.get_connection(id)?.ok_or_else(|| Error::not_found(format!("connection {id}")))?;
        if let Some(r) = &c.credential_ref {
            secrets::delete(r)?;
        }
        self.store.delete_connection(id)?;
        for mut a in self.store.list_agents()? {
            if a.connections.iter().any(|x| x == id) {
                a.connections.retain(|x| x != id);
                self.save_agent(&mut a)?;
            }
        }
        self.emit(Event::new(
            EventKind::ConnectionChanged,
            format!("Connection {} removed", c.name),
            json!({"id": id, "deleted": true}),
        ));
        Ok(())
    }

    pub fn connection_secret_keys(&self, id: &str) -> Result<Vec<String>> {
        let c = self.store.get_connection(id)?.ok_or_else(|| Error::not_found(format!("connection {id}")))?;
        match &c.credential_ref {
            Some(r) => secrets::keys(r),
            None => Ok(vec![]),
        }
    }

    /// Stores the outcome of a health check computed outside the engine lock.
    pub fn record_check(&mut self, id: &str, result: kinds::CheckResult) -> Result<Connection> {
        let mut c = self.store.get_connection(id)?.ok_or_else(|| Error::not_found(format!("connection {id}")))?;
        c.status = result.status;
        c.status_detail = Some(result.detail);
        c.last_checked = Some(pcc_core::now());
        self.store.upsert_connection(&c)?;
        self.emit(Event::new(
            EventKind::ConnectionChanged,
            format!("{}: {:?}", c.name, c.status).to_lowercase(),
            json!(c),
        ));
        Ok(c)
    }
}

/// Serialized view of a connection for tools (no secret material, ever).
pub(crate) fn public_view(c: &Connection) -> Value {
    json!({"id": c.id, "name": c.name, "kind": c.kind, "status": c.status, "detail": c.status_detail})
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcc_core::EventBus;
    use pcc_store::ProjectStore;
    use std::sync::Arc;

    #[test]
    fn add_update_delete_with_grants() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(ProjectStore::open_ephemeral(tmp.path(), "t").unwrap());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let mut e = Engine::new(store.clone(), EventBus::new(), None, vec![], tx).unwrap();
        e.ensure_default_connections().unwrap();
        assert!(store.get_connection("local").unwrap().is_some());

        let c = e
            .add_connection(ConnectionInput {
                name: "Prod Server".into(),
                kind: ConnectionKind::Ssh,
                config: json!({"host": "10.0.0.5", "user": "admin", "auth": "key"}),
                secrets: None,
                enabled: None,
            })
            .unwrap();
        assert_eq!(c.id, "prod-server");
        let dup = e
            .add_connection(ConnectionInput {
                name: "Prod Server".into(),
                kind: ConnectionKind::Ssh,
                config: json!({"host": "10.0.0.6", "user": "admin", "auth": "key"}),
                secrets: None,
                enabled: None,
            })
            .unwrap();
        assert_eq!(dup.id, "prod-server-2");
        assert!(e
            .add_connection(ConnectionInput {
                name: "Bad".into(),
                kind: ConnectionKind::Ssh,
                config: json!({"host": "", "user": "x"}),
                secrets: None,
                enabled: None,
            })
            .is_err());

        // Toggling keeps the last health check; changing the target resets it.
        e.record_check(
            &c.id,
            pcc_connections::CheckResult { status: ConnectionStatus::Connected, detail: "ok".into() },
        )
        .unwrap();
        let toggled = e
            .update_connection(
                &c.id,
                ConnectionInput {
                    name: c.name.clone(),
                    kind: c.kind,
                    config: c.config.clone(),
                    secrets: None,
                    enabled: Some(false),
                },
            )
            .unwrap();
        assert!(!toggled.enabled);
        assert_eq!(toggled.status, ConnectionStatus::Connected);
        let moved = e
            .update_connection(
                &c.id,
                ConnectionInput {
                    name: c.name.clone(),
                    kind: c.kind,
                    config: json!({"host": "10.0.0.9", "user": "admin", "auth": "key"}),
                    secrets: None,
                    enabled: None,
                },
            )
            .unwrap();
        assert_eq!(moved.status, ConnectionStatus::Unknown);
        assert!(!moved.enabled, "enabled kept when not provided");

        let agent = e
            .create_agent(
                crate::dto::AgentSpec {
                    name: "Ops".into(),
                    role: "ops".into(),
                    connections: Some(vec!["prod-server".into()]),
                    ..Default::default()
                },
                "user",
            )
            .unwrap();
        assert_eq!(agent.connections, vec!["prod-server"]);
        e.delete_connection("prod-server").unwrap();
        assert!(store.agent("ops").unwrap().connections.is_empty());
        assert_eq!(public_view(&dup)["id"], "prod-server-2");
    }
}
