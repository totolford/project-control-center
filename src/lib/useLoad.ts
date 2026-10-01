import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";

/** Loads one api result on mount (and on reload), keeping the last value while reloading. */
export function useLoad<T>(fn: () => Promise<T>) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const value = await fnRef.current();
      if (alive.current) {
        setData(value);
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

  return { data, error, loading, reload };
}
