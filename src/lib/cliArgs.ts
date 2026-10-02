// Command Center logic over the CLI tree parsed from `claude --help` (pure, tested).

import type { CliCommand, CliOption } from "./types";

export function commandKey(c: Pick<CliCommand, "path">): string {
  return c.path.join(" ");
}

export function commandLabel(c: Pick<CliCommand, "path">): string {
  return c.path.length === 0 ? "claude" : `claude ${c.path.join(" ")}`;
}

/** Root first, then every command depth-first. */
export function flattenCommands(root: CliCommand): CliCommand[] {
  const out: CliCommand[] = [];
  const walk = (c: CliCommand) => {
    out.push(c);
    c.subcommands.forEach(walk);
  };
  walk(root);
  return out;
}

export function categories(list: CliCommand[]): string[] {
  return [...new Set(list.map((c) => c.category).filter((c) => c.length > 0))].sort();
}

export function filterCommands(list: CliCommand[], query: string, category: string): CliCommand[] {
  const q = query.trim().toLowerCase();
  return list.filter(
    (c) =>
      (!category || c.category === category) &&
      (!q ||
        commandLabel(c).toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.aliases.some((a) => a.toLowerCase().includes(q)) ||
        c.options.some((o) => o.flags.toLowerCase().includes(q))),
  );
}

const MUTATING = /^(add|remove|rm|install|uninstall|update|upgrade|enable|disable|configure|reset|delete|set|import|migrate)\b/;

/** Commands that change configuration or the installation: confirmed before running. */
export function isMutating(c: Pick<CliCommand, "path">): boolean {
  return c.path.some((segment) => MUTATING.test(segment));
}

const INTERACTIVE = new Set(["", "auth login", "setup-token", "attach", "doctor", "login"]);

/** Commands that open a TUI or a browser flow: they belong in the Raw Terminal. */
export function isInteractive(c: Pick<CliCommand, "path">): boolean {
  return INTERACTIVE.has(commandKey(c));
}

export interface ArgSpec {
  name: string;
  required: boolean;
  variadic: boolean;
}

/** "<name>" (required), "[args...]" (optional, variadic) → spec. */
export function parseArgName(raw: string): ArgSpec {
  const t = raw.trim();
  const variadic = t.includes("...");
  const name = t.replace(/^[<[]|[>\]]$/g, "").replace("...", "").trim();
  return { name: name || t, required: t.startsWith("<"), variadic };
}

/** Splits a command-line fragment on whitespace, honouring double quotes. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2]);
  return out;
}

export function optionName(o: Pick<CliOption, "long" | "short" | "flags">): string {
  return o.long ?? o.short ?? o.flags.split(/[ ,]/)[0];
}

/** Flag options carry a boolean, valued options a string (empty = omitted). */
export type OptionValues = Record<string, string | boolean>;

/** Arguments for api.runClaudeCli (without the executable). */
export function buildArgs(command: Pick<CliCommand, "path" | "arguments" | "options">, positional: Record<string, string>, options: OptionValues): string[] {
  const args = [...command.path];
  for (const a of command.arguments) {
    const spec = parseArgName(a.name);
    const raw = (positional[a.name] ?? "").trim();
    if (!raw) continue;
    if (spec.variadic) args.push(...splitArgs(raw));
    else args.push(raw.replace(/^"(.*)"$/, "$1"));
  }
  for (const o of command.options) {
    const name = optionName(o);
    const v = options[name];
    if (o.value === null) {
      if (v === true) args.push(name);
    } else if (typeof v === "string" && v.trim()) {
      args.push(name, ...(o.value.includes("...") ? splitArgs(v) : [v.trim()]));
    }
  }
  return args;
}

/** Missing required positional arguments (by display name). */
export function missingArgs(command: Pick<CliCommand, "arguments">, positional: Record<string, string>): string[] {
  return command.arguments.filter((a) => parseArgName(a.name).required && !(positional[a.name] ?? "").trim()).map((a) => parseArgName(a.name).name);
}

/** Quotes one PowerShell argument (single quotes unless it is a plain word). */
export function quotePs(arg: string): string {
  return /^[\w\-./:=@]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`;
}

/** PowerShell line that runs Claude Code with `args` (typed into a Raw Terminal). */
export function powershellLine(exe: string | null, args: string[]): string {
  const head = exe ? `& ${quotePs(exe)}` : "claude";
  return [head, ...args.map(quotePs)].join(" ");
}
