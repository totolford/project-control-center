import { useEffect, useState } from "react";
import { api, onEvent } from "./lib/api";
import { toast } from "./lib/toast";
import { useStore } from "./store";
import { Toasts } from "./components/Toasts";
import { PermissionModal } from "./components/PermissionModal";
import { RecoveryDialog } from "./components/RecoveryDialog";
import { MainLayout } from "./layout/MainLayout";
import { Welcome } from "./views/Welcome";
import { Setup, type FolderInspection } from "./views/Setup";

/** Subscribes once to backend events and keeps the snapshot fresh. */
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
      else if (e.kind === "ReviewRequested") toast.info(e.summary);
      else if (e.kind === "GitChanged") refreshSoon();
    });
    const onFocus = () => void useStore.getState().refresh().catch(() => undefined);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(gitTimer);
      window.removeEventListener("focus", onFocus);
      void unlisten.then((f) => f());
    };
  }, []);
}

export function App() {
  const hasProject = useStore((s) => s.project !== null);
  const loadSnapshot = useStore((s) => s.loadSnapshot);
  const [setup, setSetup] = useState<FolderInspection | null>(null);
  useBackendSync();

  const openFolder = async (path: string) => {
    const inspection = await api.inspectFolder(path);
    if (inspection.isProject) {
      loadSnapshot(await api.openProject(inspection.path));
    } else {
      setSetup(inspection);
    }
  };

  let content;
  if (hasProject) content = <MainLayout />;
  else if (setup)
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
  else content = <Welcome onFolder={openFolder} onOpened={loadSnapshot} />;

  return (
    <>
      {content}
      {hasProject && <RecoveryDialog />}
      {hasProject && <PermissionModal />}
      <Toasts />
    </>
  );
}
