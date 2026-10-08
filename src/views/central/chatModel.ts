// Turns an agent's real session transcript (LogEntry list from agent_logs / pcc://log) into chat items:
// user and agent messages, grouped tool steps (commands, files, MCP tools, skills, delegations),
// reasoning (only when the log has `thinking` lines), turn results, errors and session status.
// Pure: no React, no Tauri. Formats mirror crates/pcc-orchestrator (engine.rs, prompts.rs).

import { field, parseToolUse } from "../../lib/toolText";
import type { LogEntry } from "../../lib/types";

export type StepCategory = "command" | "edit" | "read" | "search" | "web" | "mcp" | "nexus" | "skill" | "subagent" | "plan" | "other";

export interface ToolStep {
  /** Log id of the tool_use line. */
  id: number;
  ts: string;
  name: string;
  category: StepCategory;
  /** Readable action ("Running npm test", "Editing App.tsx"). */
  action: string;
  /** Command line, file path, MCP tool, skill name… (full, for tooltips / expansion). */
  detail: string;
  /** Called by a sub-agent of the session. */
  nested: boolean;
  /** NEXUS coordination calls that hand work to another agent. */
  delegation?: { kind: "task" | "message" | "create_agent" | "decision"; to: string; text: string };
  result?: { ok: boolean; text: string };
}

export interface StepSummary {
  commands: number;
  /** Files written or edited (full paths, unique, in order). */
  files: string[];
  /** MCP tools used (`server → tool`), NEXUS coordination tools excluded. */
  mcp: string[];
  skills: string[];
  /** Agent ids work was delegated to. */
  agents: string[];
  failed: number;
}

export type ChatItem =
  | { type: "session"; key: string; sessionId: number }
  | { type: "user"; key: string; ts: string; text: string }
  /** A message delivered to the session from another agent or from NEXUS (notifications). */
  | {
      type: "incoming";
      key: string;
      ts: string;
      from: string;
      kind: string;
      subject: string | null;
      text: string;
      /** NEXUS routed this message through the agent (cross-branch, §16): it should relay it to `for`. */
      routed?: { from: string; for: string; path: string[] };
    }
  | { type: "task"; key: string; ts: string; taskId: string; title: string; text: string }
  /** The verified recovery report NEXUS gives Central when a mission resumes (crates/pcc-orchestrator/src/resume.rs). */
  | { type: "resume"; key: string; ts: string; report: ParsedResumeReport }
  /** A reminder of NEXUS's mission supervisor (crates/pcc-orchestrator/src/central.rs). */
  | { type: "supervisor"; key: string; ts: string; text: string }
  /** Any other input written to the session (instructions, nudges). */
  | { type: "prompt"; key: string; ts: string; text: string }
  | { type: "agent"; key: string; ts: string; text: string; nested: boolean }
  | { type: "reasoning"; key: string; ts: string; text: string }
  | { type: "steps"; key: string; ts: string; steps: ToolStep[]; summary: StepSummary }
  | { type: "turn"; key: string; ts: string; ok: boolean; text: string }
  | { type: "error"; key: string; ts: string; text: string }
  | { type: "status"; key: string; ts: string; text: string; warn: boolean }
  | { type: "stderr"; key: string; ts: string; lines: string[] };

export const RESUME_MARKER = "[NEXUS RESUME REPORT]";
export const SUPERVISOR_MARKER = "[NEXUS SUPERVISOR]";

export interface ResumeFact {
  label: string;
  value: string;
}

export interface ParsedResumeReport {
  /** "Control Center recovered.", "Resume requested: …", "Nothing to resume: …". */
  headline: string;
  /** NEXUS was interrupted (crash, kill, reboot) while the mission ran. */
  recovered: boolean;
  /** No running or interrupted mission was found. */
  nothing: boolean;
  facts: ResumeFact[];
  /** Verified progress, when the report has it. */
  progress: { verified: number; total: number } | null;
  /** MCP servers of the `MCP:` fact (`server ✓ detail · …`). */
  mcp: { server: string; state: "ok" | "failed" | "unknown"; detail: string }[];
  /** The instruction NEXUS adds for Central. */
  instruction: string;
}

