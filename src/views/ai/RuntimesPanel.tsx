import { useEffect, useState } from "react";
import { Download, Play, RotateCw, Server, Square, Trash2 } from "lucide-react";
import { aiApi } from "../../lib/aiApi";
import type { AiOverview, RuntimeStatus } from "../../lib/aiTypes";
import { attempt, toast } from "../../lib/toast";
import { Field, Spinner } from "../../components/Common";
import { ConsentModal } from "./shared";

type WingetAction = "install" | "update" | "uninstall";

/** Install / update / uninstall through winget, after showing the exact command. */
export function WingetConsent({
  runtime,
  action,
  onDone,
  onClose,
}: {
  runtime: RuntimeStatus;
  action: WingetAction;
  onDone: () => void;
  onClose: () => void;
}) {
  const [command, setCommand] = useState<string | null>(null);
  useEffect(() => {
    aiApi.runtimeCommand(runtime.id, action).then(setCommand, (e) => toast.error(e));
  }, [runtime.id, action]);
  const verb = action === "install" ? "Install" : action === "update" ? "Update" : "Uninstall";
  return (
    <ConsentModal
      title={`${verb} ${runtime.name}`}
      confirmLabel={`${verb} now`}
      danger={action === "uninstall"}
      onClose={onClose}
      onConfirm={async () => {
        const out = await attempt(() => aiApi.runtimeWinget(runtime.id, action), `${runtime.name}: ${verb.toLowerCase()} finished`);
        if (out !== undefined) onDone();
      }}
    >
      <p>
        NEXUS will run this command with Windows Package Manager. It {action === "uninstall" ? "removes" : "downloads and installs"}{" "}
        <strong>{runtime.name}</strong> from the winget repository ({runtime.wingetId}).
      </p>
      <pre className="ai-cmd mono">{command ?? "…"}</pre>
      {action === "uninstall" && <p className="muted small">Downloaded models are kept in the models folder; delete them first if you want the space back.</p>}
      <p className="muted small">It can take several minutes. Nothing runs until you confirm.</p>
    </ConsentModal>
  );
}

function RuntimeCard({ r, winget, onChanged }: { r: RuntimeStatus; winget: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [consent, setConsent] = useState<WingetAction | null>(null);
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
              <dt>winget version</dt>
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
            <input className="input mono" value={gguf} onChange={(e) => setGguf(e.target.value)} placeholder="C:\models\model.gguf" />
          </Field>
        )}
        <div className="row ai-actions">
          {!r.installed && (
            <button className="btn btn-sm primary" disabled={!winget || !!busy} onClick={() => setConsent("install")} title={winget ? "" : "winget is not available on this PC"}>
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
                <button className="btn btn-sm" disabled={!winget || !!busy} onClick={() => setConsent("update")}>
                  Update to {latest}…
                </button>
              )}
              <button className="btn btn-sm danger-ghost" disabled={!winget || !!busy} onClick={() => setConsent("uninstall")}>
                <Trash2 size={12} /> Uninstall…
              </button>
            </>
          )}
        </div>
      </div>
      {consent && <WingetConsent runtime={r} action={consent} onClose={() => setConsent(null)} onDone={onChanged} />}
    </section>
  );
}

export function RuntimesPanel({ data, onChanged }: { data: AiOverview; onChanged: () => void }) {
  return (
    <div className="stack">
      {!data.winget && <div className="notice notice-warn">winget is not available: runtimes can only be installed from their websites.</div>}
      <div className="ai-grid">
        {data.runtimes.map((r) => (
          <RuntimeCard key={r.id} r={r} winget={data.winget} onChanged={onChanged} />
        ))}
      </div>
    </div>
  );
}
