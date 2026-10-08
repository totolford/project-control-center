// Text of user requests (agents waiting for a human), pure and tested.

import type { UserRequest } from "./types";
import { t } from "../i18n";

export function requestHeadline(req: UserRequest, agent: string, connection: string | null): string {
  const target = connection ?? req.connectionId ?? t("bar.req.theProject");
  switch (req.kind) {
    case "secret":
      return t("bar.req.secret", { agent, key: req.key ?? t("bar.req.aSecret"), target });
    case "ssh_key_setup":
      return t("bar.req.ssh", { agent, target });
    case "github_login":
      return t("bar.req.github", { agent });
    case "action":
      return req.title || t("bar.req.action", { agent });
  }
}

/** Oldest first, so the queue answers requests in the order agents asked. */
export function orderRequests(list: UserRequest[]): UserRequest[] {
  return [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
