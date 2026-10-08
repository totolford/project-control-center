// AI usage records and summaries (crates/pcc-core/src/usage.rs).

export type UsageCategory =
  | "ai_world"
  | "agent_conversation"
  | "production_agent"
  | "central_agent"
  | "background_agent"
  | "embedding";

export type CostSource = "reported" | "estimated" | "local" | "unknown";

export interface UsageRecord {
  id: number;
  ts: string;
  provider: string;
  model: string | null;
  agentId: string | null;
  missionId: string | null;
  taskId: string | null;
  category: UsageCategory;
  source: string;
  /** null = not exposed by the provider (shown "N/A"). */
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  cacheCreationTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  costSource: CostSource;
  latencyMs: number | null;
  local: boolean;
  routeRule: string | null;
}

export interface UsageFilter {
  /** RFC 3339 UTC. */
  since?: string | null;
  until?: string | null;
  agent?: string | null;
  mission?: string | null;
  limit?: number | null;
}

export interface UsageGroup {
  key: string;
  requests: number;
  tokens: number;
  claudeTokens: number;
  localTokens: number;
  costUsd: number;
}

export interface UsageDay {
  day: string;
  requests: number;
  claudeRequests: number;
  localRequests: number;
  claudeTokens: number;
  localTokens: number;
  costUsd: number;
}

export interface AvoidedEstimate {
  label: string;
  tokens: number;
  moneyUsd: number;
  requests: number;
  referenceModel: string;
  method: string;
  priceSource: string;
}

export interface UsageSummary {
  requests: number;
  claudeRequests: number;
  localRequests: number;
  claudeTokens: number;
  localTokens: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requestsWithoutTokens: number;
  claudeCostReportedUsd: number;
  cloudCostEstimatedUsd: number;
  cloudRequestsWithoutCost: number;
  localCostUsd: number;
  avoided: AvoidedEstimate;
  avgLatencyMs: number | null;
  localShare: number | null;
  days: UsageDay[];
  byAgent: UsageGroup[];
  byMission: UsageGroup[];
  byModel: UsageGroup[];
  byCategory: UsageGroup[];
  priceSource: string;
}

export interface Price {
  pattern: string;
  label: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface PriceTable {
  source: string;
  avoidedReferenceModel: string;
  prices: Price[];
}
