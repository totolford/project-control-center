// Platform (Windows / Ubuntu): typed wrappers over src-tauri/src/platform_commands.rs,
// the cached platform info and the shell-quoting helpers that depend on the OS.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { TerminalProfile } from "./types";

export type Os = "windows" | "linux" | "macos" | "other";

export interface ShellInfo {
  id: string;
  name: string;
  program: string | null;
  args: string[];
  available: boolean;
  default: boolean;
}

export interface TerminalInfo {
  id: string;
  name: string;
  program: string | null;
  available: boolean;
}

export interface OsRelease {
  id: string;
  versionId: string;
  prettyName: string;
  idLike: string[];
}

export interface PlatformInfo {
  os: Os;
  label: string;
  arch: string;
  wsl: boolean;
  distro: OsRelease | null;
  credentialStore: string;
  serviceManager: string | null;
  packageManager: string | null;
  shells: ShellInfo[];
  terminals: TerminalInfo[];
  homeDir: string | null;
  localDataDir: string | null;
}

export type Support = "supported" | "partial" | "unavailable";
export type LiveState = "available" | "missing" | "notApplicable" | "unknown";
export type MatrixColumn = "windows" | "ubuntu" | "wsl" | "docker";

export interface CapabilityCell {
  support: Support;
  note: string | null;
}

export interface Capability {
  id: string;
  name: string;
  windows: CapabilityCell;
  ubuntu: CapabilityCell;
  wsl: CapabilityCell;
  docker: CapabilityCell;
  live: { state: LiveState; detail: string };
}

export interface CapabilityMatrix {
  /** The column NEXUS runs in now. */
  environment: MatrixColumn | "other";
  rows: Capability[];
}

export const platformApi = {
  info: () => invoke<PlatformInfo>("platform_info"),
  capabilities: () => invoke<CapabilityMatrix>("platform_capabilities"),
  /** Opens the system terminal emulator in the project (or home) folder; resolves to its name. */
  openSystemTerminal: () => invoke<string>("open_system_terminal"),
};

/** Synchronous best guess before `platform_info` answers (the webview runs on the same OS). */
export function isWindowsHost(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /Windows/i.test(userAgent);
}

let cached: Promise<PlatformInfo> | null = null;

/** Platform info, fetched once per session (shells do not change while NEXUS runs). */
export function loadPlatform(): Promise<PlatformInfo> {
  if (!cached) {
    cached = platformApi.info();
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

export function usePlatform(): PlatformInfo | null {
  const [info, setInfo] = useState<PlatformInfo | null>(null);
  useEffect(() => {
    let alive = true;
    loadPlatform().then(
      (i) => alive && setInfo(i),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

/** Raw Terminal entries for this machine: Claude Code, then every installed shell (default first). */
export function terminalProfiles(info: Pick<PlatformInfo, "shells"> | null, windows = isWindowsHost()): { profile: Exclude<TerminalProfile, "claude-resume">; label: string }[] {
  const claude = { profile: "claude" as const, label: "Claude Code (interactive)" };
  if (!info) return [claude, { profile: "shell", label: windows ? "PowerShell" : "Default shell" }];
  const shells = info.shells.filter((s) => s.available).sort((a, b) => Number(b.default) - Number(a.default));
  return [claude, ...shells.map((s) => ({ profile: s.id as TerminalProfile as Exclude<TerminalProfile, "claude-resume">, label: s.default ? `${s.name} (default)` : s.name }))];
}

/** POSIX shell quoting (bash, zsh, sh). */
export function quotePosix(arg: string): string {
  return /^[\w\-./:=@+,%]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
