// Install / Enable / Configure / Update / Disable / Uninstall of a market entry,
// each wired to the real mechanism (claude plugin CLI or NEXUS skill folders).
// Unavailable actions are not shown as buttons: their reason is.

import { useState } from "react";
import { Check, Download, Power, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { attempt, toast } from "../../lib/toast";
import type { CliRun, MarketAction, MarketEntry } from "../../lib/types";
import { useStore } from "../../store";
import { Spinner } from "../../components/Common";
import { Modal } from "../../components/Modal";
import { CliRunOutput } from "../mcp/CliRunOutput";
import { InstallDialog } from "./InstallDialog";
import { entryActions, type MarketActionKind } from "./marketModel";
import { useMarket } from "./marketStore";

const LABEL: Record<MarketActionKind, string> = {
  install: "Install",
  enable: "Enable",
  disable: "Disable",
  configure: "Configure",
  update: "Update",
  uninstall: "Uninstall",
};

interface Props {
  entry: MarketEntry;
  compact?: boolean;
}

export function MarketActions({ entry, compact }: Props) {
  const status = useMarket((s) => s.status);
  const reload = useMarket((s) => s.load);
  const navigate = useStore((s) => s.navigate);
  const [dialog, setDialog] = useState<"install" | "update" | "uninstall" | null>(null);
  const [busy, setBusy] = useState<MarketActionKind | null>(null);
  const [output, setOutput] = useState<{ message: string; runs: CliRun[] } | null>(null);
  const actions = entryActions(entry, status);
  const isPlugin = entry.installMethod === "plugin";

  const finish = async (r: MarketAction | undefined) => {
    if (!r) return;
    if (r.ok) toast.success(r.message);
    setOutput(r.ok && compact ? null : { message: r.message, runs: r.runs });
    await reload();
  };

  const toggle = async (enabled: boolean) => {
    setBusy(enabled ? "enable" : "disable");
    const r = await attempt(() => api.marketSetEnabled(entry.id, enabled));
    setBusy(null);
    await finish(r);
  };

  const uninstall = async () => {
    setBusy("uninstall");
    const r = await attempt(() => api.marketUninstall(entry.id));
    setBusy(null);
    setDialog(null);
    await finish(r);
  };

  const configure = async () => {
    if (!isPlugin) {
      navigate({ name: "skills" });
      return;
    }
    setBusy("configure");
    const run = await attempt(() => api.marketPluginOptions(entry.id));
    setBusy(null);
    if (run) setOutput({ message: `Options of ${entry.pluginId} (set them with /plugin configure in Claude Code or the Raw Terminal)`, runs: [run] });
  };

  const click = (kind: MarketActionKind) => {
    switch (kind) {
      case "install":
      case "update":
        setDialog(kind);
        break;
      case "uninstall":
        setDialog("uninstall");
        break;
      case "enable":
      case "disable":
        void toggle(kind === "enable");
        break;
      case "configure":
        void configure();
        break;
    }
  };

  const icon = (kind: MarketActionKind) => {
    if (busy === kind) return <Spinner size={12} />;
    const size = 13;
    switch (kind) {
      case "install":
        return <Download size={size} aria-hidden="true" />;
      case "enable":
      case "disable":
        return <Power size={size} aria-hidden="true" />;
      case "configure":
        return <Settings2 size={size} aria-hidden="true" />;
      case "update":
        return <RefreshCw size={size} aria-hidden="true" />;
      case "uninstall":
        return <Trash2 size={size} aria-hidden="true" />;
    }
  };

  const unavailable = actions.filter((a) => !a.available);
  return (
    <div className="mk-actions" onClick={(e) => e.stopPropagation()}>
      <div className="mk-actions-row">
        {entry.installed && (
          <span className="mk-installed">
            <Check size={13} aria-hidden="true" /> Installed
            {entry.enabled === false && <span className="muted"> (disabled)</span>}
          </span>
        )}
        {actions
          .filter((a) => a.available)
          .map((a) => (
            <button
              key={a.kind}
              className={`btn btn-sm${a.kind === "install" ? " primary" : a.kind === "uninstall" ? " danger-ghost" : ""}`}
              onClick={() => click(a.kind)}
              disabled={busy !== null}
              title={a.kind === "configure" && !isPlugin ? "Edit it in the Skills view" : undefined}
            >
              {icon(a.kind)} {LABEL[a.kind]}
            </button>
          ))}
      </div>
      {unavailable.length > 0 && (
        <div className="muted small mk-unavailable">
          {[...new Set(unavailable.map((a) => a.reason))].map((reason) => (
            <div key={reason}>
              {unavailable
                .filter((a) => a.reason === reason)
                .map((a) => LABEL[a.kind])
                .join(", ")}{" "}
              unavailable: {reason}
            </div>
          ))}
        </div>
      )}
      {!entry.installed && entry.installMethod === "local" && <div className="muted small">Already on disk.</div>}
      {output && (
        <div className="mk-output">
          {!output.runs.length && <div className="notice">{output.message}</div>}
          {output.runs.map((r, i) => (
            <CliRunOutput key={i} run={r} />
          ))}
        </div>
      )}

      {(dialog === "install" || dialog === "update") && (
        <InstallDialog entry={entry} mode={dialog} onClose={() => setDialog(null)} onDone={() => void reload()} />
      )}
      {dialog === "uninstall" && (
        <Modal
          title={`Uninstall ${entry.name}?`}
          onClose={() => setDialog(null)}
          locked={busy === "uninstall"}
          footer={
            <>
              <button className="btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void uninstall()} disabled={busy !== null}>
                {busy === "uninstall" && <Spinner size={12} />} Uninstall
              </button>
            </>
          }
        >
          {isPlugin ? (
            <p>
              Runs <code>claude plugin uninstall {entry.pluginId} --scope {entry.installedScope ?? "user"}</code>: every skill, command, agent and MCP server of the plugin is removed.
            </p>
          ) : (
            <p>The skill folder is moved to skills-trash/ next to the skills folder (recoverable by moving it back).</p>
          )}
        </Modal>
      )}
    </div>
  );
}
