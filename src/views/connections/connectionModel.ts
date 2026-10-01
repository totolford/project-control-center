// Pure helpers of the Connection manager: per-kind forms, descriptions and what agents get.

import type { Connection, ConnectionInput, ConnectionKind } from "../../lib/types";
import { asMcpConfig, nexusTarget } from "../mcp/mcpModel";

export const KIND_LABEL: Record<ConnectionKind, string> = {
  local: "Local",
  git: "Git",
  github: "GitHub",
  gitlab: "GitLab",
  ssh: "SSH",
  sftp: "SFTP",
  terminal: "Terminal",
  http: "HTTP / API",
  mcp: "MCP server",
  roblox_studio: "Roblox Studio",
  docker: "Docker",
};

/** Kinds created from the Add dialog (local and git are derived from the project folder). */
export type FormKind = "github" | "gitlab" | "ssh" | "sftp" | "terminal" | "http" | "docker";
export const FORM_KINDS: FormKind[] = ["github", "gitlab", "ssh", "sftp", "terminal", "http", "docker"];

export const SHELLS = ["powershell", "pwsh", "cmd", "wsl", "bash", "wt"] as const;

export interface ConnForm {
  name: string;
  repo: string;
  host: string;
  port: string;
  user: string;
  auth: "key" | "agent" | "password";
  keyPath: string;
  project: string;
  shell: string;
  distro: string;
  baseUrl: string;
  healthPath: string;
  authHeader: string;
  /** Secret token (GitLab / HTTP). Blank when editing = keep the stored one. */
  token: string;
}

export const EMPTY_FORM: ConnForm = {
  name: "",
  repo: "",
  host: "",
  port: "22",
  user: "",
  auth: "key",
  keyPath: "",
  project: "",
  shell: "powershell",
  distro: "",
  baseUrl: "",
  healthPath: "",
  authHeader: "Authorization",
  token: "",
};

const str = (c: Connection, k: string) => (typeof c.config[k] === "string" ? (c.config[k] as string) : "");

export function formFromConnection(c: Connection): ConnForm {
  const auth = str(c, "auth");
  return {
    ...EMPTY_FORM,
    name: c.name,
    repo: str(c, "repo"),
    host: str(c, "host"),
    port: c.config.port != null ? String(c.config.port) : EMPTY_FORM.port,
    user: str(c, "user"),
    auth: auth === "agent" || auth === "password" ? auth : "key",
    keyPath: str(c, "keyPath"),
    project: str(c, "project"),
    shell: str(c, "shell") || EMPTY_FORM.shell,
    distro: str(c, "distro"),
    baseUrl: str(c, "baseUrl"),
    healthPath: str(c, "healthPath"),
    authHeader: str(c, "authHeader"),
  };
}

/** Connection input of a form, or the first problem to fix. */
export function buildInput(kind: FormKind, f: ConnForm): ConnectionInput | string {
  const name = f.name.trim();
  if (!name) return "Enter a name.";
  const secrets = f.token ? { token: f.token } : undefined;
  switch (kind) {
    case "github":
      return { name, kind, config: f.repo.trim() ? { repo: f.repo.trim() } : {} };
    case "gitlab":
      if (!/^[^/\s]+(\/[^/\s]+)+$/.test(f.project.trim())) return "Enter the project as group/project.";
      return { name, kind, config: { host: f.host.trim(), project: f.project.trim() }, secrets };
    case "ssh":
    case "sftp": {
      if (!f.host.trim() || !f.user.trim()) return "Enter a host and a user.";
      if (/\s/.test(f.host.trim()) || /\s/.test(f.user.trim())) return "Host and user cannot contain spaces.";
      const port = Number(f.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return "Enter a port between 1 and 65535.";
      return {
        name,
        kind,
        config: { host: f.host.trim(), port, user: f.user.trim(), auth: f.auth, keyPath: f.auth === "key" ? f.keyPath.trim() || null : null },
      };
    }
    case "terminal":
      if (!(SHELLS as readonly string[]).includes(f.shell)) return "Choose a shell.";
      return { name, kind, config: { shell: f.shell, distro: f.shell === "wsl" ? f.distro.trim() : "" } };
    case "http":
      if (!/^https?:\/\/\S+$/.test(f.baseUrl.trim())) return "Enter an http(s) base URL.";
      return { name, kind, config: { baseUrl: f.baseUrl.trim(), healthPath: f.healthPath.trim(), authHeader: f.authHeader.trim() }, secrets };
    case "docker":
      return { name, kind, config: {} };
  }
}

/** One-line target of a connection. */
export function describeTarget(c: Connection): string {
  switch (c.kind) {
    case "ssh":
    case "sftp":
      return `${str(c, "user")}@${str(c, "host")}${c.config.port ? `:${String(c.config.port)}` : ""}`;
    case "mcp":
    case "roblox_studio":
      return nexusTarget(asMcpConfig(c.config));
    case "github":
      return str(c, "repo") || "repository from the git remote";
    case "gitlab":
      return `${str(c, "host") || "gitlab.com"}/${str(c, "project")}`;
    case "terminal":
      return str(c, "shell") + (str(c, "distro") ? ` (${str(c, "distro")})` : "");
    case "http":
      return str(c, "baseUrl");
    case "local":
      return "project folder";
    default:
      return "";
  }
}

/** How the connection authenticates; secret names come from connectionSecretKeys (null = not loaded). */
export function authSummary(c: Connection, secretKeys: string[] | null): string {
  const names = secretKeys === null ? (c.credentialRef ? "stored secrets" : "") : secretKeys.join(", ");
  switch (c.kind) {
    case "ssh":
    case "sftp": {
      const auth = str(c, "auth");
      if (auth === "agent") return "ssh-agent";
      if (auth === "password") return "password (not usable by agents: SSH runs without a terminal)";
      return `key file ${str(c, "keyPath") || "(default ~/.ssh keys)"}`;
    }
    case "gitlab":
    case "http":
      return c.credentialRef ? `token in Credential Manager (${names || "token"})` : "no token";
    case "github":
      return "GitHub CLI login (gh auth)";
    case "mcp":
    case "roblox_studio":
      return c.credentialRef ? `secrets in Credential Manager (${names})` : "no secrets";
    default:
      return "none";
  }
}

/** What a granted agent can do with the connection (mirrors the backend's agent prompt and launch). */
export function agentCapabilities(c: Connection): string {
  switch (c.kind) {
    case "mcp":
    case "roblox_studio":
      return `MCP tools mcp__${c.id}__* (needs the mcp permission)`;
    case "ssh":
    case "sftp":
      return `${c.kind} ${str(c, "user")}@${str(c, "host")} with key/agent auth (ssh permissions)`;
    case "gitlab":
      return "glab CLI / GitLab API with GITLAB_HOST and GITLAB_TOKEN in the session";
    case "http": {
      const token = c.credentialRef ? `; token in env PCC_${c.id.replace(/-/g, "_").toUpperCase()}_TOKEN` : "";
      const header = str(c, "authHeader");
      return `HTTP API at ${str(c, "baseUrl")}${token}${token && header ? ` (sent in the ${header} header)` : ""}`;
    }
    case "terminal":
      return `local ${str(c, "shell") || "shell"} shell for commands`;
    case "github":
      return "gh CLI and git push (github permissions)";
    case "docker":
      return "docker CLI";
    case "git":
      return "git in the agent's working directory";
    case "local":
      return "the project folder (file permissions)";
  }
}
