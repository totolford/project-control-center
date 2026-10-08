// Actions shared by the command interpreter, user requests and the GitHub view.

import { createContext, useContext } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { rollbackNotice } from "../lib/compat";
import { attempt, run } from "../lib/toast";
import type { Mission } from "../lib/types";
import { showTerminal } from "../terminal/openInTerminal";
import { useStore } from "../store";
import { useUi } from "./ui";

/** Opens `gh auth login --web` in a Raw Terminal and shows it. Resolves to true when the session started. */
export async function githubSignIn(): Promise<boolean> {
  const pty = await attempt(() => api.githubLogin(), "GitHub sign-in opened in the Terminal");
  if (!pty) return false;
  showTerminal(pty);
  return true;
}

/** Folder picker; null when cancelled. */
export async function pickFolder(title: string): Promise<string | null> {
  const picked = await attempt(() => open({ directory: true, multiple: false, title }));
  return typeof picked === "string" ? picked : null;
}

/** Clones owner/repo under a folder the user picks; resolves to the new folder or null. */
export async function cloneGithubRepo(repo: string): Promise<string | null> {
  const parent = await pickFolder(`Clone ${repo} into…`);
  if (!parent) return null;
  return (await attempt(() => api.githubClone(repo, parent), `${repo} cloned`)) ?? null;
}

/** Creates a mission for Central and adds it to the store. */
export async function missionForCentral(prompt: string, title?: string): Promise<Mission | undefined> {
  const mission = await attempt(() => api.createMission(prompt, title), "Mission sent to Central");
  if (mission) useStore.getState().upsertMission(mission);
  return mission;
}

/** Restores a backup (the backend closes the project first) and returns to the welcome screen with an explanation. */
export async function rollbackAndClose(root: string, backupId: string): Promise<boolean> {
  if (!(await run(() => api.rollbackProject(root, backupId), "Backup restored"))) return false;
  useUi.getState().setWelcomeNotice(rollbackNotice());
  useStore.getState().closeProject();
  return true;
}

/** App-level "open this folder" (existing project → open, otherwise the project setup screen). */
export const FolderContext = createContext<((path: string) => Promise<void>) | null>(null);

export function useOpenFolder(): ((path: string) => Promise<void>) | null {
  return useContext(FolderContext);
}
