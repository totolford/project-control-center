// AI Engines: types mirroring crates/pcc-ai and src-tauri/src/ai_commands.rs.

export type AiMode = "claude" | "local" | "hybrid";
export type EngineProvider = "claude" | "local" | "hybrid";
export type FallbackPolicy = "ask" | "retry" | "restart" | "switch_to_claude";
export type RuntimeId = "ollama" | "lmstudio" | "llamacpp";

export interface LocalEndpoint {
  /** `ollama`, `lmstudio`, `llamacpp` or `openai` (any OpenAI-compatible server). */
  runtime: string;
  baseUrl: string;
  model: string | null;
}

export interface AiEngineSettings {
  mode: AiMode;
  central: EngineProvider;
  workers: EngineProvider;
  local: LocalEndpoint;
  fallback: FallbackPolicy;
}

export const DEFAULT_AI_SETTINGS: AiEngineSettings = {
  mode: "claude",
  central: "claude",
  workers: "claude",
  local: { runtime: "ollama", baseUrl: "http://127.0.0.1:11434", model: null },
  fallback: "ask",
};

export interface Gpu {
  name: string;
  vendor: string;
  vramMb: number | null;
  vramSource: string;
  driver: string | null;
}

export interface HardwareInfo {
  cpu: string | null;
  cpuCores: number | null;
  cpuThreads: number | null;
  ramTotalMb: number | null;
  ramFreeMb: number | null;
  gpus: Gpu[];
  cuda: string | null;
  vulkan: boolean;
  os: string;
  arch: string;
  modelsDir: string;
  diskFreeMb: number | null;
  diskTotalMb: number | null;
  notes: string[];
}

export type Tier = "light" | "standard" | "advanced" | "heavy";
export type Fit = "gpu" | "partial" | "too_large" | "unknown";

export interface CatalogModel {
  id: string;
  name: string;
  family: string;
  sizeBytes: number;
  context: number;
  tools: boolean;
  vision: boolean;
  thinking: boolean;
  embedding: boolean;
  tier: Tier;
  goodFor: string;
  quality: number;
}

export interface ModelAssessment {
  model: CatalogModel;
  installed: boolean;
  fit: Fit;
  installable: boolean;
  memoryNeededMb: number;
  notes: string[];
}

export interface Recommendation {
  hardware: string;
  recommended: string | null;
  alternative: string | null;
  embedding: string | null;
  explanation: string[];
  models: ModelAssessment[];
}

export interface Health {
  ok: boolean;
  version: string | null;
  latencyMs: number;
  error: string | null;
}

export interface RuntimeStatus {
  id: RuntimeId;
  name: string;
  description: string;
  wingetId: string;
  installed: boolean;
  executable: string | null;
  version: string | null;
  latestVersion: string | null;
  baseUrl: string;
  health: Health;
  managedPid: number | null;
  anthropicApi: boolean;
  notes: string[];
}

export interface LocalModel {
  name: string;
  sizeBytes: number | null;
  parameterSize: string | null;
  quantization: string | null;
  family: string | null;
  loaded: boolean;
  capabilities: string[] | null;
}

export interface LocalCapacity {
  available: boolean;
  runtime: string;
  model: string | null;
  context: number;
  tools: boolean;
  embeddingModel: string | null;
  reason: string | null;
}

export interface AiOverview {
  settings: AiEngineSettings;
  projectOpen: boolean;
  setupAt: string | null;
  setupSkipped: boolean;
  winget: boolean;
  runtimes: RuntimeStatus[];
  models: LocalModel[];
  modelsError: string | null;
  capacity: LocalCapacity;
  modelsDir: string;
  pulling: string[];
}

export interface SetupState {
  setupAt: string | null;
  skipped: boolean;
}

export interface Benchmark {
  model: string;
  tokensPerSecond: number | null;
  completionTokens: number | null;
  totalMs: number;
  sample: string;
}

export interface Validation {
  model: string;
  benchmark: Benchmark;
  capabilities: string[] | null;
  tools: boolean;
  anthropicApi: boolean;
  notes: string[];
}

export interface PullEvent {
  model: string;
  status: string;
  completed: number | null;
  total: number | null;
  percent: number | null;
  done: boolean;
  error: string | null;
}

export type TaskKind =
  | "npc_dialogue"
  | "simulation"
  | "summary"
  | "embedding"
  | "classification"
  | "simple_analysis"
  | "code_edit"
  | "mission_planning"
  | "architecture"
  | "final_review"
  | "agent_session"
  | "other";
export type Level = "low" | "medium" | "high";

export interface RouteRequest {
  task: TaskKind;
  complexity: Level;
  contextTokens: number;
  requiredTools: boolean;
  private: boolean;
  latency: Level;
  cost: Level;
  agentRole: string | null;
  agentKind: "central" | "worker" | null;
}

export interface RouteDecision {
  provider: "claude" | "local" | "unavailable";
  model: string | null;
  reason: string;
  rule: string;
}

export interface RoutingJournalEntry {
  ts: string;
  source: string;
  mode: AiMode;
  request: RouteRequest;
  decision: RouteDecision;
}

export interface TownspeopleReadiness {
  ready: boolean;
  chatModel: string | null;
  embeddingModel: string | null;
  reasons: string[];
  env: [string, string][];
}

export interface TownLocalStatus {
  readiness: TownspeopleReadiness;
  aiTownRunning: boolean;
  townspeople: { count: number; max: number; names: string[] } | null;
  error: string | null;
}
