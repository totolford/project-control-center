//! Client-supplied idempotency keys: a double submit (double click, retried
//! IPC call after a renderer restart) returns the first result.

use pcc_core::{Mission, Result};

use crate::engine::Engine;

fn mission_key(key: &str) -> String {
    format!("mission:{key}")
}

impl Engine {
    /// The mission created earlier with this key, if any.
    pub(crate) fn replayed_mission(&self, key: Option<&str>) -> Result<Option<Mission>> {
        let Some(key) = key.map(str::trim).filter(|k| !k.is_empty()) else { return Ok(None) };
        match self.store.idempotency_get(&mission_key(key))? {
            Some(id) => self.store.get_mission(&id),
            None => Ok(None),
        }
    }

    pub(crate) fn remember_mission(&self, key: Option<&str>, id: &str) -> Result<()> {
        match key.map(str::trim).filter(|k| !k.is_empty()) {
            Some(key) => self.store.idempotency_put(&mission_key(key), "mission", id),
            None => Ok(()),
        }
    }
}
