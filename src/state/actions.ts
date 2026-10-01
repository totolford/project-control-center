// Backend actions shared by several views: each calls the real API and folds the result into the store.

import { api } from "../lib/api";
import { POWER_LABEL } from "../lib/power";
import { attempt, toast } from "../lib/toast";
import type { Agent, AgentPatch, PowerLevel, ProjectSettings } from "../lib/types";
import { useStore } from "../store";

/** Saves the whole ProjectSettings after applying `fn` to the current settings. */
export async function saveSettingsWith(fn: (s: ProjectSettings) => ProjectSettings, successText?: string): Promise<ProjectSettings | undefined> {
  const current = useStore.getState().project?.settings;
  if (!current) return undefined;
  const saved = await attempt(() => api.saveSettings(fn(current)), successText);
  if (saved) useStore.getState().setSettings(saved);
  return saved;
}

export async function patchAgent(id: string, patch: AgentPatch, successText?: string): Promise<Agent | undefined> {
  const updated = await attempt(() => api.updateAgent(id, patch), successText);
  if (updated) useStore.getState().upsertAgent(updated);
  return updated;
}

export async function applyPower(agent: Pick<Agent, "id" | "name">, level: PowerLevel): Promise<void> {
  const updated = await attempt(() => api.applyPower(agent.id, level), `${agent.name}: power ${POWER_LABEL[level]}`);
  if (updated) useStore.getState().upsertAgent(updated);
}

/** Switches an agent's model; tells whether the running session switched or it applies at next start. */
export async function setAgentModel(agent: Pick<Agent, "id" | "name">, model: string | null): Promise<boolean | undefined> {
  const live = await attempt(() => api.setAgentModel(agent.id, model));
  if (live === undefined) return undefined;
  toast.success(`${agent.name}: ${model ?? "default"} — ${live ? "switched live" : "applies at next session start"}`);
  void useStore.getState().refresh().catch(() => undefined);
  return live;
}
