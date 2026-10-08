import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "./lib/api";
import { APP_NAME, APP_TAGLINE } from "./lib/brand";
import { isLive } from "./lib/labels";
import { run } from "./lib/toast";
import { useStore } from "./store";
import { useBackendSync } from "./state/backendSync";
import { useLanguageSync } from "./i18n/prefs";
import { t, useLocale } from "./i18n";
import { Toasts } from "./components/Toasts";
import { PermissionModal } from "./components/PermissionModal";
import { RecoveryDialog } from "./components/RecoveryDialog";
import { CrashReportNotice } from "./components/CrashReportNotice";
import { OrphanNotice } from "./components/OrphanNotice";
import { MigrationDialog } from "./components/MigrationDialog";
import { useUi } from "./state/ui";
import { AppShell } from "./shell/AppShell";
import { Welcome } from "./views/Welcome";
import { AiSetupGate } from "./views/ai/SetupWizard";
import { Setup, type FolderInspection } from "./views/Setup";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { restoreUiCheckpoint, useRendererHealth } from "./shell/health/health";
import { SafeRecoveryOverlay, SafeRecoveryPanel } from "./shell/health/SafeRecoveryOverlay";
import { Loading } from "./components/Common";

function useWindowTitle() {
  const name = useStore((s) => s.project?.info.name);
  useEffect(() => {
    document.title = name ? `${name} — ${APP_NAME}` : `${APP_NAME} — ${APP_TAGLINE}`;
  }, [name]);
}

/**
 * After an interface reload (watchdog, Safe Recovery, "Reload interface") the engine still has the
 * project open: take it back from the snapshot and restore the UI checkpoint. On a fresh start the
 * backend has no project and this resolves at once.
 */
function useResync(): boolean {
  const [pending, setPending] = useState(true);
  useEffect(() => {
    let alive = true;
    const done = () => alive && setPending(false);
    const timer = window.setTimeout(done, 4000);
    api
      .snapshot()
      .then((snap) => {
        if (!alive || !snap || useStore.getState().project) return;
        useStore.getState().loadSnapshot(snap);
        restoreUiCheckpoint();
      })
      .catch(() => undefined)
      .finally(done);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);
  return pending;
}

/** Whole-window crash: the engine is untouched; show what still runs and reload the interface. */
function RootCrash({ error }: { error: Error }) {
  return (
    <div className="sro-backdrop">
      <SafeRecoveryPanel overlay={{ reason: t("health.crashed", { message: error.message }), auto: true, forced: true }} />
    </div>
  );
}

export function App() {
  useRendererHealth();
  return (
    <ErrorBoundary label={t("health.interface")} fallback={(error) => <RootCrash error={error} />}>
      <AppContent />
      <SafeRecoveryOverlay />
    </ErrorBoundary>
  );
}

function AppContent() {
  const hasProject = useStore((s) => s.project !== null);
  const loadSnapshot = useStore((s) => s.loadSnapshot);
  const [setup, setSetup] = useState<FolderInspection | null>(null);
  useBackendSync();
  useLanguageSync();
  // Re-render the whole tree on a language change, so text computed outside hooks (labels) follows.
  useLocale();
  useWindowTitle();
  const resyncing = useResync();

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
      const ok = await ask(t("health.closeRunning", { count: live }), {
        title: t("cmd.project.close"),
        kind: "warning",
        okLabel: t("cmd.project.close"),
        cancelLabel: t("common.cancel"),
      });
      if (!ok) return;
    }
    if (await run(() => api.closeProject())) useStore.getState().closeProject();
  };

  let content;
  if (resyncing && !hasProject) content = <Loading text={t("health.connectingEngine")} />;
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
  else if (hasProject) content = <AppShell onCloseProject={() => void closeProject()} onFolder={openFolder} />;
  else content = <Welcome onFolder={openFolder} onOpened={loadSnapshot} />;

  return (
    <>
      {content}
      {hasProject && !setup && <MigrationDialog />}
      {hasProject && !setup && <RecoveryDialog />}
      {hasProject && !setup && <PermissionModal />}
      {!setup && <CrashReportNotice />}
      {hasProject && !setup && <OrphanNotice />}
      {!setup && <AiSetupGate />}
      <Toasts />
    </>
  );
}
