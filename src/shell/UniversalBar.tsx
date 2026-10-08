import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { CornerDownLeft, ScanSearch, Slash, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { modelValue } from "../lib/claudeEnv";
import { attempt, toast } from "../lib/toast";
import type { Interpretation } from "../lib/types";
import { setAgentModel } from "../state/actions";
import { useClaude, useModels, useSkills } from "../state/claude";
import { useRightContext } from "../state/context";
import { useUi } from "../state/ui";
import { useAgents, useConnections, useReadOnly, useStore } from "../store";
import { Spinner } from "../components/Common";
import { sendToAgent } from "../views/central/send";
import { CommandCard } from "./command/CommandCard";
import { SLASH_COMMANDS, parseBar, suggest, type BarAction, type Suggestion } from "./command/slash";
import { StatusStrip } from "./StatusStrip";
import { t, type MessageKey } from "../i18n";

/** Text of the bar, shared so the Ctrl+K palette and shortcuts can prefill and focus it. */
const useBarText = create<{ text: string; focusTick: number; setText: (t: string) => void; focus: (t?: string) => void }>((set) => ({
  text: "",
  focusTick: 0,
  setText: (text) => set({ text }),
  focus: (t) => set((s) => ({ text: t ?? s.text, focusTick: s.focusTick + 1 })),
}));

/** Puts the caret in the command bar, optionally replacing its text (e.g. "/run "). */
export function focusCommandBar(text?: string): void {
  useBarText.getState().focus(text);
}

/** Draft of the bar (saved in the UI checkpoint, restored after an interface reload). */
export const getBarText = (): string => useBarText.getState().text;
export const setBarText = (text: string): void => useBarText.getState().setText(text);

const MODE: Record<string, { icon: typeof Sparkles; label: MessageKey }> = {
  ask: { icon: Sparkles, label: "bar.mode.ask" },
  interpret: { icon: ScanSearch, label: "bar.mode.interpret" },
  slash: { icon: Slash, label: "bar.mode.slash" },
};

function hintFor(action: BarAction): string {
  switch (action.type) {
    case "empty":
      return t("bar.hint.empty");
    case "ask":
      return t("bar.hint.ask");
    case "interpret":
      return t("bar.hint.interpret");
    case "unknown":
      return t("bar.hint.unknown", { list: SLASH_COMMANDS.map((c) => `/${c.name}`).join(" ") });
    default:
      return t("bar.hint.run");
  }
}

/** Is focus in a field where "/" is typed text rather than a shortcut? */
function editableFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.closest(".xterm")));
}

/**
 * The single bottom bar: plain text is a quick ask to Central (answered in the right chat), a pasted
 * command line is explained before anything runs, and "/" commands open missions, agents, MCP,
 * skills, GitHub or set models. Status counters sit on its right.
 */
