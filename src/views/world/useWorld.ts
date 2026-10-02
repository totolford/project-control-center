// The project's AI World: loaded once, kept current by streamed frames (component state, not zustand).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, onWorld } from "../../lib/api";
import type { World } from "../../lib/types";
import { useStore } from "../../store";
import { applyFrame } from "./frames";

// Authoritative worlds returned by api calls reach every mounted view/panel.
export type Update = World | null | ((w: World | null) => World | null);
const listeners = new Set<(u: Update) => void>();

export function publishWorld(w: Update): void {
  for (const l of listeners) l(w);
}

export interface WorldHandle {
  world: World | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Shares a world returned by the backend (save, control, create, delete → null), or an update of the current one. */
  publish: (w: Update) => void;
}

export function useWorld(): WorldHandle {
  const projectId = useStore((s) => s.project?.info.id ?? null);
  const [world, setWorld] = useState<World | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasWorld = useRef(false);
  hasWorld.current = world !== null;

  const reload = useCallback(async () => {
    try {
      const w = await api.worldGet();
      setWorld(w);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload, projectId]);

  useEffect(() => {
    listeners.add(setWorld);
    return () => {
      listeners.delete(setWorld);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onWorld((frame) => {
      // A frame without a loaded world means it was created elsewhere: fetch it once.
      if (!hasWorld.current) {
        hasWorld.current = true;
        void reload();
        return;
      }
      setWorld((w) => (w ? applyFrame(w, frame) : w));
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reload]);

  return { world, loading, error, reload, publish: publishWorld };
}
