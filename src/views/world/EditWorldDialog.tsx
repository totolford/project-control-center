import { useState } from "react";
import { Spinner } from "../../components/Common";
import { Modal } from "../../components/Modal";
import { Tabs } from "../../components/Tabs";
import { api } from "../../lib/api";
import { attempt } from "../../lib/toast";
import type { World } from "../../lib/types";
import { useAgents } from "../../store";
import { CharacterEditor } from "./CharacterEditor";
import { ConversationSettings, type ConversationFields } from "./ConversationSettings";
import { StepWorld, type WorldFields } from "./wizard/StepWorld";
import { validateStep, initialWizard } from "./wizard";

type Tab = "world" | "characters";

/** "Edit world": wizard steps 2 and 4 on the existing world, saved with api.worldSave. */
export function EditWorldDialog({ world, onClose, onSaved }: { world: World; onClose: () => void; onSaved: (w: World) => void }) {
  const agents = useAgents();
  const [tab, setTab] = useState<Tab>("world");
  const [fields, setFields] = useState<WorldFields>({
    name: world.name,
    description: world.description,
    environment: world.settings.environment,
    rules: world.settings.rules,
    speed: world.settings.speed,
    mode: world.mode,
  });
  const [talk, setTalk] = useState<ConversationFields>({
    llmConversations: world.settings.llmConversations,
    maxConversationsPerHour: world.settings.maxConversationsPerHour,
    conversationModel: world.settings.conversationModel,
  });
  const [characters, setCharacters] = useState(world.characters);
  const [busy, setBusy] = useState(false);

  const draft = { ...initialWizard(""), ...fields, characters };
  const errors = [...validateStep("world", draft).errors, ...validateStep("characters", draft).errors];

  const save = async () => {
    setBusy(true);
    // Latest world (positions keep moving while the dialog is open) with the edits applied.
    const latest = (await attempt(() => api.worldGet())) ?? world;
    const positions = new Map(latest.characters.map((c) => [c.id, c]));
    const next: World = {
      ...latest,
      name: fields.name.trim(),
      description: fields.description.trim(),
      mode: fields.mode,
      settings: {
        ...latest.settings,
        ...talk,
        environment: fields.environment.trim(),
        rules: fields.rules.map((r) => r.trim()).filter(Boolean),
        speed: fields.speed,
      },
      characters: characters.map((c) => {
        const live = positions.get(c.id);
        return live ? { ...c, x: live.x, y: live.y, room: live.room, targetRoom: live.targetRoom, activity: live.activity } : c;
      }),
    };
    const saved = await attempt(() => api.worldSave(next), "World saved");
    setBusy(false);
    if (saved) {
      onSaved(saved);
      onClose();
    }
  };

  return (
    <Modal
      title={`Edit world — ${world.name}`}
      onClose={onClose}
      width={tab === "characters" ? 860 : 640}
      locked={busy}
      className="world-modal"
      footer={
        <>
          {errors.length > 0 && <span className="tiny tone-red-fg grow">{errors[0]}</span>}
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || errors.length > 0} onClick={() => void save()}>
            {busy && <Spinner size={12} />} Save
          </button>
        </>
      }
    >
      <Tabs
        tabs={[
          { key: "world", label: "World" },
          { key: "characters", label: `Characters (${characters.length})` },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div className="world-gap">
        {tab === "world" ? (
          <>
            <StepWorld state={fields} set={setFields} />
            <ConversationSettings value={talk} onChange={setTalk} />
          </>
        ) : (
          <CharacterEditor characters={characters} onChange={setCharacters} agents={agents} />
        )}
      </div>
    </Modal>
  );
}