export function UniversalBar() {
  const text = useBarText((s) => s.text);
  const setText = useBarText((s) => s.setText);
  const focusTick = useBarText((s) => s.focusTick);
  const agents = useAgents();
  const connections = useConnections();
  const readOnly = useReadOnly();
  const models = useModels();
  const envMcp = useClaude((s) => s.env?.mcpServers);
  const { skills } = useSkills();
  const [busy, setBusy] = useState(false);
  const [interp, setInterp] = useState<Interpretation | null>(null);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refs = useMemo(() => agents.filter((a) => a.status !== "retired").map((a) => ({ id: a.id, name: a.name })), [agents]);
  const ctx = useMemo(
    () => ({
      agents: refs,
      skills: (skills ?? []).map((s) => s.name),
      mcp: [
        ...new Set([
          ...connections.filter((c) => c.kind === "mcp" || c.kind === "roblox_studio").map((c) => c.name),
          ...(envMcp ?? []).map((s) => String(s.name ?? "")).filter(Boolean),
        ]),
      ],
      models: ["default", ...models.map((m) => modelValue(m)).filter((v): v is string => Boolean(v) && v !== "default")],
    }),
    [refs, skills, connections, envMcp, models],
  );
  const suggestions = useMemo(() => (dismissed ? [] : suggest(text, ctx)), [text, ctx, dismissed]);
  const action = parseBar(text, refs);
  const mode = action.type === "ask" ? MODE.ask : action.type === "interpret" ? MODE.interpret : action.type === "empty" ? MODE.ask : MODE.slash;
  const ModeIcon = mode.icon;

  useEffect(() => setIndex(0), [text]);
  useEffect(() => {
    if (focusTick > 0) inputRef.current?.focus();
  }, [focusTick]);
  // The model list comes from Claude Code's environment (a short control session, no model call): load it on demand.
  useEffect(() => {
    if (text.startsWith("/model") && models.length === 0) void useClaude.getState().load();
  }, [text, models.length]);
  // "/" anywhere outside a text field starts a command.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || editableFocused() || document.querySelector(".modal-backdrop")) return;
      e.preventDefault();
      focusCommandBar("/");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const take = (s: Suggestion) => {
    setText(s.insert);
    setDismissed(false);
    inputRef.current?.focus();
  };

  const execute = async (a: BarAction): Promise<boolean> => {
    const s = useStore.getState();
    const right = useRightContext.getState();
    const agentName = (id: string) => refs.find((r) => r.id === id)?.name ?? id;
    switch (a.type) {
      case "empty":
        return false;
      case "ask":
        if (readOnly) return false;
        if (!(await sendToAgent("central", a.text))) return false;
        right.resetContext();
        right.setRightOpen(true);
        return true;
      case "interpret": {
        const result = await attempt(() => api.interpretCommand(a.line));
        if (result) setInterp(result);
        return false;
      }
      case "mission":
        useUi.getState().setNewMission(true, a.text);
        s.navigate({ name: "missions" });
        return true;
      case "agent":
        if (!a.agentId) {
          if (a.query) {
            toast.error(t("bar.noAgent", { name: a.query }));
            return false;
          }
          s.navigate({ name: "agents" });
          return true;
        }
        if (a.message) {
          if (readOnly || !(await sendToAgent(a.agentId, a.message))) return false;
        }
        right.openContext({ kind: "agent", agentId: a.agentId, tab: "chat" });
        return true;
      case "mcp":
        s.navigate({ name: "mcp" });
        return true;
      case "skill": {
        const installed = (skills ?? []).find((k) => k.name.toLowerCase() === a.query.toLowerCase());
        if (installed) right.openContext({ kind: "skill", skillId: installed.id });
        else s.navigate({ name: "market" });
        return true;
      }
      case "github":
        s.navigate({ name: "github" });
        return true;
      case "model":
        if (!a.agentId || !a.model) {
          toast.error(t("bar.modelUsage"));
          return false;
        }
        if (readOnly) return false;
        return (await setAgentModel({ id: a.agentId, name: agentName(a.agentId) }, a.model === "default" ? null : a.model)) !== undefined;
      case "unknown":
        toast.error(t("bar.unknownCommand", { command: a.command, list: SLASH_COMMANDS.map((c) => `/${c.name}`).join(", ") }));
        return false;
    }
  };

  const submit = async (forceAsk: boolean) => {
    if (busy) return;
    const a = parseBar(text, refs, forceAsk);
    if (a.type === "empty") return;
    setBusy(true);
    setInterp(null);
    const done = await execute(a);
    setBusy(false);
    if (done) setText("");
  };

  const blocked = readOnly && (action.type === "ask" || action.type === "empty");
  const listId = "ubar-suggestions";
  const open = suggestions.length > 0;

  return (
    <div className="ubar">
      {interp && (
        <div className="ubar-card">
          <CommandCard
            key={interp.raw}
            interp={interp}
            onClose={() => {
              setInterp(null);
              setText("");
            }}
          />
        </div>
      )}
      {open && (
        <ul className="ubar-suggest" id={listId} role="listbox" aria-label={t("bar.suggestions")}>
          {suggestions.map((s, i) => (
            <li
              key={s.insert}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === index}
              className={`ubar-option${i === index ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                take(s);
              }}
              onMouseMove={() => setIndex(i)}
            >
              <span className="mono">{s.label}</span>
              <span className="muted small ellipsis">{s.detail}</span>
              {i === index && <CornerDownLeft size={11} className="muted" />}
            </li>
          ))}
        </ul>
      )}
      <div className="ubar-row">
        <div className={`ubar-field mode-${action.type}`}>
          <span className="ubar-mode" title={t(mode.label)}>
            <ModeIcon size={13} aria-hidden="true" />
            <span className="ubar-mode-label">{t(mode.label)}</span>
          </span>
          <textarea
            ref={inputRef}
            className="ubar-input"
            rows={1}
            value={text}
            placeholder={readOnly ? t("bar.placeholderReadOnly") : t("bar.placeholder")}
            spellCheck={action.type === "ask" || action.type === "empty"}
            disabled={busy}
            role="combobox"
            aria-label={t("bar.aria")}
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={open ? `${listId}-${index}` : undefined}
            onChange={(e) => {
              setText(e.target.value);
              setDismissed(false);
            }}
            onKeyDown={(e) => {
              if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                setIndex((i) => (e.key === "ArrowDown" ? Math.min(suggestions.length - 1, i + 1) : Math.max(0, i - 1)));
              } else if (open && (e.key === "Tab" || (e.key === "Enter" && !e.altKey && !e.shiftKey))) {
                e.preventDefault();
                take(suggestions[index]);
              } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit(e.altKey);
              } else if (e.key === "Escape") {
                if (open) setDismissed(true);
                else if (interp) setInterp(null);
                else return;
                e.preventDefault();
              }
            }}
          />
          <span className="ubar-hint muted small">{hintFor(action)}</span>
          <button className="btn btn-sm primary" onClick={() => void submit(false)} disabled={busy || blocked || action.type === "empty"} aria-label={t("bar.run")}>
            {busy ? <Spinner size={11} /> : <CornerDownLeft size={12} />}
          </button>
        </div>
        <StatusStrip />
      </div>
    </div>
  );
}
