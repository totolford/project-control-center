// GitHub view helpers over `gh` JSON (pure, tested). Fields are read defensively: never invented.

import type { Access, Agent, GithubAccount, GithubStatus } from "../../lib/types";

export type AccountState = "not_installed" | "not_signed_in" | "signed_in";

export function accountState(status: Pick<GithubStatus, "cliInstalled" | "authenticated">): AccountState {
  if (!status.cliInstalled) return "not_installed";
  return status.authenticated ? "signed_in" : "not_signed_in";
}

/** Value at a dotted path as a string, or null when absent / not scalar. */
export function field(obj: Record<string, unknown> | null | undefined, path: string): string | null {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === "string") return cur;
  if (typeof cur === "number" || typeof cur === "boolean") return String(cur);
  return null;
}

/** First non-null field among several spellings (gh JSON is camelCase, the REST API snake_case). */
export function firstField(obj: Record<string, unknown> | null | undefined, ...paths: string[]): string | null {
  for (const p of paths) {
    const v = field(obj, p);
    if (v !== null) return v;
  }
  return null;
}

export interface RepoRow {
  fullName: string;
  name: string;
  visibility: string;
  language: string | null;
  updatedAt: string | null;
  description: string | null;
  fork: boolean;
  url: string | null;
}

export function repoRow(r: Record<string, unknown>): RepoRow | null {
  const fullName = firstField(r, "nameWithOwner", "full_name");
  if (!fullName) return null;
  const isPrivate = firstField(r, "isPrivate", "private") === "true";
  return {
    fullName,
    name: firstField(r, "name") ?? fullName.split("/").pop() ?? fullName,
    visibility: (firstField(r, "visibility") ?? (isPrivate ? "private" : "public")).toLowerCase(),
    language: firstField(r, "primaryLanguage.name", "language"),
    updatedAt: firstField(r, "updatedAt", "updated_at", "pushedAt"),
    description: firstField(r, "description"),
    fork: firstField(r, "isFork", "fork") === "true",
    url: firstField(r, "url", "html_url"),
  };
}

/** Owners to browse: the signed-in account first, then its organizations. */
export function ownerOptions(account: Pick<GithubAccount, "login" | "organizations"> | null): string[] {
  if (!account) return [];
  return [account.login, ...account.organizations.filter((o) => o !== account.login)];
}

/** "success" / "failure" / "in_progress" … → tone for workflow runs. */
export function runTone(status: string | null, conclusion: string | null): "green" | "red" | "amber" | "grey" | "blue" {
  if (status && status !== "completed") return "blue";
  switch (conclusion) {
    case "success":
      return "green";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "red";
    case "cancelled":
    case "skipped":
    case "neutral":
      return "grey";
    default:
      return "amber";
  }
}

export const GITHUB_CAPS = ["github_read", "github_write", "github_admin"] as const;

/** Each agent's effective GitHub access (UNLOCKED replaces every agent's permissions). */
export function agentGithubAccess(
  agents: Pick<Agent, "id" | "name" | "status" | "permissions">[],
  unlocked: Record<(typeof GITHUB_CAPS)[number], Access> | null,
): { id: string; name: string; access: Access[] }[] {
  return agents
    .filter((a) => a.status !== "retired")
    .map((a) => ({ id: a.id, name: a.name, access: GITHUB_CAPS.map((c) => (unlocked ? unlocked[c] : (a.permissions[c] ?? "deny"))) }));
}
