import { useState } from "react";
import { Spinner } from "../../components/Common";
import { Modal } from "../../components/Modal";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { attempt, toast } from "../../lib/toast";
import type { World } from "../../lib/types";
import { sortAgents, useAgents } from "../../store";
import { addAgentCharacter, agentsWithoutCharacter } from "./characters";

/** NEXUS Agent → AI Character: same mapping as the wizard (api.worldCharactersFromAgents), then saved. */
export function AddCharacterDialog({ world, onClose, onSaved }: { world: World; onClose: () => void; onSaved: (w: World) => void }) {
  const agents = useAgents();
  const candidates = sortAgents(agentsWithoutCharacter(agents, world.characters));
  const [busy, setBusy] = useState<string | null>(null);

  const convert = async (agentId: string): Promise<World | undefined> => {
    const mapped = await attempt(() => api.worldCharactersFromAgents());
    if (!mapped) return undefined;
    // Latest world: positions keep moving while the dialog is open.
    const latest = (await attempt(() => api.worldGet())) ?? world;
    const next = addAgentCharacter(latest, mapped, agentId);
    if (!next) {
      toast.info("This agent cannot be converted (retired or removed).");
      return undefined;
    }
    return attempt(() => api.worldSave(next), "Character added");
  };

  const add = async (agentId: string) => {
    setBusy(agentId);
    const saved = await convert(agentId);
    setBusy(null);
    if (saved) {
      onSaved(saved);
      onClose();
    }
  };

  return (
    <Modal title="Add character from agent" onClose={onClose} locked={busy !== null}>
      {candidates.length === 0 ? (
        <div className="small muted">Every active NEXUS agent already has a character in this world.</div>
      ) : (
        <>
          <div className="small muted world-gap">
            The character is linked to the agent: in Hybrid / Real execution it mirrors the agent’s real state.
          </div>
          <div className="stack">
            {candidates.map((a) => (
              <button key={a.id} className="list-item" disabled={busy !== null} onClick={() => void add(a.id)}>
                <span>
                  <strong>{a.name}</strong> <span className="muted small">{a.role}</span>
                </span>
                {busy === a.id ? <Spinner size={12} /> : <StatusBadge status={a.status} />}
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
