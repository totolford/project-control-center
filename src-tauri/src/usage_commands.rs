//! AI usage records and their aggregation. One-to-one with `src/lib/api.ts`.

use serde::Serialize;
use tauri::State;

use pcc_core::usage::{self, Price, UsageRecord, UsageSummary};
use pcc_core::Error;
use pcc_store::UsageFilter;

use crate::state::AppState;

type CmdResult<T> = Result<T, Error>;

/// Aggregated usage of the records matching `filter`; days are bucketed in the
/// viewer's time zone (`tz_offset_minutes` east of UTC).
#[tauri::command]
pub async fn usage_summary(
    state: State<'_, AppState>,
    filter: UsageFilter,
    tz_offset_minutes: i32,
) -> CmdResult<UsageSummary> {
    let store = state.orch().await?.store.clone();
    let records = tokio::task::spawn_blocking(move || store.usage(&filter))
        .await
        .map_err(|e| Error::Process(e.to_string()))??;
    Ok(usage::summarize(&records, tz_offset_minutes))
}

/// Raw records, newest last (`filter.limit` most recent).
#[tauri::command]
pub async fn usage_records(state: State<'_, AppState>, filter: UsageFilter) -> CmdResult<Vec<UsageRecord>> {
    state.orch().await?.store.usage(&filter)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceTable {
    pub source: &'static str,
    pub avoided_reference_model: &'static str,
    pub prices: &'static [Price],
}

#[tauri::command]
pub fn usage_prices() -> PriceTable {
    PriceTable {
        source: usage::PRICE_SOURCE,
        avoided_reference_model: usage::AVOIDED_REFERENCE_MODEL,
        prices: usage::PRICES,
    }
}
