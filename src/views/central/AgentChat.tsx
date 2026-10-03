import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDown,
  ArrowRight,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  FilePen,
  FileText,
  GitFork,
  Globe,
  ListTodo,
  Network,
  Play,
  Plug,
  Search,
  Send,
  SquareTerminal,
  WandSparkles,
  Wrench,
  X,
} from "lucide-react";
import { api } from "../../lib/api";
import { formatClock } from "../../lib/format";
import { isLive } from "../../lib/labels";
import { previewResult } from "../../lib/toolText";
import { run } from "../../lib/toast";
import { useAgent, useAgents, useReadOnly } from "../../store";
import { Loading, Spinner } from "../../components/Common";
import { buildChat, type ChatItem, type StepCategory, type StepSummary, type ToolStep } from "./chatModel";
import { sendToAgent } from "./send";
import { useChatLogs } from "./useChatLogs";

const STEP_ICON: Record<StepCategory, LucideIcon> = {
  command: SquareTerminal,
  edit: FilePen,
  read: FileText,
  search: Search,
  web: Globe,
  mcp: Plug,
  nexus: Network,
  skill: WandSparkles,
  subagent: GitFork,
  plan: ListTodo,
  other: Wrench,
};

type NameOf = (id: string) => string;

function useNameOf(): NameOf {
  const agents = useAgents();
  return useMemo(() => {
    const names = new Map(agents.map((a) => [a.id, a.name]));
    return (id: string) => (id === "user" ? "You" : id === "system" ? "NEXUS" : (names.get(id) ?? id));
  }, [agents]);
}

function stepLabel(step: ToolStep, nameOf: NameOf): string {
  const d = step.delegation;
  if (!d) return step.action;
  if (d.kind === "task") return `Delegating task to ${nameOf(d.to)}: ${d.text}`;
  if (d.kind === "message") return `Message to ${nameOf(d.to)}`;
  return `Creating agent ${d.text}`;
}

/** Chips summing up a group of steps: commands, files modified, MCP tools, skills, agents called. */
function SummaryChips({ summary, nameOf }: { summary: StepSummary; nameOf: NameOf }) {
  const chips: { key: string; text: string; title: string; tone?: string }[] = [];
  if (summary.commands) chips.push({ key: "cmd", text: `${summary.commands} ${summary.commands === 1 ? "command" : "commands"}`, title: "Commands run" });
  if (summary.files.length)
    chips.push({ key: "files", text: `${summary.files.length} ${summary.files.length === 1 ? "file" : "files"} modified`, title: summary.files.join("\n") });
  for (const m of summary.mcp) chips.push({ key: `mcp:${m}`, text: `MCP ${m}`, title: "MCP tool used" });
  for (const s of summary.skills) chips.push({ key: `skill:${s}`, text: `Skill ${s}`, title: "Skill activated" });
  for (const a of summary.agents) chips.push({ key: `agent:${a}`, text: `→ ${nameOf(a)}`, title: "Agent called" });
  if (summary.failed) chips.push({ key: "failed", text: `${summary.failed} failed`, title: "Tool calls that returned an error", tone: "red" });
  if (chips.length === 0) return null;
  return (
    <div className="chat-chips">
      {chips.map((c) => (
        <span key={c.key} className={`chat-chip${c.tone ? ` tone-${c.tone}-fg` : ""}`} title={c.title}>
          {c.text}
        </span>
      ))}
    </div>
  );
}

