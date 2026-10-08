import { useEffect, useState } from "react";
import { Download, ExternalLink, Play, RotateCw, Server, ShieldAlert, Square, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { aiApi } from "../../lib/aiApi";
import type { AiOverview, InstallPlan, RuntimeStatus } from "../../lib/aiTypes";
import { attempt, toast } from "../../lib/toast";
import { Field, Spinner } from "../../components/Common";
import { ConsentModal } from "./shared";
import { lazyLabels, rich, useT } from "../../i18n";

type InstallAction = "install" | "update" | "uninstall";

const METHOD_TEXT = lazyLabels<Exclude<InstallPlan["method"], "manual">>({
  winget: "platform.install.method.winget",
  script: "platform.install.method.script",
  apt: "platform.install.method.apt",
});
const VERB = lazyLabels<InstallAction>({ install: "platform.install.verb.install", update: "platform.install.verb.update", uninstall: "platform.install.verb.uninstall" });
const DONE = { install: "platform.install.done.install", update: "platform.install.done.update", uninstall: "platform.install.done.uninstall" } as const;

/** Install / update / uninstall with this OS's installer (winget, official
 * script, apt), after showing the exact command. A runtime NEXUS cannot
 * install here shows why and where to do it by hand. */
export function InstallConsent({
  runtime,
  action,
  onDone,
  onClose,
}: {
  runtime: RuntimeStatus;
  action: InstallAction;
  onDone: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  useEffect(() => {
    aiApi.runtimePlan(runtime.id, action).then(setPlan, (e) => toast.error(e));
  }, [runtime.id, action]);
  const verb = VERB[action];
  const runnable = !!plan?.available;
  return (
    <ConsentModal
      title={t("platform.install.title", { verb, name: runtime.name })}
      confirmLabel={t("platform.install.confirm", { verb })}
      danger={action === "uninstall"}
      confirmDisabled={!runnable}
      onClose={onClose}
      onConfirm={async () => {
        const out = await attempt(() => aiApi.runtimeInstall(runtime.id, action), t(DONE[action], { name: runtime.name }));
        if (out !== undefined) onDone();
      }}
    >
      {!plan && <p className="muted small">{t("platform.install.preparing")}</p>}
      {plan && plan.method !== "manual" && (
        <>
          <p>
            {rich(t(action === "uninstall" ? "platform.install.willRemove" : "platform.install.willInstall", { method: METHOD_TEXT[plan.method], source: plan.source }), {
              name: <strong>{runtime.name}</strong>,
            })}
          </p>
          <pre className="ai-cmd mono">{plan.display}</pre>
          {plan.elevated && (
            <p className="small">
              <ShieldAlert size={12} aria-hidden="true" /> {t("platform.install.elevated")}
            </p>
          )}
        </>
      )}
      {plan && !plan.available && <div className="notice notice-warn small">{plan.reason ?? t("platform.install.notAvailable")}</div>}
      {plan?.docsUrl && (
        <button className="link-btn small" onClick={() => void openUrl(plan.docsUrl!).catch((e) => toast.error(e))}>
          <ExternalLink size={11} aria-hidden="true" /> {t("platform.install.docs")}
        </button>
      )}
      {action === "uninstall" && <p className="muted small">{t("platform.install.keepModels")}</p>}
      {runnable && <p className="muted small">{t("platform.install.slow")}</p>}
    </ConsentModal>
  );
}

function RuntimeCard({ r, onChanged }: { r: RuntimeStatus; onChanged: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [consent, setConsent] = useState<InstallAction | null>(null);
  const [latest, setLatest] = useState<string | null | undefined>(undefined);
  const [gguf, setGguf] = useState("");
  const act = async (name: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(name);
    const res = await attempt(fn, ok);
    setBusy(null);
    if (res !== undefined) onChanged();
  };
  const tone = r.health.ok ? "green" : r.installed ? "amber" : "grey";
  const state = r.health.ok ? `Running · ${r.health.latencyMs} ms` : r.installed ? "Installed · stopped" : "Not installed";
  return (
    <section className="panel ai-runtime">
      <header className="panel-header">
        <h3>
          <Server size={14} aria-hidden="true" /> {r.name} {r.version && <span className="mono muted small">v{r.version}</span>}
        </h3>
        <span className={`chip tone-${tone}`}>{state}</span>
      </header>
      <div className="panel-body">
        <p className="muted small">{r.description}</p>
        <dl className="kv">
          <dt>Address</dt>
          <dd className="mono small">{r.baseUrl}</dd>
          <dt>{t("platform.runtime.installedFrom")}</dt>
          <dd className="small">{r.installSource}</dd>
          <dt>Executable</dt>
          <dd className="mono small">{r.executable ?? "—"}</dd>
          <dt>Process</dt>
          <dd className="small">{r.managedPid ? `started by NEXUS · pid ${r.managedPid}` : r.health.ok ? "started outside NEXUS" : "—"}</dd>
          <dt>Claude Code agents</dt>
          <dd className="small">
            {r.anthropicApi ? <span className="chip tone-green">Anthropic API available</span> : <span className="chip tone-dim">{r.health.ok ? "no Anthropic API" : "unknown (not running)"}</span>}
          </dd>
          {latest !== undefined && (
            <>
              <dt>Latest version</dt>
              <dd className="mono small">{latest ?? "not found"}</dd>
            </>
          )}
        </dl>
        {r.health.error && !r.health.ok && r.installed && <div className="notice notice-warn small">{r.health.error}</div>}
        {r.notes.map((n) => (
          <div key={n} className="notice small">
            {n}
          </div>
        ))}
        {r.id === "llamacpp" && r.installed && !r.health.ok && (
          <Field label="GGUF model file" hint="llama-server serves one GGUF file">
            <input className="input mono" value={gguf} onChange={(e) => setGguf(e.target.value)} placeholder={navigator.userAgent.includes("Windows") ? "C:\\models\\model.gguf" : "/home/you/models/model.gguf"} />
          </Field>
        )}
        <div className="row ai-actions">
          {!r.installed && (
            <button className="btn btn-sm primary" disabled={!!busy} onClick={() => setConsent("install")}>
              <Download size={12} /> Install…
            </button>
          )}
          {r.installed && !r.health.ok && (
            <button
              className="btn btn-sm primary"
              disabled={!!busy}
              onClick={() => void act("start", () => aiApi.runtimeStart(r.id, gguf || undefined), `${r.name} is running`)}
            >
              {busy === "start" ? <Spinner /> : <Play size={12} />} Start
            </button>
          )}
          {r.health.ok && (
            <>
              <button className="btn btn-sm" disabled={!!busy} onClick={() => void act("restart", () => aiApi.runtimeRestart(r.id, gguf || undefined), `${r.name} restarted`)}>
                {busy === "restart" ? <Spinner /> : <RotateCw size={12} />} Restart
              </button>
              <button
                className="btn btn-sm"
                disabled={!!busy || (!r.managedPid && r.id !== "lmstudio")}
                title={!r.managedPid && r.id !== "lmstudio" ? "Started outside NEXUS: quit it from its own window or tray icon" : ""}
                onClick={() => void act("stop", () => aiApi.runtimeStop(r.id), `${r.name} stopped`)}
              >
                {busy === "stop" ? <Spinner /> : <Square size={12} />} Stop
              </button>
            </>
          )}
          {r.installed && (
            <>
              <button
                className="btn btn-sm ghost"
                disabled={!!busy}
                onClick={async () => {
                  setBusy("latest");
                  setLatest((await attempt(() => aiApi.runtimeLatest(r.id))) ?? null);
                  setBusy(null);
                }}
              >
                {busy === "latest" && <Spinner />} Check for update
              </button>
              {latest && latest !== r.version && (
                <button className="btn btn-sm" disabled={!!busy} onClick={() => setConsent("update")}>
                  Update to {latest}…
                </button>
              )}
              <button className="btn btn-sm danger-ghost" disabled={!!busy} onClick={() => setConsent("uninstall")}>
                <Trash2 size={12} /> Uninstall…
              </button>
            </>
          )}
        </div>
      </div>
      {consent && <InstallConsent runtime={r} action={consent} onClose={() => setConsent(null)} onDone={onChanged} />}
    </section>
  );
}

export function RuntimesPanel({ data, onChanged }: { data: AiOverview; onChanged: () => void }) {
  const t = useT();
  return (
    <div className="stack">
      {data.installer === "winget" && !data.winget && <div className="notice notice-warn">{t("platform.runtime.noWinget")}</div>}
      <div className="ai-grid">
        {data.runtimes.map((r) => (
          <RuntimeCard key={r.id} r={r} onChanged={onChanged} />
        ))}
      </div>
    </div>
  );
}
