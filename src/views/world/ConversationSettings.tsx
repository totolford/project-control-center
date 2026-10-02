import { Field } from "../../components/Common";
import type { WorldSettings } from "../../lib/types";

export type ConversationFields = Pick<WorldSettings, "llmConversations" | "maxConversationsPerHour" | "conversationModel">;

const MODELS = ["haiku", "sonnet", "opus"];
export const MAX_PER_HOUR = 60;

/** Automatic Claude-generated conversations (Simulation mode): each one is a real, billed call. */
export function ConversationSettings({ value, onChange }: { value: ConversationFields; onChange: (v: ConversationFields) => void }) {
  const models = MODELS.includes(value.conversationModel) ? MODELS : [...MODELS, value.conversationModel];
  return (
    <div className="world-step">
      <div className="section-label">Automatic conversations</div>
      <label className="checkbox">
        <input type="checkbox" checked={value.llmConversations} onChange={(e) => onChange({ ...value, llmConversations: e.target.checked })} />
        Let characters talk on their own in Simulation mode
      </label>
      <div className="notice notice-warn tiny">
        Each conversation is one real Claude call ({value.conversationModel}), billed to your account — up to{" "}
        {value.maxConversationsPerHour} per hour while the world runs. Conversations are simulated: written by Claude, not said by your agents.
      </div>
      <div className="form-row">
        <Field label="Max conversations per hour">
          <input
            type="number"
            min={1}
            max={MAX_PER_HOUR}
            value={value.maxConversationsPerHour}
            disabled={!value.llmConversations}
            onChange={(e) => onChange({ ...value, maxConversationsPerHour: Math.min(MAX_PER_HOUR, Math.max(1, Math.round(Number(e.target.value)) || 1)) })}
          />
        </Field>
        <Field label="Conversation model" hint="Also used by “Talk with…”.">
          <select value={value.conversationModel} onChange={(e) => onChange({ ...value, conversationModel: e.target.value })}>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </div>
  );
}
