import { useEffect, useState } from "react";
import { ChevronDown, FolderOpen, FolderPlus, FolderSearch, History, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { attempt, run } from "../lib/toast";
import type { MenuEntry } from "../components/Menu";
import { Menu } from "../components/Menu";
import type { RecentProject } from "../lib/types";
import { useStore } from "../store";
import { useT } from "../i18n";

/** "Projects › <name ▾>" with the project menu (switch, create/open, reveal, close). */
export function ProjectBreadcrumb({ onCloseProject, onFolder }: { onCloseProject: () => void; onFolder: (path: string) => Promise<void> }) {
  const info = useStore((s) => s.project?.info);
  const loadSnapshot = useStore((s) => s.loadSnapshot);
  const [recent, setRecent] = useState<RecentProject[] | null>(null);
  const t = useT();
  const root = info?.root;
  useEffect(() => {
    if (root) void attempt(() => api.recentProjects()).then((r) => setRecent(r ?? []));
  }, [root]);
  if (!info) return null;

  const pickFolder = async (title: string) => {
    const picked = await attempt(() => open({ directory: true, multiple: false, title }));
    if (typeof picked === "string") await run(() => onFolder(picked));
  };

  const switchTo = async (root: string) => {
    const snap = await attempt(() => api.openProject(root));
    if (snap) loadSnapshot(snap);
  };

  const entries = (): MenuEntry[] => {
    const others = (recent ?? []).filter((p) => p.root !== info.root);
    return [
      { heading: t("cmd.project.switch") },
      ...(recent === null
        ? [{ label: t("cmd.project.loadingRecent"), disabled: true }]
        : others.length === 0
          ? [{ label: t("cmd.project.noRecent"), disabled: true }]
          : others.map((p) => ({
              label: p.name,
              detail: p.available ? p.root : t("cmd.project.unavailable", { path: p.root }),
              icon: <History size={13} />,
              disabled: !p.available,
              onSelect: () => void switchTo(p.root),
            }))),
      "separator",
      { label: t("cmd.project.create"), icon: <FolderPlus size={13} />, onSelect: () => void pickFolder(t("cmd.project.createTitle")) },
      { label: t("cmd.project.open"), icon: <FolderOpen size={13} />, onSelect: () => void pickFolder(t("cmd.project.openTitle")) },
      "separator",
      { label: t("cmd.project.openFolder"), detail: info.root, icon: <FolderOpen size={13} />, onSelect: () => void run(() => api.openPath(info.root)) },
      { label: t("cmd.project.reveal"), icon: <FolderSearch size={13} />, onSelect: () => void run(() => api.revealPath(info.root)) },
      "separator",
      { label: t("cmd.project.close"), icon: <X size={13} />, danger: true, onSelect: onCloseProject },
    ];
  };

  return (
    <nav className="breadcrumb" aria-label={t("cmd.project.aria")}>
      <span className="muted breadcrumb-sep" aria-hidden="true">/</span>
      <Menu
        trigger={
          <>
            <span className="breadcrumb-name">{info.name}</span>
            <ChevronDown size={12} />
          </>
        }
        buttonClassName="breadcrumb-btn"
        entries={entries}
        label={t("cmd.project.menu", { path: info.root })}
      />
    </nav>
  );
}
