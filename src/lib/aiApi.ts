// Typed wrappers over the AI Engines commands (src-tauri/src/ai_commands.rs).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type * as A from "./aiTypes";

export const AI_PULL_CHANNEL = "pcc://ai-pull";

export const aiApi = {
  settings: () => invoke<A.AiEngineSettings>("ai_settings"),
  /** Saves for the open project (if any) and as the application default. */
  saveSettings: (settings: A.AiEngineSettings) => invoke<A.AiEngineSettings>("ai_save_settings", { settings }),
  setupState: () => invoke<A.SetupState>("ai_setup_state"),
  completeSetup: (skipped: boolean) => invoke<A.SetupState>("ai_complete_setup", { skipped }),
  hardware: (refresh = false) => invoke<A.HardwareInfo>("ai_hardware", { refresh }),
  recommend: (refresh = false) => invoke<A.Recommendation>("ai_recommend", { refresh }),
  overview: () => invoke<A.AiOverview>("ai_overview"),
  /** The exact winget command, shown before the user confirms. */
  runtimeCommand: (runtime: string, action: string) => invoke<string>("ai_runtime_command", { runtime, action }),
  runtimeWinget: (runtime: string, action: string) => invoke<string>("ai_runtime_winget", { runtime, action }),
  runtimeLatest: (runtime: string) => invoke<string | null>("ai_runtime_latest", { runtime }),
  runtimeStart: (runtime: string, modelPath?: string) =>
    invoke<A.Health>("ai_runtime_start", { runtime, baseUrl: null, modelPath: modelPath ?? null }),
  runtimeStop: (runtime: string) => invoke<string>("ai_runtime_stop", { runtime }),
  runtimeRestart: (runtime: string, modelPath?: string) =>
    invoke<A.Health>("ai_runtime_restart", { runtime, baseUrl: null, modelPath: modelPath ?? null }),
  models: () => invoke<A.LocalModel[]>("ai_models"),
  /** Resolves when the download ends; progress arrives on `onPull`. */
  pullModel: (model: string) => invoke<void>("ai_pull_model", { model }),
  cancelPull: (model: string) => invoke<boolean>("ai_cancel_pull", { model }),
  deleteModel: (model: string) => invoke<void>("ai_delete_model", { model }),
  loadModel: (model: string, load: boolean) => invoke<void>("ai_load_model", { model, load }),
  benchmark: (model: string) => invoke<A.Benchmark>("ai_benchmark", { model }),
  validate: (model: string) => invoke<A.Validation>("ai_validate", { model }),
  routePreview: (request: A.RouteRequest) => invoke<A.RouteDecision>("ai_route_preview", { request }),
  routingJournal: (limit = 100) => invoke<A.RoutingJournalEntry[]>("ai_routing_journal", { limit }),
  /** "Local AI unavailable" actions. */
  fallback: (action: "retry" | "restart" | "switch_to_claude") => invoke<A.LocalCapacity>("ai_fallback", { action }),
  townStatus: () => invoke<A.TownLocalStatus>("ai_town_local_status"),
  addTownspeople: (count: number) => invoke<{ created: number }>("ai_town_add_townspeople", { count }),
  removeTownspeople: () => invoke<void>("ai_town_remove_townspeople"),
};

export function onPull(cb: (p: A.PullEvent) => void): Promise<UnlistenFn> {
  return listen<A.PullEvent>(AI_PULL_CHANNEL, (e) => cb(e.payload));
}
