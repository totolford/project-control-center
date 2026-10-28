import { useEffect, useState } from "react";
import { api } from "./api";
import type { ClaudeAccountStatus } from "./types";
import { useAppLanguages } from "../i18n/prefs";

/** Account of new Claude sessions; reloads whenever the app setting changes. */
export function useClaudeAccount(): ClaudeAccountStatus | null {
  const selected = useAppLanguages((s) => s.app?.claudeAccount ?? null);
  const [status, setStatus] = useState<ClaudeAccountStatus | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .claudeAccount()
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [selected]);
  return status;
}

/** Label of the active account, null for a folder that is not a known account. */
export function activeAccountLabel(status: ClaudeAccountStatus | null): string | null {
  return status?.accounts.find((a) => a.id === status.activeId)?.label ?? null;
}
