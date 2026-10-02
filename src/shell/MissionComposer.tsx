import { useState } from "react";
import { Play, ScanSearch, Send } from "lucide-react";
import { api } from "../lib/api";
import { attempt, run } from "../lib/toast";
import type { Interpretation } from "../lib/types";
import { useUi, type ComposerMode } from "../state/ui";
import { missionForCentral } from "../state/opsActions";
import { useAgent, useMissions, useReadOnly, useStore } from "../store";
import { Spinner } from "../components/Common";
import { Segmented } from "../components/Tabs";
import { CommandCard } from "./command/CommandCard";

const COPY: Record<ComposerMode, { label: string; placeholder: string; button: string }> = {
  mission: {
    label: "What do you want to accomplish?",
    placeholder: "Connect to my Pi, inspect the project, update the server and then test it.",
    button: "RUN",
  },
  central: { label: "Message Central", placeholder: "Message Central…", button: "Send" },
  command: {
    label: "Paste a command line — NEXUS explains it before anything runs",
    placeholder: "claude mcp add …   ssh pi@raspberrypi.local   git clone …   gh auth login",
    button: "Interpret",
  },
};

/** Hero composer: a mission for Central (RUN), a message to Central, or a command line to interpret. */
export function MissionComposer() {
  const missions = useMissions();
  const central = useAgent("central");
  const readOnly = useReadOnly();
  const addMessage = useStore((s) => s.addMessage);
  const mode = useUi((s) => s.composerMode);
  const setMode = useUi((s) => s.setComposerMode);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [interp, setInterp] = useState<Interpretation | null>(null);
  const canMessage = Boolean(central) && missions.some((m) => m.status === "active" || m.status === "planning");
  const effective: ComposerMode = mode === "central" && !canMessage ? "mission" : mode;
  const copy = COPY[effective];
  // Interpreting reads nothing from the project; missions and messages are refused in compatibility mode.
  const blocked = readOnly && effective !== "command";

  const submit = async () => {
    const body = text.trim();
    if (!body || busy || blocked) return;
    setBusy(true);
    if (effective === "command") {
      const result = await attempt(() => api.interpretCommand(body));
      if (result) setInterp(result);
    } else if (effective === "mission") {
      if (await missionForCentral(body)) setText("");
    } else if (await run(async () => addMessage(await api.sendMessage("central", body)), "Message sent to Central")) {
      setText("");
    }
    setBusy(false);
  };

  const options: { value: ComposerMode; label: string }[] = [
    { value: "mission", label: "New mission" },
    ...(canMessage ? [{ value: "central" as const, label: "Message Central" }] : []),
    { value: "command", label: "Command" },
  ];

  return (
    <div className={`hero-composer mode-${effective}`}>
      <div className="hero-composer-head">
        <label className="hero-composer-label" htmlFor="composer-input">
          {copy.label}
        </label>
        <span className="spacer" />
        <Segmented options={options} value={effective} onChange={setMode} label="Composer mode" />
      </div>
      {effective === "command" && interp && (
        <CommandCard
          key={interp.raw}
          interp={interp}
          onClose={() => {
            setInterp(null);
            setText("");
          }}
        />
      )}
      <div className="composer-bar">
        <textarea
          id="composer-input"
          className="composer-input"
          rows={effective === "mission" ? 2 : 1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={blocked ? "Compatibility mode: this project is read-only" : copy.placeholder}
          disabled={busy || blocked}
          spellCheck={effective !== "command"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <span className="muted small composer-hint">Ctrl+Enter</span>
        <button className={`btn primary${effective === "mission" ? " run-btn" : ""}`} onClick={() => void submit()} disabled={busy || blocked || !text.trim()}>
          {busy ? <Spinner size={12} /> : effective === "mission" ? <Play size={13} /> : effective === "central" ? <Send size={13} /> : <ScanSearch size={13} />}
          {copy.button}
        </button>
      </div>
    </div>
  );
}
