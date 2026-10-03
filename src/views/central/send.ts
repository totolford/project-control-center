// Sending what the user types to an agent's real session.

import { api } from "../../lib/api";
import { run } from "../../lib/toast";
import { useStore } from "../../store";

/**
 * Delivers a user message to an agent (the backend starts its session if needed), then shows the
 * line as a speech bubble in AI Town. The bubble is best effort: AI Town may not be running.
 */
export async function sendToAgent(agentId: string, body: string): Promise<boolean> {
  const ok = await run(async () => useStore.getState().addMessage(await api.sendMessage(agentId, body)));
  if (ok) void api.aiTownSay(agentId, body).catch(() => undefined);
  return ok;
}