const StepRow = memo(function StepRow({ step, pending, nameOf }: { step: ToolStep; pending: boolean; nameOf: NameOf }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const Icon = step.delegation ? ArrowRight : STEP_ICON[step.category];
  const label = stepLabel(step, nameOf);
  const output = step.result?.text ?? "";
  const preview = previewResult(output, 12);
  const expandable = Boolean(step.detail || output);
  return (
    <li className={`chat-step cat-${step.category}${step.delegation ? " is-delegation" : ""}${step.nested ? " is-nested" : ""}`}>
      <button className="chat-step-head" onClick={() => expandable && setOpen(!open)} aria-expanded={expandable ? open : undefined} disabled={!expandable}>
        <Icon size={12} className="chat-step-icon" aria-hidden="true" />
        <span className="chat-step-label ellipsis" title={label}>
          {step.nested && <span className="muted">↳ </span>}
          {label}
        </span>
        <span className="chat-step-state" aria-label={step.result ? (step.result.ok ? "succeeded" : "failed") : pending ? "running" : undefined}>
          {step.result ? step.result.ok ? <Check size={11} className="tone-green-fg" /> : <X size={11} className="tone-red-fg" /> : pending ? <Spinner size={10} /> : null}
        </span>
        {expandable && <ChevronRight size={11} className={`chat-caret${open ? " open" : ""}`} aria-hidden="true" />}
      </button>
      {open && (
        <div className="chat-step-body">
          {step.detail && step.category !== "edit" && <pre className="chat-pre mono">{step.detail}</pre>}
          {step.category === "edit" && <div className="mono small">{step.detail}</div>}
          {output && (
            <>
              <pre className={`chat-pre mono${step.result?.ok === false ? " is-error" : ""}`}>{full ? output : preview.head}</pre>
              {preview.hidden > 0 && (
                <button className="link-btn small" onClick={() => setFull(!full)}>
                  {full ? "Show less" : `Show ${preview.hidden} more lines`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
});

function Collapsible({ text, lines = 8 }: { text: string; lines?: number }) {
  const [full, setFull] = useState(false);
  const preview = previewResult(text, lines);
  return (
    <>
      <div className="chat-text">{full ? text : preview.head}</div>
      {preview.hidden > 0 && (
        <button className="link-btn small" onClick={() => setFull(!full)}>
          {full ? "Show less" : `Show ${preview.hidden} more lines`}
        </button>
      )}
    </>
  );
}

const ChatRow = memo(function ChatRow({ item, pending, agentName, nameOf }: { item: ChatItem; pending: boolean; agentName: string; nameOf: NameOf }) {
  switch (item.type) {
    case "session":
      return <div className="chat-divider">Session #{item.sessionId}</div>;
    case "user":
      return (
        <div className="chat-msg is-user">
          <div className="chat-meta">
            You <span className="chat-time">{formatClock(item.ts)}</span>
          </div>
          <div className="chat-bubble">
            <div className="chat-text">{item.text}</div>
          </div>
        </div>
      );
    case "agent":
      return (
        <div className={`chat-msg is-agent${item.nested ? " is-nested" : ""}`}>
          <div className="chat-meta">
            {item.nested ? `${agentName} · sub-agent` : agentName} <span className="chat-time">{formatClock(item.ts)}</span>
          </div>
          <div className="chat-bubble">
            <div className="chat-text">{item.text}</div>
          </div>
        </div>
      );
    case "incoming":
      return (
        <div className="chat-card">
          <div className="chat-meta">
            From {nameOf(item.from)} · {item.kind} <span className="chat-time">{formatClock(item.ts)}</span>
          </div>
          {item.subject && <div className="chat-subject">{item.subject}</div>}
          <Collapsible text={item.text} lines={6} />
        </div>
      );
    case "task":
      return (
        <div className="chat-card is-task">
          <div className="chat-meta">
            Task {item.taskId} <span className="chat-time">{formatClock(item.ts)}</span>
          </div>
          <div className="chat-subject">{item.title}</div>
          <details className="chat-details">
            <summary>Task brief</summary>
            <div className="chat-text">{item.text}</div>
          </details>
        </div>
      );
    case "prompt":
      return (
        <details className="chat-details chat-prompt">
          <summary>Instructions sent to the session · {formatClock(item.ts)}</summary>
          <div className="chat-text">{item.text}</div>
        </details>
      );
    case "reasoning":
      return (
        <details className="chat-details chat-reasoning">
          <summary>
            <Brain size={11} aria-hidden="true" /> Reasoning
          </summary>
          <div className="chat-text">{item.text}</div>
        </details>
      );
    case "steps":
      return (
        <div className="chat-steps">
          <ul>
            {item.steps.map((s, i) => (
              <StepRow key={s.id} step={s} pending={pending && !s.result && i === item.steps.length - 1} nameOf={nameOf} />
            ))}
          </ul>
          <SummaryChips summary={item.summary} nameOf={nameOf} />
        </div>
      );
    case "turn":
      return <div className={`chat-turn${item.ok ? "" : " is-error"}`}>{item.text}</div>;
    case "error":
      return (
        <div className="chat-error">
          <CircleAlert size={12} aria-hidden="true" />
          <Collapsible text={item.text} lines={6} />
        </div>
      );
    case "status":
      return <div className={`chat-status${item.warn ? " is-warn" : ""}`}>{item.text}</div>;
    case "stderr":
      return (
        <details className="chat-details chat-stderr">
          <summary>stderr · {item.lines.length} {item.lines.length === 1 ? "line" : "lines"}</summary>
          <pre className="chat-pre mono">{item.lines.join("\n")}</pre>
        </details>
      );
  }
});

/** Message box under a chat: Enter sends, Shift+Enter adds a line. */
export function ChatComposer({ agentId, placeholder, disabled, hint }: { agentId: string; placeholder: string; disabled?: string; hint?: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const body = text.trim();
    if (!body || busy || disabled) return;
    setBusy(true);
    if (await sendToAgent(agentId, body)) setText("");
    setBusy(false);
  };
  return (
    <form
      className="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={disabled ?? placeholder}
        disabled={busy || Boolean(disabled)}
        aria-label={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button className="btn primary chat-send" type="submit" disabled={busy || Boolean(disabled) || !text.trim()} aria-label="Send" title="Send (Enter)">
        {busy ? <Spinner size={12} /> : <Send size={13} />}
      </button>
      {hint && <div className="chat-hint muted small">{hint}</div>}
    </form>
  );
}

/**
 * The real conversation with one agent's Claude Code session: what the user and other agents sent,
 * what it answered, every tool call grouped with its result, and the session's status lines.
 */
export function AgentChat({ agentId, placeholder }: { agentId: string; placeholder?: string }) {
  const agent = useAgent(agentId);
  const readOnly = useReadOnly();
  const nameOf = useNameOf();
  const { entries, loading, hasMore, loadingOlder, loadOlder } = useChatLogs(agentId);
  const items = useMemo(() => buildChat(entries), [entries]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, loading]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottom.current = bottom;
    setShowJump(!bottom);
  }, []);

  if (!agent) return <div className="muted pad">This agent does not exist in the project.</div>;
  const name = agent.name;
  const live = isLive(agent.status);
  const working = agent.status === "working";
  const lastSteps = items.length > 0 && items[items.length - 1].type === "steps";
  const disabled = readOnly ? "Compatibility mode: this project is read-only" : agent.status === "retired" ? `${name} is retired` : undefined;

  return (
    <div className="chat">
      {!live && agent.status !== "retired" && (
        <div className="chat-offline">
          <span className="grow">
            {name} is {agent.status === "crashed" ? "stopped after a crash" : "not running"}. Sending a message starts its session.
          </span>
          <button className="btn btn-sm" disabled={readOnly} onClick={() => void run(() => api.startAgent(agentId), `Starting ${name}`)}>
            <Play size={11} /> Start
          </button>
        </div>
      )}
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-label={`Conversation with ${name}`} aria-live="polite" aria-relevant="additions">
        {loading ? (
          <Loading text="Loading conversation…" />
        ) : (
          <>
            {hasMore && (
              <button className="link-btn small chat-older" onClick={() => void loadOlder()} disabled={loadingOlder}>
                {loadingOlder ? <Spinner size={11} /> : "Load earlier messages"}
              </button>
            )}
            {items.length === 0 && (
              <div className="chat-empty muted">
                No conversation yet. Ask {name} anything — it answers from its real Claude Code session, and you see every tool it uses here.
              </div>
            )}
            {items.map((item, i) => (
              <ChatRow key={item.key} item={item} pending={working && lastSteps && i === items.length - 1} agentName={name} nameOf={nameOf} />
            ))}
            {working && (
              <div className="chat-working" aria-live="off">
                <Spinner size={11} /> <span className="ellipsis">{agent.currentAction ?? "Working"}</span>
              </div>
            )}
          </>
        )}
      </div>
      {showJump && (
        <button
          className="btn btn-sm chat-jump"
          onClick={() => {
            atBottom.current = true;
            setShowJump(false);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          <ArrowDown size={12} /> Latest
        </button>
      )}
      <ChatComposer agentId={agentId} placeholder={placeholder ?? `Message ${name}…`} disabled={disabled} />
    </div>
  );
}
