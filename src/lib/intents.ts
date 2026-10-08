// Command interpreter results → what the UI shows and offers (pure, tested).
// Secret values (MCP env / header values) are never part of what is displayed.

import { quotePs } from "./cliArgs";
import { quotePosix } from "./platform";
import type { Intent, Interpretation } from "./types";
import { t } from "../i18n";

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
        { label: t("msg.field.name"), value: intent.name, mono: true },
        { label: t("msg.field.transport"), value: intent.transport },
      ];
      if (intent.scope) out.push({ label: t("msg.field.scope"), value: intent.scope });
      if (intent.command) out.push({ label: t("msg.field.command"), value: intent.command, mono: true });
      if (intent.args.length > 0) out.push({ label: t("msg.field.arguments"), value: intent.args.join(" "), mono: true });
      if (intent.url) out.push({ label: "URL", value: intent.url, mono: true });
      for (const [name] of intent.env) out.push({ label: t("msg.field.env"), value: `${name}=${MASK}`, mono: true });
      for (const [name] of intent.headers) out.push({ label: t("msg.field.header"), value: `${name}: ${MASK}`, mono: true });
      return out;
    }
    case "ssh": {
      const out: IntentField[] = [
        { label: t("msg.field.user"), value: intent.user ?? t("msg.field.default") },
        { label: t("msg.field.host"), value: intent.host, mono: true },
        { label: t("msg.field.port"), value: intent.port === null ? t("msg.field.portDefault") : String(intent.port), mono: true },
        { label: t("msg.field.key"), value: intent.keyPath ?? t("msg.field.noneGiven"), mono: intent.keyPath !== null },
      ];
      if (intent.remoteCommand) out.push({ label: t("msg.field.remoteCommand"), value: intent.remoteCommand, mono: true });
      return out;
    }
    case "clone":
      return [
        { label: "URL", value: intent.url, mono: true },
        { label: t("msg.field.directory"), value: intent.directory ?? cloneFolderName(intent.url, null), mono: true },
      ];
    case "claude_cli":
      return [{ label: t("msg.field.arguments"), value: intent.args.length > 0 ? intent.args.join(" ") : t("msg.field.interactive"), mono: true }];
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
      return [{ id: "create_connection", label: t("msg.action.createConnection"), primary: true, mutates: true }];
    case "ssh":
      return [
        { id: "create_connection", label: t("msg.action.createConnection"), primary: true, mutates: true },
        ...(intent.remoteCommand ? [{ id: "ask_central_ssh" as const, label: t("msg.action.askCentral"), mutates: true }] : []),
      ];
    case "clone":
      return [{ id: "clone", label: t("msg.action.clone"), primary: true, mutates: false }];
    case "github_login":
      return [{ id: "github_login", label: t("bar.req.signIn"), primary: true, mutates: false }];
    case "claude_cli":
      return [
        { id: "claude_run", label: t("msg.action.run"), primary: true, mutates: false },
        { id: "claude_terminal", label: t("msg.action.openTerminal"), mutates: false },
      ];
    case "shell":
      return [
        { id: "give_central", label: t("msg.action.giveCentral"), primary: true, mutates: true },
        { id: "run_terminal", label: t("msg.action.runTerminal"), mutates: false },
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

/** A POSIX path (`/home/…`): Linux conventions apply. */
function isPosixPath(p: string): boolean {
  return p.startsWith("/");
}

/** Joins a parent folder and a child name with the parent's separator (`\` on Windows, `/` on Linux). */
export function joinPath(parent: string, child: string): string {
  if (/^[a-zA-Z]:[\\/]|^\\\\|^\//.test(child)) return child;
  const sep = isPosixPath(parent) ? "/" : "\\";
  return `${parent.replace(/[\\/]+$/, "")}${sep}${child}`;
}

/** Line cloning `url` inside `parent`, typed into a Raw Terminal: PowerShell for a Windows
 * folder, POSIX shell for a Linux one. */
export function gitCloneLine(url: string, directory: string | null, parent: string): string {
  if (isPosixPath(parent)) {
    const target = directory ? ` ${quotePosix(directory)}` : "";
    return `cd -- ${quotePosix(parent)} && git clone ${quotePosix(url)}${target}`;
  }
  const target = directory ? ` ${quotePs(directory)}` : "";
  return `Set-Location -LiteralPath ${quotePs(parent)}; git clone ${quotePs(url)}${target}`;
}
