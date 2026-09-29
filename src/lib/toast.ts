// Minimal toast notification store.

import { create } from "zustand";
import { errorMessage } from "./api";

export type ToastTone = "info" | "success" | "error";

export interface Toast {
  id: number;
  tone: ToastTone;
  text: string;
}

interface ToastState {
  toasts: Toast[];
  push: (tone: ToastTone, text: string) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;
const LIFETIME_MS: Record<ToastTone, number> = { info: 4000, success: 3500, error: 8000 };

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (tone, text) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, tone, text }] }));
    window.setTimeout(() => get().dismiss(id), LIFETIME_MS[tone]);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (text: string) => useToasts.getState().push("info", text),
  success: (text: string) => useToasts.getState().push("success", text),
  error: (e: unknown) => useToasts.getState().push("error", errorMessage(e)),
};

/**
 * Runs an api call, reporting failures as an error toast. Resolves to the result, or undefined on error.
 */
export async function attempt<T>(fn: () => Promise<T>, successText?: string): Promise<T | undefined> {
  try {
    const result = await fn();
    if (successText) toast.success(successText);
    return result;
  } catch (e) {
    toast.error(e);
    return undefined;
  }
}

/** Runs an action, reporting failures as an error toast. Resolves to true on success. */
export async function run(fn: () => Promise<unknown>, successText?: string): Promise<boolean> {
  try {
    await fn();
    if (successText) toast.success(successText);
    return true;
  } catch (e) {
    toast.error(e);
    return false;
  }
}
