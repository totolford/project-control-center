// Command interpreter results → what the UI shows and offers (pure, tested).
// Secret values (MCP env / header values) are never part of what is displayed.

import { quotePs } from "./cliArgs";
import type { Intent, Interpretation } from "./types";

export const MASK = "••••";

export interface IntentField {
  label: string;
  value: string;
  mono?: boolean;
}

/** Parsed fields safe to display: env/header names only, values masked. */
export function intentFields(intent: Intent): IntentField[] {
  switch (intent.type) {
    case "add_mcp": {
      const out: IntentField[] = [
        { label: "Name", value: intent.name, mono: true },
        { label: "Transport", value: intent.transport },
      ];
      if (intent.scope) out.push({ label: "Scope", value: intent.scope });
      if (intent.command) out.push({ label: "Command", value: intent.command, mono: true });
      if (intent.args.length > 0) out.push({ label: "Arguments", value: intent.args.join(" "), mono: true });
      if (intent.url) out.push({ label: "URL", value: intent.url, mono: true });
      for (const [name] of intent.env) out.push({ label: "Env", value: `${name}=${MASK}`, mono: true });
      for (const [name] of intent.headers) out.push({ label: "Header", value: `${name}: ${MASK}`, mono: true });
      return out;
    }
    case "ssh": {
      const out: IntentField[] = [
        { label: "User", value: intent.user ?? "(default)" },
        { label: "Host", value: intent.host, mono: true },
        { label: "Port", value: intent.port === null ? "22 (default)" : String(intent.port), mono: true },
        { label: "Key", value: intent.keyPath ?? "(none given)", mono: intent.keyPath !== null },
      ];
      if (intent.remoteCommand) out.push({ label: "Remote command", value: intent.remoteCommand, mono: true });
      return out;
    }
    case "clone":
      return [
        { label: "URL", value: intent.url, mono: true },
        { label: "Directory", value: intent.directory ?? cloneFolderName(intent.url, null), mono: true },
      ];
    case "claude_cli":
      return [{ label: "Arguments", value: intent.args.length > 0 ? intent.args.join(" ") : "(interactive session)", mono: true }];
    case "github_login":
    case "shell":
      return [];
  }
}

/** The raw line may hold secret values only for `claude mcp add` (-e KEY=value, --header): hide it then. */
export function rawIsDisplayable(intent: Intent): boolean {
  return intent.type !== "add_mcp" || (intent.env.length === 0 && intent.headers.length === 0);
}

export type IntentActionId =
  | "create_connection"
  | "ask_central_ssh"
  | "clone"
  | "github_login"
  | "claude_run"
  | "claude_terminal"
  | "give_central"
  | "run_terminal";

export interface IntentAction {
  id: IntentActionId;
  label: string;
  primary?: boolean;
  /** Changes the project (connections, missions): unavailable in compatibility (read-only) mode. */
  mutates: boolean;
}

/** Actions offered for an interpretation, primary first. */
export function intentActions(interp: Pick<Interpretation, "intent">): IntentAction[] {
  const intent = interp.intent;
  switch (intent.type) {
    case "add_mcp":
      return [{ id: "create_connection", label: "Create connection", primary: true, mutates: true }];
    case "ssh":
      return [
        { id: "create_connection", label: "Create connection", primary: true, mutates: true },
        ...(intent.remoteCommand ? [{ id: "ask_central_ssh" as const, label: "Ask Central to run it", mutates: true }] : []),
      ];
    case "clone":
      return [{ id: "clone", label: "Clone…", primary: true, mutates: false }];
    case "github_login":
      return [{ id: "github_login", label: "Sign in to GitHub", primary: true, mutates: false }];
    case "claude_cli":
      return [
        { id: "claude_run", label: "Run", primary: true, mutates: false },
        { id: "claude_terminal", label: "Open in Raw Terminal", mutates: false },
      ];
    case "shell":
      return [
        { id: "give_central", label: "Give to Central", primary: true, mutates: true },
        { id: "run_terminal", label: "Run in Raw Terminal", mutates: false },
      ];
  }
}

/** Mission prompt asking Central to run an SSH command through the project's connection. */
export function sshMissionPrompt(intent: Extract<Intent, { type: "ssh" }>): string {
  const target = intent.user ? `${intent.user}@${intent.host}` : intent.host;
  return `Use the SSH connection to ${target} and run: ${intent.remoteCommand ?? ""}. Report the output.`;
}

/** Mission prompt handing a command line to Central with what the interpreter understood. */
export function shellMissionPrompt(interp: Pick<Interpretation, "raw" | "summary" | "program" | "capability" | "destructive">): string {
  const lines = [
    `Run this command and report the result:`,
    "",
    interp.raw,
    "",
    `Interpreted by NEXUS as: ${interp.summary} (program \`${interp.program}\`, capability ${interp.capability}).`,
  ];
  if (interp.destructive) lines.push("It may be destructive: explain what it changes before running it.");
  return lines.join("\n");
}

/** "owner/repo" for github.com URLs (https, ssh or bare), else null. */
export function githubRepoFromUrl(url: string): string | null {
  const m = /^(?:https?:\/\/|ssh:\/\/git@|git@)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Folder git creates for a clone: the explicit directory, else the last path segment without ".git". */
export function cloneFolderName(url: string, directory: string | null): string {
  if (directory) return directory;
  const last = url.trim().replace(/[/\\]+$/, "").split(/[/:\\]/).pop() ?? "";
  return last.replace(/\.git$/i, "") || "repository";
}

/** Joins a Windows parent folder and a child name. */
export function joinPath(parent: string, child: string): string {
  if (/^[a-zA-Z]:[\\/]|^\\\\|^\//.test(child)) return child;
  return `${parent.replace(/[\\/]+$/, "")}\\${child}`;
}

/** PowerShell line cloning `url` inside `parent` (typed into a Raw Terminal). */
export function gitCloneLine(url: string, directory: string | null, parent: string): string {
  const target = directory ? ` ${quotePs(directory)}` : "";
  return `Set-Location -LiteralPath ${quotePs(parent)}; git clone ${quotePs(url)}${target}`;
}
