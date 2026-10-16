// Token saver logic mirrored from the engine (crates/pcc-orchestrator/src/token_saver.rs).

import type { Agent, TokenSaverSettings } from "../../lib/types";

export const DEFAULT_TOKEN_SAVER: TokenSaverSettings = { lazyWake: true, freshSessionAboveTokens: 60_000 };

/** What the agent's next session start does: resume its conversation, start fresh with a brief, or start new. */
export function nextStart(a: Pick<Agent, "claudeSessionId" | "contextTokens">, s: TokenSaverSettings): "resume" | "fresh" | "new" {
  if (!a.claudeSessionId) return "new";
  const limit = s.freshSessionAboveTokens;
  if (limit > 0 && (a.contextTokens ?? 0) > limit) return "fresh";
  return "resume";
}

/** Workers (not Central) whose model is an Opus model. */
export function opusWorkers(agents: Pick<Agent, "kind" | "model" | "status">[]): number {
  return agents.filter((a) => a.kind === "worker" && a.status !== "retired" && /opus/i.test(a.model ?? "")).length;
}
