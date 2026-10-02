// Text of user requests (agents waiting for a human), pure and tested.

import type { UserRequest } from "./types";

export function requestHeadline(req: UserRequest, agent: string, connection: string | null): string {
  const target = connection ?? req.connectionId ?? "the project";
  switch (req.kind) {
    case "secret":
      return `${agent} needs \`${req.key ?? "a secret"}\` for ${target}`;
    case "ssh_key_setup":
      return `${agent} needs SSH key access to ${target}`;
    case "github_login":
      return `${agent} needs you to sign in to GitHub`;
    case "action":
      return req.title || `${agent} needs you`;
  }
}

/** Oldest first, so the queue answers requests in the order agents asked. */
export function orderRequests(list: UserRequest[]): UserRequest[] {
  return [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
