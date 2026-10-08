//! AI usage records (the AI Usage page, per-mission and per-agent usage).

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::storage;
use crate::store::ProjectStore;
use pcc_core::usage::{CostSource, UsageCategory, UsageRecord};
use pcc_core::Result;

/// Filters of the usage records. Every field is optional.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageFilter {
    /// Records at or after this RFC 3339 UTC timestamp.
    pub since: Option<String>,
    /// Records before this RFC 3339 UTC timestamp.
    pub until: Option<String>,
    pub agent: Option<String>,
    pub mission: Option<String>,
    /// Default 100 000 (aggregation reads whole periods).
    pub limit: Option<u32>,
}

fn opt_u(v: Option<u64>) -> Option<i64> {
    v.map(|n| n.min(i64::MAX as u64) as i64)
}

impl ProjectStore {
    pub fn insert_usage(&self, r: &mut UsageRecord) -> Result<()> {
        self.writable()?;
        if r.ts.is_empty() {
            r.ts = pcc_core::now();
        }
        let c = self.db();
        c.execute(
            "INSERT INTO usage(ts, provider, model, agent_id, mission_id, task_id, category, source,
                input_tokens, output_tokens, total_tokens, cached_tokens, cache_creation_tokens, reasoning_tokens,
                cost_usd, cost_source, latency_ms, local, route_rule)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            params![
                r.ts,
                r.provider,
                r.model,
                r.agent_id,
                r.mission_id,
                r.task_id,
                r.category.as_str(),
                r.source,
                opt_u(r.input_tokens),
                opt_u(r.output_tokens),
                opt_u(r.total_tokens),
                opt_u(r.cached_tokens),
                opt_u(r.cache_creation_tokens),
                opt_u(r.reasoning_tokens),
                r.cost_usd,
                r.cost_source.as_str(),
                opt_u(r.latency_ms),
                r.local,
                r.route_rule,
            ],
        )
        .map_err(storage)?;
        r.id = c.last_insert_rowid();
        Ok(())
    }

    /// Oldest first.
    pub fn usage(&self, f: &UsageFilter) -> Result<Vec<UsageRecord>> {
        let limit = f.limit.unwrap_or(100_000).clamp(1, 1_000_000);
        let c = self.db();
        let mut stmt = c
            .prepare(
                "SELECT id, ts, provider, model, agent_id, mission_id, task_id, category, source,
                    input_tokens, output_tokens, total_tokens, cached_tokens, cache_creation_tokens, reasoning_tokens,
                    cost_usd, cost_source, latency_ms, local, route_rule
                 FROM (SELECT * FROM usage
                     WHERE (?1 IS NULL OR ts >= ?1) AND (?2 IS NULL OR ts < ?2)
                       AND (?3 IS NULL OR agent_id = ?3) AND (?4 IS NULL OR mission_id = ?4)
                     ORDER BY id DESC LIMIT ?5)
                 ORDER BY id",
            )
            .map_err(storage)?;
        let u = |r: &rusqlite::Row<'_>, i: usize| r.get::<_, Option<i64>>(i).map(|v| v.map(|n| n.max(0) as u64));
        let rows = stmt
            .query_map(params![f.since, f.until, f.agent, f.mission, limit], |r| {
                Ok(UsageRecord {
                    id: r.get(0)?,
                    ts: r.get(1)?,
                    provider: r.get(2)?,
                    model: r.get(3)?,
                    agent_id: r.get(4)?,
                    mission_id: r.get(5)?,
                    task_id: r.get(6)?,
                    category: UsageCategory::parse(&r.get::<_, String>(7)?),
                    source: r.get(8)?,
                    input_tokens: u(r, 9)?,
                    output_tokens: u(r, 10)?,
                    total_tokens: u(r, 11)?,
                    cached_tokens: u(r, 12)?,
                    cache_creation_tokens: u(r, 13)?,
                    reasoning_tokens: u(r, 14)?,
                    cost_usd: r.get(15)?,
                    cost_source: CostSource::parse(&r.get::<_, String>(16)?),
                    latency_ms: u(r, 17)?,
                    local: r.get(18)?,
                    route_rule: r.get(19)?,
                })
            })
            .map_err(storage)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_roundtrip_and_filters() {
        let tmp = tempfile::tempdir().unwrap();
        let s = ProjectStore::create(tmp.path(), "U").unwrap();
        let mut a = UsageRecord::new("claude", UsageCategory::CentralAgent, "session")
            .tokens(Some(10), Some(20), Some(300), None)
            .with_cost(Some(0.01))
            .agent(Some("central"), None, None);
        a.model = Some("claude-opus-5-5".into());
        a.ts = "2026-10-06T10:00:00.000Z".into();
        s.insert_usage(&mut a).unwrap();
        assert!(a.id > 0);
        let mut b = UsageRecord::new("ollama", UsageCategory::ProductionAgent, "session")
            .tokens(Some(5), None, None, None)
            .local_run()
            .agent(Some("dev"), Some("M-0001"), Some("T-0001"));
        b.route_rule = Some("agent-session-local".into());
        b.ts = "2026-10-07T10:00:00.000Z".into();
        s.insert_usage(&mut b).unwrap();

        let all = s.usage(&UsageFilter::default()).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0], a);
        assert_eq!(all[1], b);
        assert_eq!(all[1].output_tokens, None);
        let since = s.usage(&UsageFilter { since: Some("2026-10-07T00:00:00.000Z".into()), ..Default::default() });
        assert_eq!(since.unwrap().len(), 1);
        let m = s.usage(&UsageFilter { mission: Some("M-0001".into()), ..Default::default() }).unwrap();
        assert_eq!(m[0].task_id.as_deref(), Some("T-0001"));
        let ag = s.usage(&UsageFilter { agent: Some("central".into()), ..Default::default() }).unwrap();
        assert_eq!(ag.len(), 1);
        let last = s.usage(&UsageFilter { limit: Some(1), ..Default::default() }).unwrap();
        assert_eq!(last[0].id, b.id);
    }
}
