import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "./lib/api";
import { APP_NAME, APP_TAGLINE } from "./lib/brand";
import { isLive } from "./lib/labels";
import { run } from "./lib/toast";
import { useStore } from "./store";
import { useBackendSync } from "./state/backendSync";
import { Toasts } from "./components/Toasts";
import { PermissionModal } from "./components/PermissionModal";
import { RecoveryDialog } from "./components/RecoveryDialog";
import { MigrationDialog } from "./components/MigrationDialog";
import { useUi } from "./state/ui";
import { AppShell } from "./shell/AppShell";
import { Welcome } from "./views/Welcome";
import { Setup, type FolderInspection } from "./views/Setup";

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
    useUi.getState().setWelcomeNotice(null);
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
      {hasProject && !setup && <MigrationDialog />}
      {hasProject && !setup && <RecoveryDialog />}
      {hasProject && !setup && <PermissionModal />}
      <Toasts />
    </>
  );
}
