// Typed wrappers over the AI usage commands (src-tauri/src/usage_commands.rs).

import { invoke } from "@tauri-apps/api/core";
import type * as U from "./usageTypes";

export const usageApi = {
  /** `tzOffsetMinutes`: the viewer's offset east of UTC, for day buckets. */
  summary: (filter: U.UsageFilter, tzOffsetMinutes: number) =>
    invoke<U.UsageSummary>("usage_summary", { filter, tzOffsetMinutes }),
  records: (filter: U.UsageFilter) => invoke<U.UsageRecord[]>("usage_records", { filter }),
  prices: () => invoke<U.PriceTable>("usage_prices"),
};