/** `[NEXUS RESUME REPORT]` text (one `Key: value` fact per line, a blank line, the instruction) → parsed, or null. */
export function parseResumeReport(text: string): ParsedResumeReport | null {
  const body = text.trimStart();
  if (!body.startsWith(RESUME_MARKER)) return null;
  const lines = body.slice(RESUME_MARKER.length).replace(/^\r?\n/, "").split(/\r?\n/);
  const headline = (lines.shift() ?? "").trim();
  const facts: ResumeFact[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break;
    const sep = line.indexOf(": ");
    if (sep > 0) facts.push({ label: line.slice(0, sep).trim(), value: line.slice(sep + 2).trim() });
    else if (facts.length) facts[facts.length - 1].value += `\n${line.trim()}`;
  }
  const instruction = lines.slice(i).join("\n").trim();
  const fact = (label: string) => facts.find((f) => f.label === label)?.value;
  const pm = fact("Verified progress")?.match(/^(\d+)\/(\d+)/);
  const mcpValue = fact("MCP");
  const mcp =
    mcpValue && !mcpValue.startsWith("none")
      ? mcpValue.split(" · ").map((part) => {
          const m = part.match(/^(.*?) ([✓✗?])(?: (.*))?$/);
          if (!m) return { server: part, state: "unknown" as const, detail: "" };
          const state = m[2] === "✓" ? ("ok" as const) : m[2] === "✗" ? ("failed" as const) : ("unknown" as const);
          return { server: m[1], state, detail: m[3] ?? "" };
        })
      : [];
  return {
    headline,
    recovered: headline.startsWith("Control Center recovered"),
    nothing: headline.startsWith("Nothing to resume"),
    facts,
    progress: pm ? { verified: Number(pm[1]), total: Number(pm[2]) } : null,
    mcp,
    instruction,
  };
}

const NESTED = "↳ ";
const PART_SEPARATOR = "\n\n---\n\n";
const NEXUS_PREFIX = "mcp__pcc__";

