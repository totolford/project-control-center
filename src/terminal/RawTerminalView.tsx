import { useEffect } from "react";
import { History, Plus, SquareTerminal, X } from "lucide-react";
import { isLive } from "../lib/labels";
import type { PtyInfo } from "../lib/types";
import { useAgents } from "../store";
import { Menu, type MenuEntry } from "../components/Menu";
import { EmptyState } from "../components/Common";
import { terminalProfiles, usePlatform } from "../lib/platform";
import { respawnRequest, resumableAgents } from "./profiles";
import { usePty } from "./ptyStore";
import { XtermView } from "./XtermView";
import { useT } from "../i18n";

function NewTerminalMenu() {
  const t = useT();
  const agents = useAgents();
  const spawn = usePty((s) => s.spawn);
  const platform = usePlatform();
  const entries = (): MenuEntry[] => {
    const resumable = resumableAgents(agents, isLive);
    return [
      { heading: t("term.new") },
      ...terminalProfiles(platform).map((p) => ({ label: p.label, icon: <SquareTerminal size={13} />, onSelect: () => void spawn(p.profile) })),
      "separator",
      { heading: t("term.resume") },
      ...(resumable.length === 0
        ? [{ label: t("term.noResumable"), disabled: true }]
        : resumable.map((a) => ({ label: a.name, detail: a.role, icon: <History size={13} />, onSelect: () => void spawn("claude-resume", a.id) }))),
    ];
  };
  return (
    <Menu
      trigger={
        <>
          <Plus size={13} /> {t("term.newShort")}
        </>
      }
      buttonClassName="btn btn-sm"
      entries={entries}
      align="right"
      label={t("term.new")}
    />
  );
}

function SessionView({ info, visible }: { info: PtyInfo; visible: boolean }) {
  const agents = useAgents();
  const spawn = usePty((s) => s.spawn);
  const close = usePty((s) => s.close);
  const again = respawnRequest(info, agents);
  const restart = again
    ? () =>
        void spawn(again.profile, again.agentId).then((created) => {
          if (created) void close(info.id);
        })
    : null;
  return <XtermView info={info} visible={visible} onRestart={restart} onClose={() => void close(info.id)} />;
}

/** Tabs of Raw Terminal sessions; several can run at once. */
function TerminalManager() {
  const t = useT();
  const sessions = usePty((s) => s.sessions);
  const active = usePty((s) => s.active);
  const loaded = usePty((s) => s.loaded);
  const refresh = usePty((s) => s.refresh);
  const setActive = usePty((s) => s.setActive);
  const close = usePty((s) => s.close);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="terminals">
      <div className="term-tabs" role="tablist">
        {sessions.map((s) => (
          <div key={s.id} className={`term-tab${s.id === active ? " active" : ""}`}>
            <button className="term-tab-label" role="tab" aria-selected={s.id === active} onClick={() => setActive(s.id)} title={s.title}>
              <span className={`dot tone-${s.running ? "green" : "grey"}`} />
              <span className="ellipsis">{s.title}</span>
            </button>
            <button className="ws-tab-close" onClick={() => void close(s.id)} aria-label={t("term.closeAria", { title: s.title })} title={s.running ? t("term.killClose") : t("common.close")}>
              <X size={11} />
            </button>
          </div>
        ))}
        <span className="spacer" />
        <NewTerminalMenu />
      </div>
      <div className="term-stack">
        {sessions.length === 0 ? (
          <EmptyState icon={<SquareTerminal size={22} />} title={loaded ? t("term.noSession") : t("term.loading")}>
            {t("term.emptyHint")}
          </EmptyState>
        ) : (
          sessions.map((s) => <SessionView key={s.id} info={s} visible={s.id === active} />)
        )}
      </div>
    </div>
  );
}

export function RawTerminalView() {
  return (
    <div className="page page-fill terminal-page">
      <TerminalManager />
    </div>
  );
}

/** Workspace panel "RawTerminal": the same session manager inside a tile. */
export function RawTerminalPanel() {
  return <TerminalManager />;
}
