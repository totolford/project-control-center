import { useEffect, useMemo, useRef } from "react";
import { Bell, CheckCheck } from "lucide-react";
import { formatClock } from "../lib/format";
import { useUi } from "../state/ui";
import { useAgents, useStore, useTimeline } from "../store";
import { deriveNotifications, unreadCount, type Notification } from "../workspace/notifications";
import { useT } from "../i18n";

export function NotificationCenter() {
  const timeline = useTimeline();
  const agents = useAgents();
  const open = useUi((s) => s.notificationsOpen);
  const setOpen = useUi((s) => s.setNotificationsOpen);
  const lastReadId = useUi((s) => s.lastReadId);
  const markRead = useUi((s) => s.markRead);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  const list = useMemo(() => {
    const names = new Map(agents.map((a) => [a.id, a.name]));
    return deriveNotifications(timeline, (id) => (id === "user" ? t("bar.notif.you") : (names.get(id) ?? id)));
  }, [timeline, agents, t]);
  const unread = unreadCount(list, lastReadId);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  const activate = (n: Notification) => {
    const { openAgent, openTask, navigate } = useStore.getState();
    const ui = useUi.getState();
    markRead(n.id);
    setOpen(false);
    const target = n.target;
    if (!target) return;
    if (target.type === "permission") ui.setPermissionsDeferred(false);
    else if (target.type === "request") ui.setRequestsCollapsed(false);
    else if (target.type === "agent") openAgent(target.id);
    else if (target.type === "task") openTask(target.id);
    else if (target.type === "mission") navigate({ name: "missions" });
    else ui.openMessage(target.message);
  };

  return (
    <div className="notif-anchor" ref={ref}>
      <button className="icon-btn notif-btn" onClick={() => setOpen(!open)} aria-label={t("bar.notif.aria", { count: unread })} title={t("bar.notif.title")}>
        <Bell size={15} />
        {unread > 0 && <span className="notif-count">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label={t("bar.notif.title")}>
          <div className="notif-head">
            <strong>{t("bar.notif.title")}</strong>
            <span className="spacer" />
            <button className="btn btn-sm ghost" onClick={() => list[0] && markRead(list[0].id)} disabled={unread === 0}>
              <CheckCheck size={12} /> {t("bar.notif.markAll")}
            </button>
          </div>
          <div className="notif-list">
            {list.length === 0 && <div className="muted small pad">{t("bar.notif.empty")}</div>}
            {list.map((n) => (
              <button key={n.id} className={`notif-item${n.id > lastReadId ? " unread" : ""}`} onClick={() => activate(n)}>
                <span className={`dot tone-${n.tone}`} />
                <span className="notif-text">
                  <span className="notif-title">{n.title}</span>
                  <span className="notif-body">{n.body}</span>
                </span>
                <span className="muted small mono">{formatClock(n.ts)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
