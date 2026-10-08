import { FolderOpen, Play, TriangleAlert, X } from "lucide-react";
import { intentActions, intentFields, rawIsDisplayable } from "../../lib/intents";
import { run } from "../../lib/toast";
import type { Interpretation } from "../../lib/types";
import { useOpenFolder } from "../../state/opsActions";
import { useReadOnly, useStore } from "../../store";
import { Spinner } from "../../components/Common";
import { Chip } from "../../components/StatusBadge";
import { CliRunOutput } from "../../views/mcp/CliRunOutput";
import { useIntentRunner, type RunnerResult } from "./useIntentRunner";
import { useT } from "../../i18n";

function Result({ result, busy, test, onTest }: { result: RunnerResult; busy: boolean; test: ReturnType<typeof useIntentRunner>["test"]; onTest: () => void }) {
  const navigate = useStore((s) => s.navigate);
  const openFolder = useOpenFolder();
  const t = useT();
  switch (result.type) {
    case "applied": {
      const c = result.applied.connection;
      const mcp = c && (c.kind === "mcp" || c.kind === "roblox_studio");
      return (
        <div className="notice cmd-result">
          <span className="grow">
            {result.applied.message}
            {c && (
              <>
                {" · "}
                <button className="link-btn" onClick={() => navigate({ name: mcp ? "mcp" : "connections" })}>
                  {t("msg.cmd.inView", { name: c.name, view: mcp ? "MCP" : t("nav.connections") })}
                </button>
              </>
            )}
            {test && <div className={`small ${test.ok ? "tone-green-fg" : "tone-red-fg"}`}>{test.text}</div>}
          </span>
          {c && (
            <button className="btn btn-sm" onClick={onTest} disabled={busy}>
              {busy ? <Spinner size={11} /> : <Play size={11} />} {t("msg.cmd.test")}
            </button>
          )}
        </div>
      );
    }
    case "cloned":
      return (
        <div className="notice cmd-result">
          <span className="grow">
            {result.viaTerminal ? t("msg.cmd.cloneTerminal") : t("msg.cmd.clonedInto")}
            <code>{result.folder}</code>
          </span>
          <button className="btn btn-sm" disabled={!openFolder} onClick={() => openFolder && void run(() => openFolder(result.folder))}>
            <FolderOpen size={11} /> {t("msg.cmd.openAsProject")}
          </button>
        </div>
      );
    case "cli":
      return <CliRunOutput run={result.run} />;
    case "done":
      return <div className="notice cmd-result">{result.text}</div>;
  }
}

/** What the interpreter understood from a pasted command line, and what NEXUS can do with it. */
export function CommandCard({ interp, onClose }: { interp: Interpretation; onClose: () => void }) {
  const readOnly = useReadOnly();
  const { busy, result, test, act, runTest } = useIntentRunner(interp);
  const fields = intentFields(interp.intent);
  const conn = result?.type === "applied" ? result.applied.connection : null;
  const t = useT();

  return (
    <div className="cmd-card" aria-label={t("msg.cmd.aria")}>
      <div className="cmd-card-head">
        <strong className="grow">{interp.summary}</strong>
        <code>{interp.program}</code>
        <Chip tone={interp.destructive ? "red" : "accent"}>{interp.capability}</Chip>
        <button className="icon-btn" onClick={onClose} aria-label={t("msg.cmd.close")}>
          <X size={13} />
        </button>
      </div>
      {interp.destructive && (
        <div className="notice notice-warn small">
          <TriangleAlert size={13} /> {t("msg.cmd.destructive")}
        </div>
      )}
      {rawIsDisplayable(interp.intent) ? (
        <pre className="cmd-raw mono">{interp.raw}</pre>
      ) : (
        <div className="muted small">{t("msg.cmd.secret")}</div>
      )}
      {fields.length > 0 && (
        <dl className="kv kv-tight cmd-fields">
          {fields.map((f, i) => (
            <div key={i} className="kv-pair">
              <dt>{f.label}</dt>
              <dd className={f.mono ? "mono" : undefined}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="row cmd-actions">
        {intentActions(interp).map((a) => (
          <button
            key={a.id}
            className={`btn btn-sm${a.primary ? " primary" : ""}`}
            disabled={busy !== null || (a.mutates && readOnly)}
            title={a.mutates && readOnly ? t("common.readOnly") : undefined}
            onClick={() => void act(a.id)}
          >
            {busy === a.id && <Spinner size={11} />} {a.label}
          </button>
        ))}
      </div>
      {result && <Result result={result} busy={busy === "test"} test={test} onTest={() => conn && void runTest(conn)} />}
    </div>
  );
}
