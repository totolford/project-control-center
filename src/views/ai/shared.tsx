// Building blocks shared by the AI Engines view and the AI Setup wizard.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { RotateCw, TriangleAlert, Zap } from "lucide-react";
import { aiApi, onPull } from "../../lib/aiApi";
import type { AiEngineSettings, AiOverview, LocalCapacity, PullEvent } from "../../lib/aiTypes";
import { errorMessage } from "../../lib/api";
import { toast } from "../../lib/toast";
import { useStore } from "../../store";
import { Modal } from "../../components/Modal";
import { Spinner } from "../../components/Common";
import { localUnavailable } from "./aiLogic";

/** Overview of the AI engines, reloaded on demand (each load queries the machine: no cached fiction). */
export function useAiOverview() {
  const [data, setData] = useState<AiOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const o = await aiApi.overview();
      if (alive.current) {
        setData(o);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Live download progress by model (from `pcc://ai-pull`). */
export function usePulls(onDone?: (p: PullEvent) => void) {
  const [pulls, setPulls] = useState<Record<string, PullEvent>>({});
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void onPull((p) => {
      setPulls((s) => {
        if (p.done) {
          const { [p.model]: _, ...rest } = s;
          return rest;
        }
        return { ...s, [p.model]: p };
      });
      if (p.done) done.current?.(p);
    }).then((u) => {
      if (cancelled) u();
      else off = u;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);
  return pulls;
}

/** Saves AI settings and mirrors them into the open project's settings in the store. */
export async function saveAi(settings: AiEngineSettings, successText?: string): Promise<AiEngineSettings | undefined> {
  try {
    const saved = await aiApi.saveSettings(settings);
    const project = useStore.getState().project;
    if (project) useStore.getState().setSettings({ ...project.settings, ai: saved });
    if (successText) toast.success(successText);
    return saved;
  } catch (e) {
    toast.error(e);
    return undefined;
  }
}

export function PullBar({ p }: { p: PullEvent | undefined }) {
  if (!p) return null;
  const pct = p.percent ?? null;
  return (
    <div className="ai-pull" aria-live="polite">
      <div className="ai-pull-track">
        <div className="ai-pull-fill" style={{ width: `${pct ?? 0}%` }} />
      </div>
      <span className="tiny muted mono">
        {p.status}
        {pct !== null ? ` · ${pct.toFixed(1)}%` : ""}
      </span>
    </div>
  );
}

/** Confirmation before anything is installed, downloaded or deleted: shows exactly what will happen. */
export function ConsentModal({
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? "danger" : "primary"}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
              onClose();
            }}
          >
            {busy && <Spinner />} {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

/**
 * "Local AI unavailable." with [Retry] [Restart Local Runtime] [Switch to Claude].
 * Shown only when the configuration uses the local runtime and it does not answer.
 */
export function LocalAiFallback({
  settings,
  capacity,
  onChanged,
}: {
  settings: AiEngineSettings;
  capacity: LocalCapacity | null;
  onChanged: (cap: LocalCapacity) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const reason = localUnavailable(settings, capacity);
  if (!reason) return null;
  const act = async (action: "retry" | "restart" | "switch_to_claude") => {
    setBusy(action);
    try {
      const cap = await aiApi.fallback(action);
      if (action === "switch_to_claude") {
        const project = useStore.getState().project;
        if (project) useStore.getState().setSettings({ ...project.settings, ai: { ...settings, mode: "claude", central: "claude", workers: "claude" } });
        toast.success("Switched to Claude");
      } else if (cap.available) toast.success("Local AI is answering again");
      else toast.info(`Still unavailable: ${cap.reason ?? "no answer"}`);
      onChanged(cap);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="banner banner-warn" role="alert">
      <TriangleAlert size={16} aria-hidden="true" />
      <div className="banner-text">
        <strong>Local AI unavailable.</strong> <span className="muted">{reason}</span>
      </div>
      <div className="banner-actions">
        <button className="btn btn-sm" disabled={!!busy} onClick={() => void act("retry")}>
          {busy === "retry" ? <Spinner /> : <RotateCw size={12} />} Retry
        </button>
        <button className="btn btn-sm" disabled={!!busy} onClick={() => void act("restart")}>
          {busy === "restart" && <Spinner />} Restart Local Runtime
        </button>
        <button className="btn btn-sm primary" disabled={!!busy} onClick={() => void act("switch_to_claude")}>
          {busy === "switch_to_claude" ? <Spinner /> : <Zap size={12} />} Switch to Claude
        </button>
      </div>
    </div>
  );
}