function basenameOf(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

/** Category, detail and delegation of one tool call. */
export function classifyTool(text: string): Omit<ToolStep, "id" | "ts" | "result"> {
  const call = parseToolUse(text);
  const body = call.nested ? text.slice(NESTED.length) : text;
  const raw = body.slice(call.name.length + 1);
  const f = (k: string) => field(call.input, raw, k);
  const base = { name: call.name, action: call.action, nested: call.nested };
  switch (call.name) {
    case "Bash":
    case "PowerShell":
      return { ...base, category: "command", detail: f("command") };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return { ...base, category: "edit", detail: f("file_path") || f("notebook_path") };
    case "Read":
      return { ...base, category: "read", detail: f("file_path") };
    case "Glob":
    case "Grep":
      return { ...base, category: "search", detail: f("pattern") };
    case "WebFetch":
    case "WebSearch":
      return { ...base, category: "web", detail: f("url") || f("query") };
    case "TodoWrite":
      return { ...base, category: "plan", detail: "" };
    case "Skill": {
      const skill = f("skill") || f("command") || f("name");
      return { ...base, category: "skill", action: `Using skill ${skill}`, detail: skill };
    }
    case "Task":
    case "Agent": {
      const what = f("description") || f("subagent_type");
      return { ...base, category: "subagent", action: `Sub-agent: ${what}`, detail: f("prompt") };
    }
  }
  if (call.name.startsWith(NEXUS_PREFIX)) {
    const tool = call.name.slice(NEXUS_PREFIX.length);
    if (tool === "create_task") {
      return { ...base, category: "nexus", detail: f("title"), delegation: { kind: "task", to: f("agent"), text: f("title") } };
    }
    if (tool === "send_message") {
      return { ...base, category: "nexus", detail: f("body"), delegation: { kind: "message", to: f("to") || "central", text: f("body") } };
    }
    if (tool === "create_agent") {
      const rank = f("rank") === "lieutenant" ? " (lieutenant)" : "";
      return { ...base, category: "nexus", detail: f("role"), delegation: { kind: "create_agent", to: f("id") || f("name"), text: `${f("name")}${rank}` } };
    }
    if (tool === "record_delegation_decision") {
      const input = call.input ?? {};
      const needs = input.needs_sub_agents === true || /"needs_sub_agents"\s*:\s*true/.test(raw);
      const n = Array.isArray(input.children) ? input.children.length : (raw.match(/"name"\s*:/g) ?? []).length;
      const text = needs ? `delegate to ${n} sub-agent${n === 1 ? "" : "s"}` : "work without sub-agents";
      return { ...base, category: "nexus", detail: f("reason"), delegation: { kind: "decision", to: "", text } };
    }
    return { ...base, category: "nexus", detail: tool };
  }
  if (call.name.startsWith("mcp__")) {
    return { ...base, category: "mcp", detail: call.name.slice(5).replaceAll("__", " → ") };
  }
  return { ...base, category: "other", detail: raw.slice(0, 300) };
}

/** `[↳ ]✓|✗ <ToolName>\n<output>` → parsed, or null for other lines. */
export function parseToolResult(text: string): { nested: boolean; ok: boolean; name: string; output: string } | null {
  const m = text.match(/^(↳ )?([✓✗]) ([^\n]*)(?:\n([\s\S]*))?$/);
  if (!m) return null;
  return { nested: Boolean(m[1]), ok: m[2] === "✓", name: m[3].trim(), output: m[4] ?? "" };
}

export function summarizeSteps(steps: ToolStep[]): StepSummary {
  const files: string[] = [];
  const mcp: string[] = [];
  const skills: string[] = [];
  const agents: string[] = [];
  const add = (list: string[], v: string) => v && !list.includes(v) && list.push(v);
  let commands = 0;
  let failed = 0;
  for (const s of steps) {
    if (s.category === "command") commands += 1;
    if (s.category === "edit") add(files, s.detail);
    if (s.category === "mcp") add(mcp, s.detail);
    if (s.category === "skill") add(skills, s.detail);
    if (s.delegation && s.delegation.kind !== "create_agent") add(agents, s.delegation.to);
    if (s.result && !s.result.ok) failed += 1;
  }
  return { commands, files, mcp, skills, agents, failed };
}

/** Splits one `input` line into the parts NEXUS joined (messages, task dispatches, other text). */
export function parseInput(entry: LogEntry): ChatItem[] {
  return entry.text.split(PART_SEPARATOR).map((part, i): ChatItem => {
    const key = `${entry.id}:${i}`;
    const [head, ...rest] = part.split("\n");
    // `[MESSAGE <id> · from <agent> · <kind>…]`; NEXUS notifications have no id (`[MESSAGE from system · notification]`).
    const message = head.match(/^\[MESSAGE (?:(\S+) · )?from (\S+) · ([^·\]]+)/);
    if (message) {
      let body = rest;
      let subject: string | null = null;
      if (body[0]?.startsWith("Subject: ")) {
        subject = body[0].slice(9);
        body = body.slice(1);
      }
      const text = body.join("\n").trim();
      if (message[2] === "user") return { type: "user", key, ts: entry.ts, text };
      if (message[2] === "system") {
        const report = parseResumeReport(text);
        if (report) return { type: "resume", key, ts: entry.ts, report };
        if (text.startsWith(SUPERVISOR_MARKER)) return { type: "supervisor", key, ts: entry.ts, text: text.slice(SUPERVISOR_MARKER.length).trim() };
      }
      const routed = parseRouted(text);
      return { type: "incoming", key, ts: entry.ts, from: message[2], kind: message[3].trim(), subject, text, ...(routed ? { routed } : {}) };
    }
    const task = head.match(/^\[TASK (\S+)\](?: \(resumed\))? (.*)$/);
    if (task) return { type: "task", key, ts: entry.ts, taskId: task[1], title: task[2], text: rest.join("\n").trim() };
    return { type: "prompt", key, ts: entry.ts, text: part.trim() };
  });
}

/** `[ROUTED by NEXUS · from <a> · for <b> · path a → p → b]` (crates/pcc-orchestrator/src/hierarchy.rs). */
export function parseRouted(text: string): { from: string; for: string; path: string[] } | null {
  const m = text.match(/^\[ROUTED by NEXUS · from (\S+) · for (\S+) · path ([^\]]+)\]/);
  return m ? { from: m[1], for: m[2], path: m[3].split("→").map((x) => x.trim()) } : null;
}

