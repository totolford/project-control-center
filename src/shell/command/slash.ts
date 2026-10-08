// Universal command bar language. Plain text is a quick ask to Central; a pasted command line is
// explained by the interpreter before anything runs; "/" starts a command. Pure: the bar executes.

import { t } from "../../i18n";

export interface SlashCommand {
  name: string;
  args: string;
  /** In the current interface language. */
  readonly description: string;
}

function slash(name: string, args: string): SlashCommand {
  return {
    name,
    args,
    get description() {
      return t.dynamic(`bar.slash.${name}`);
    },
  };
}

export const SLASH_COMMANDS: SlashCommand[] = [
  slash("mission", "<objective>"),
  slash("agent", "<name> [message]"),
  slash("mcp", "[server]"),
  slash("skill", "[name]"),
  slash("github", "[owner/repo]"),
  slash("ssh", "<user@host>"),
  slash("run", "<command line>"),
  slash("model", "<agent> <model>"),
];

export interface NamedRef {
  id: string;
  name: string;
}

export type BarAction =
  | { type: "empty" }
  | { type: "ask"; text: string }
  | { type: "interpret"; line: string }
  | { type: "mission"; text: string }
  | { type: "agent"; agentId: string | null; query: string; message: string }
  | { type: "mcp"; query: string }
  | { type: "skill"; query: string }
  | { type: "github"; query: string }
  | { type: "model"; agentId: string | null; model: string | null; query: string }
  | { type: "unknown"; command: string };

/** Programs whose lines the interpreter knows how to explain (anything else is a question for Central). */
const COMMAND_PROGRAMS = new Set(["claude", "ssh", "scp", "git", "gh", "npx", "npm"]);

/** A single line that starts like a shell command (`ssh pi@host`, `claude mcp add …`). */
export function looksLikeCommandLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.includes("\n") || t.endsWith("?")) return false;
  const first = t.split(/\s+/)[0].toLowerCase().replace(/\.exe$/, "");
  return COMMAND_PROGRAMS.has(first) && t.split(/\s+/).length > 1;
}

/**
 * Longest agent whose name or id starts `text` (case-insensitive, whole words).
 * Names can contain spaces ("Movement Agent"), so the longest match wins.
 */
export function matchAgentPrefix(text: string, agents: NamedRef[]): { agent: NamedRef; rest: string } | null {
  const lower = text.toLowerCase();
  let best: { agent: NamedRef; len: number } | null = null;
  for (const a of agents) {
    for (const label of [a.name, a.id]) {
      const l = label.toLowerCase();
      if (!l) continue;
      const boundary = lower.length === l.length || /\s/.test(lower[l.length] ?? "");
      if (lower.startsWith(l) && boundary && (!best || l.length > best.len)) best = { agent: a, len: l.length };
    }
  }
  return best ? { agent: best.agent, rest: text.slice(best.len).trim() } : null;
}

function splitCommand(text: string): { name: string; rest: string } {
  const m = text.match(/^\/(\S*)\s*([\s\S]*)$/);
  return m ? { name: m[1].toLowerCase(), rest: m[2].trim() } : { name: "", rest: "" };
}

/** What pressing Enter does with the current text. `forceAsk` (Alt+Enter) sends a command line to Central as is. */
export function parseBar(input: string, agents: NamedRef[], forceAsk = false): BarAction {
  const text = input.trim();
  if (!text) return { type: "empty" };
  if (!text.startsWith("/")) {
    if (!forceAsk && looksLikeCommandLine(text)) return { type: "interpret", line: text };
    return { type: "ask", text };
  }
  const { name, rest } = splitCommand(text);
  switch (name) {
    case "mission":
      return { type: "mission", text: rest };
    case "agent": {
      const m = matchAgentPrefix(rest, agents);
      return m ? { type: "agent", agentId: m.agent.id, query: rest, message: m.rest } : { type: "agent", agentId: null, query: rest, message: "" };
    }
    case "mcp":
      return { type: "mcp", query: rest };
    case "skill":
    case "skills":
      return { type: "skill", query: rest };
    case "github":
    case "gh":
      return { type: "github", query: rest };
    case "ssh":
      return rest ? { type: "interpret", line: `ssh ${rest}` } : { type: "unknown", command: "ssh" };
    case "run":
    case "cmd":
      return rest ? { type: "interpret", line: rest } : { type: "unknown", command: name };
    case "model": {
      const m = matchAgentPrefix(rest, agents);
      if (!m) return { type: "model", agentId: null, model: null, query: rest };
      const model = m.rest.split(/\s+/)[0] ?? "";
      return { type: "model", agentId: m.agent.id, model: model || null, query: rest };
    }
    default:
      return { type: "unknown", command: name };
  }
}

export interface Suggestion {
  /** Text the input becomes when the suggestion is taken. */
  insert: string;
  label: string;
  detail: string;
}

export interface SuggestContext {
  agents: NamedRef[];
  skills: string[];
  mcp: string[];
  models: string[];
}

function startsWithCi(value: string, prefix: string): boolean {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

/** Autocomplete entries for the current text (empty when nothing to complete). */
export function suggest(input: string, ctx: SuggestContext, max = 8): Suggestion[] {
  if (!input.startsWith("/")) return [];
  const space = input.search(/\s/);
  if (space === -1) {
    const typed = input.slice(1).toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(typed)).map((c) => ({
      insert: `/${c.name} `,
      label: `/${c.name} ${c.args}`,
      detail: c.description,
    }));
  }
  const { name } = splitCommand(input);
  const rest = input.slice(space).replace(/^\s+/, "");
  const agentChoices = (prefix: string) =>
    ctx.agents
      .filter((a) => startsWithCi(a.name, rest) || startsWithCi(a.id, rest))
      .slice(0, max)
      .map((a) => ({ insert: `${prefix}${a.name} `, label: a.name, detail: a.id }));
  switch (name) {
    case "agent":
      if (matchAgentPrefix(rest, ctx.agents) && /\s$/.test(input)) return [];
      return agentChoices("/agent ");
    case "model": {
      const m = matchAgentPrefix(rest, ctx.agents);
      if (!m || (!m.rest && !/\s$/.test(input))) return agentChoices("/model ");
      const head = `/model ${m.agent.name} `;
      if (ctx.models.includes(m.rest)) return [];
      return ctx.models
        .filter((model) => startsWithCi(model, m.rest))
        .slice(0, max)
        .map((model) => ({ insert: `${head}${model}`, label: model, detail: t("bar.suggest.modelFor", { name: m.agent.name }) }));
    }
    case "skill":
      return ctx.skills
        .filter((s) => startsWithCi(s, rest) && s !== rest)
        .slice(0, max)
        .map((s) => ({ insert: `/skill ${s}`, label: s, detail: t("bar.suggest.skill") }));
    case "mcp":
      return ctx.mcp
        .filter((s) => startsWithCi(s, rest) && s !== rest)
        .slice(0, max)
        .map((s) => ({ insert: `/mcp ${s}`, label: s, detail: t("bar.suggest.mcp") }));
    default:
      return [];
  }
}
