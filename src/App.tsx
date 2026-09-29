import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, onEvent } from "./lib/api";
import { APP_NAME, APP_TAGLINE } from "./lib/brand";
import { observeAllLogs, turnOutcome } from "./lib/logBus";
import { isLive } from "./lib/labels";
import { run, toast } from "./lib/toast";
import { useStore } from "./store";
import { Toasts } from "./components/Toasts";
import { PermissionModal } from "./components/PermissionModal";
import { RecoveryDialog } from "./components/RecoveryDialog";
import { AppShell } from "./shell/AppShell";
import { Welcome } from "./views/Welcome";
import { Setup, type FolderInspection } from "./views/Setup";

/** Subscribes once to backend events and logs, and keeps the snapshot fresh. */
function useBackendSync() {
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

function useWindowTitle() {
  const name = useStore((s) => s.project?.info.name);
  useEffect(() => {
    document.title = name ? `${name} — ${APP_NAME}` : `${APP_NAME} — ${APP_TAGLINE}`;
  }, [name]);
}

export function App() {
  const hasProject = useStore((s) => s.project !== null);
  const loadSnapshot = useStore((s) => s.loadSnapshot);
  const [setup, setSetup] = useState<FolderInspection | null>(null);
  useBackendSync();
  useWindowTitle();

  const openFolder = async (path: string) => {
    const inspection = await api.inspectFolder(path);
    if (inspection.isProject) {
      loadSnapshot(await api.openProject(inspection.path));
    } else {
      setSetup(inspection);
    }
  };

  const closeProject = async () => {
    const live = (useStore.getState().project?.agents ?? []).filter((a) => isLive(a.status)).length;
    if (live > 0) {
      const ok = await ask(`${live} ${live === 1 ? "agent is" : "agents are"} still running. Closing the project stops their sessions; they can be recovered next time.`, {
        title: "Close project",
        kind: "warning",
      });
      if (!ok) return;
    }
    if (await run(() => api.closeProject())) useStore.getState().closeProject();
  };

  let content;
  if (setup)
    content = (
      <Setup
        inspection={setup}
        onCancel={() => setSetup(null)}
        onCreated={(snap) => {
          setSetup(null);
          loadSnapshot(snap);
        }}
      />
    );
  else if (hasProject) content = <AppShell onCloseProject={() => void closeProject()} onFolder={openFolder} />;
  else content = <Welcome onFolder={openFolder} onOpened={loadSnapshot} />;

  return (
    <>
      {content}
      {hasProject && !setup && <RecoveryDialog />}
      {hasProject && !setup && <PermissionModal />}
      <Toasts />
    </>
  );
}
