import { useEffect, useMemo, useRef } from "react";
import { Bell, CheckCheck } from "lucide-react";
import { formatClock } from "../lib/format";
import { useUi } from "../state/ui";
import { useAgents, useStore, useTimeline } from "../store";
import { deriveNotifications, unreadCount, type Notification } from "../workspace/notifications";

export function NotificationCenter() {
  const timeline = useTimeline();
  const agents = useAgents();
  const open = useUi((s) => s.notificationsOpen);
  const setOpen = useUi((s) => s.setNotificationsOpen);
  const lastReadId = useUi((s) => s.lastReadId);
  const markRead = useUi((s) => s.markRead);
  const ref = useRef<HTMLDivElement>(null);
  const list = useMemo(() => {
    const names = new Map(agents.map((a) => [a.id, a.name]));
    return deriveNotifications(timeline, (id) => (id === "user" ? "You" : (names.get(id) ?? id)));
  }, [timeline, agents]);
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
    const t = n.target;
    if (!t) return;
    if (t.type === "permission") ui.setPermissionsDeferred(false);
    else if (t.type === "agent") openAgent(t.id);
    else if (t.type === "task") openTask(t.id);
    else if (t.type === "mission") navigate({ name: "missions" });
    else ui.openMessage(t.message);
  };

  return (
    <div className="notif-anchor" ref={ref}>
      <button className="icon-btn notif-btn" onClick={() => setOpen(!open)} aria-label={`Notifications (${unread} unread)`} title="Notifications">
        <Bell size={15} />
        {unread > 0 && <span className="notif-count">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <strong>Notifications</strong>
            <span className="spacer" />
            <button className="btn btn-sm ghost" onClick={() => list[0] && markRead(list[0].id)} disabled={unread === 0}>
              <CheckCheck size={12} /> Mark all read
            </button>
          </div>
          <div className="notif-list">
            {list.length === 0 && <div className="muted small pad">Nothing yet. Events from agents appear here as they happen.</div>}
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
