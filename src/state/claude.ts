// What the installed Claude Code exposes (api.claudeEnvironment) and the skills inventory.
// Loaded lazily, shared by every view; a refresh never blocks the UI.

import { useEffect } from "react";
import { create } from "zustand";
import { api, errorMessage } from "../lib/api";
import type { ClaudeEnvironment, Skill } from "../lib/types";
import { useStore } from "../store";

interface ClaudeState {
  env: ClaudeEnvironment | null;
  loading: boolean;
  error: string | null;
  skills: Skill[] | null;
  skillsError: string | null;
  load: (force?: boolean) => Promise<void>;
  loadSkills: () => Promise<void>;
}

export const useClaude = create<ClaudeState>((set, get) => ({
  env: null,
  loading: false,
  error: null,
  skills: null,
  skillsError: null,
  load: async (force = false) => {
    if (get().loading || (get().env && !force)) return;
    set({ loading: true, error: null });
    try {
      set({ env: await api.claudeEnvironment() });
    } catch (e) {
      set({ error: errorMessage(e) });
    } finally {
      set({ loading: false });
    }
  },
  loadSkills: async () => {
    try {
      set({ skills: await api.listSkills(), skillsError: null });
    } catch (e) {
      set({ skillsError: errorMessage(e) });
    }
  },
}));

/** The Claude Code environment, loaded on first use. */
export function useClaudeEnv() {
  const env = useClaude((s) => s.env);
  const loading = useClaude((s) => s.loading);
  const error = useClaude((s) => s.error);
  const load = useClaude((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return { env, loading, error, refresh: () => void load(true) };
}

/** Skills inventory, reloaded when a SkillChanged / McpChanged event arrives. */
export function useSkills() {
  const skills = useClaude((s) => s.skills);
  const error = useClaude((s) => s.skillsError);
  const loadSkills = useClaude((s) => s.loadSkills);
  const version = useStore((s) => s.project?.toolsVersion ?? 0);
  useEffect(() => {
    void loadSkills();
  }, [loadSkills, version]);
  return { skills, error };
}

/** Model entries reported by Claude Code (empty while unknown). */
export function useModels(): Record<string, unknown>[] {
  return useClaude((s) => s.env?.models ?? NO_MODELS);
}

const NO_MODELS: Record<string, unknown>[] = [];
