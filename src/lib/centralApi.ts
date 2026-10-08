// Typed wrappers over the Central commands (src-tauri/src/central_commands.rs).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type * as C from "./centralTypes";

export const AI_CAPABILITY_CHANNEL = "pcc://ai-capability";

export const centralApi = {
  state: () => invoke<C.CentralState>("central_state"),
  /** Verified state of a mission (read-only); the running / interrupted one by default. */
  resumeReport: (missionId?: string) => invoke<C.ResumeReport>("central_resume_report", { missionId: missionId ?? null }),
  /** Resume now: sessions brought back, Central briefed with the verified report. */
  resume: (missionId?: string) => invoke<C.ResumeReport>("central_resume", { missionId: missionId ?? null }),
  dismissAutoResume: () => invoke<void>("central_dismiss_auto_resume"),
  capabilityReports: () => invoke<C.CapabilityReport[]>("ai_capability_reports"),
  /** Runs the six tests for real against the configured runtime (installed models only). */
  capabilityTest: (model: string) => invoke<C.CapabilityReport>("ai_capability_test", { model }),
};

export function onCapability(cb: (p: { model: string; result: C.CapabilityResult }) => void): Promise<UnlistenFn> {
  return listen<{ model: string; result: C.CapabilityResult }>(AI_CAPABILITY_CHANNEL, (e) => cb(e.payload));
}
