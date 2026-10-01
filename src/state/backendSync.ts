import { useEffect } from "react";
import { onEvent } from "../lib/api";
import { observeAllLogs, turnOutcome } from "../lib/logBus";
import { toast } from "../lib/toast";
import { useStore } from "../store";

/** Subscribes once to backend events and logs, and keeps the snapshot fresh (main and detached windows). */
export function useBackendSync() {
  useEffect(() => {
    let gitTimer: number | undefined;
    const refreshSoon = () => {
      window.clearTimeout(gitTimer);
      gitTimer = window.setTimeout(() => void useStore.getState().refresh().catch(() => undefined), 400);
    };
    const unlisten = onEvent((e) => {
      const store = useStore.getState();
      if (!store.project) return;
      store.applyEvent(e);
      if (e.kind === "Error") toast.error(e.summary);
      else if (e.kind === "GitChanged") refreshSoon();
    });
    const stopLogs = observeAllLogs((entry) => {
      const outcome = turnOutcome(entry);
      if (outcome !== null) useStore.getState().setTurnError(entry.agentId, outcome);
    });
    const onFocus = () => void useStore.getState().refresh().catch(() => undefined);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(gitTimer);
      window.removeEventListener("focus", onFocus);
      stopLogs();
      void unlisten.then((f) => f());
    };
  }, []);
}
