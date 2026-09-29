import { useState } from "react";
import { ArrowRight, Send } from "lucide-react";
import { api } from "../lib/api";
import { attempt, run } from "../lib/toast";
import { useAgent, useMissions, useStore } from "../store";
import { Spinner } from "../components/Common";
import { Segmented } from "../components/Tabs";

type Mode = "mission" | "central";

/** "What do you want to build?" → createMission; or, during a mission, a message to Central. */
export function MissionComposer() {
  const missions = useMissions();
  const central = useAgent("central");
  const upsertMission = useStore((s) => s.upsertMission);
  const addMessage = useStore((s) => s.addMessage);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>("mission");
  const [busy, setBusy] = useState(false);
  const active = missions.some((m) => m.status === "active" || m.status === "planning");
  const effective: Mode = active && central ? mode : "mission";

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    let ok: boolean;
    if (effective === "mission") {
      const mission = await attempt(() => api.createMission(body), "Mission sent to Central");
      if (mission) upsertMission(mission);
      ok = mission !== undefined;
    } else {
      ok = await run(async () => addMessage(await api.sendMessage("central", body)), "Message sent to Central");
    }
    setBusy(false);
    if (ok) setText("");
  };

  return (
    <div className="composer-bar">
      {active && central && (
        <Segmented
          options={[
            { value: "mission", label: "New mission" },
            { value: "central", label: "Message Central" },
          ]}
          value={mode}
          onChange={setMode}
          label="Composer mode"
        />
      )}
      <textarea
        className="composer-input"
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={effective === "mission" ? "What do you want to build?" : "Message Central…"}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        aria-label={effective === "mission" ? "Mission prompt" : "Message to Central"}
      />
      <span className="muted small composer-hint">Ctrl+Enter</span>
      <button className="btn primary" onClick={() => void submit()} disabled={busy || !text.trim()}>
        {busy ? <Spinner size={12} /> : effective === "mission" ? <ArrowRight size={13} /> : <Send size={13} />}
        {effective === "mission" ? "Start mission" : "Send"}
      </button>
    </div>
  );
}