/** Groups an id-sorted transcript into chat items. */
export function buildChat(entries: LogEntry[]): ChatItem[] {
  const items: ChatItem[] = [];
  let session: number | null = null;
  const last = () => items[items.length - 1];

  for (const e of entries) {
    if (session !== null && e.sessionId !== session) items.push({ type: "session", key: `s${e.id}`, sessionId: e.sessionId });
    session = e.sessionId;
    const key = String(e.id);

    switch (e.kind) {
      case "input":
        items.push(...parseInput(e));
        break;
      case "assistant_text": {
        const nested = e.text.startsWith(NESTED);
        const text = nested ? e.text.slice(NESTED.length) : e.text;
        const prev = last();
        if (prev?.type === "agent" && prev.nested === nested) items[items.length - 1] = { ...prev, text: `${prev.text}\n\n${text}` };
        else items.push({ type: "agent", key, ts: e.ts, text, nested });
        break;
      }
      case "thinking":
        if (e.text.trim()) items.push({ type: "reasoning", key, ts: e.ts, text: e.text });
        break;
      case "tool_use": {
        const step: ToolStep = { id: e.id, ts: e.ts, ...classifyTool(e.text) };
        const prev = last();
        if (prev?.type === "steps") {
          const steps = [...prev.steps, step];
          items[items.length - 1] = { ...prev, steps, summary: summarizeSteps(steps) };
        } else {
          items.push({ type: "steps", key, ts: e.ts, steps: [step], summary: summarizeSteps([step]) });
        }
        break;
      }
      case "tool_result":
      case "error": {
        const r = parseToolResult(e.text);
        if (r && attachResult(items, r)) break;
        if (e.kind === "error") {
          if (e.text.startsWith("Turn finished")) items.push({ type: "turn", key, ts: e.ts, ok: false, text: e.text });
          else items.push({ type: "error", key, ts: e.ts, text: r ? r.output || e.text : e.text });
        }
        // An unmatched successful result (its call is older than the loaded history) is dropped.
        break;
      }
      case "result":
        items.push({ type: "turn", key, ts: e.ts, ok: true, text: e.text });
        break;
      case "system":
        items.push({ type: "status", key, ts: e.ts, text: e.text, warn: /^(Denied|Control request failed)/.test(e.text) });
        break;
      case "stderr": {
        const prev = last();
        if (prev?.type === "stderr") items[items.length - 1] = { ...prev, lines: [...prev.lines, e.text] };
        else items.push({ type: "stderr", key, ts: e.ts, lines: [e.text] });
        break;
      }
    }
  }
  return items;
}

/** How far back a tool result looks for its call. */
const PAIR_WINDOW = 12;

/** Attaches a result to the oldest unanswered call with the same tool name; false when none. */
function attachResult(items: ChatItem[], r: NonNullable<ReturnType<typeof parseToolResult>>): boolean {
  for (let i = items.length - 1; i >= Math.max(0, items.length - PAIR_WINDOW); i--) {
    const item = items[i];
    if (item.type !== "steps") continue;
    const idx = item.steps.findIndex((s) => !s.result && s.name === r.name && s.nested === r.nested);
    if (idx === -1) continue;
    const steps = item.steps.slice();
    steps[idx] = { ...steps[idx], result: { ok: r.ok, text: r.output } };
    items[i] = { ...item, steps, summary: summarizeSteps(steps) };
    return true;
  }
  return false;
}

/** File name for display. */
export const fileLabel = basenameOf;
