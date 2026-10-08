import { useEffect, useMemo, useState } from "react";
import { ArchiveRestore, Archive, Crosshair, ExternalLink, Pencil, X } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Chip, StatusBadge } from "../../components/StatusBadge";
import { useT } from "../../i18n";
import { formatRelative } from "../../lib/format";
import { TASK_STATUS } from "../../lib/labels";
import { useRightContext } from "../../state/context";
import { useAgents, useConnections, useMissions, useStore, useTasks, useTimeline } from "../../store";
import { canArchive, kindName, roomDetail, roomTarget, targetLabel } from "./hq";
import { useHq } from "./useHq";

/** Occupancy changes with what agents really do: refreshed while the panel is open. */
const REFRESH_MS = 5000;

/** Smart room: who is in it now, what they work on, what they use, what happened — real data only. */
export function RoomPanel({ roomId, onFocus, onClose }: { roomId: string; onFocus: (roomId: string) => void; onClose: () => void }) {
  const t = useT();
  const view = useHq((s) => s.view);
  const agents = useAgents();
  const tasks = useTasks();
  const missions = useMissions();
  const connections = useConnections();
  const timeline = useTimeline();
  const navigate = useStore((s) => s.navigate);
  const openAgent = useStore((s) => s.openAgent);
  const openTask = useStore((s) => s.openTask);
  const openContext = useRightContext((s) => s.openContext);
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => void useHq.getState().load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  const d = useMemo(
    () => (view ? roomDetail(roomId, view, { agents, tasks, missions, connections, timeline }) : null),
    [roomId, view, agents, tasks, missions, connections, timeline],
  );
  if (!view || !d) return null;
  const { room } = d;
  const target = roomTarget(room.type);
  const apply = useHq.getState().apply;

  const rename = async () => {
    const name = renaming?.trim();
    if (name && name !== room.name) await apply({ op: "rename_room", room: room.id, name }, t("worldhq.hq.applied"));
    setRenaming(null);
  };
  const archive = async () => {
    const ok = await ask(t("worldhq.room.archiveConfirm", { name: room.name }), { title: t("worldhq.room.archive"), kind: "warning" });
    if (ok && (await apply({ op: "delete_room", room: room.id }, t("worldhq.hq.applied")))) onClose();
  };

  return (
    <aside className="hq-panel hq-room" aria-label={room.name}>
      <header className="hq-panel-head">
        {renaming === null ? (
          <div className="grow">
            <div className="hq-panel-title">{room.name}</div>
            <div className="tiny muted">
              {kindName(room.type, view.config.locale)}
              {room.temporary && <> · {t("worldhq.room.temporary")}</>}
              {room.archived && <> · {t("worldhq.room.archived")}</>}
            </div>
          </div>
        ) : (
          <form
            className="grow row"
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <input autoFocus aria-label={t("worldhq.room.renamePrompt")} value={renaming} maxLength={48} onChange={(e) => setRenaming(e.target.value)} onBlur={() => void rename()} />
          </form>
        )}
        <button className="icon-btn" aria-label={t("worldhq.room.close")} title={t("worldhq.room.close")} onClick={onClose}>
          <X size={14} />
        </button>
      </header>

      <div className="hq-actions">
        {d.drawn && (
          <button className="btn btn-sm" onClick={() => onFocus(room.id)}>
            <Crosshair size={12} /> {t("worldhq.room.focus")}
          </button>
        )}
        {target && (
          <button
            className="btn btn-sm"
            onClick={() => (target.kind === "central" ? openContext({ kind: "central" }) : navigate({ name: target.view }))}
          >
            <ExternalLink size={12} /> {t("worldhq.room.open", { target: targetLabel(target, t) })}
          </button>
        )}
        {!room.archived && (
          <button className="icon-btn" aria-label={t("worldhq.room.rename")} title={t("worldhq.room.rename")} onClick={() => setRenaming(room.name)}>
            <Pencil size={12} />
          </button>
        )}
        {canArchive(room) && (
          <button className="icon-btn" aria-label={t("worldhq.room.archive")} title={t("worldhq.room.archive")} onClick={() => void archive()}>
            <Archive size={12} />
          </button>
        )}
        {room.archived && (
          <button className="btn btn-sm" onClick={() => void apply({ op: "restore_room", room: room.id }, t("worldhq.hq.applied"))}>
            <ArchiveRestore size={12} /> {t("worldhq.room.restore")}
          </button>
        )}
      </div>
      {!d.drawn && !room.archived && <div className="tiny muted">{t("worldhq.room.notInWorld")}</div>}

      {room.purpose && (
        <section>
          <div className="section-label">{t("worldhq.room.purpose")}</div>
          <div className="small">{room.purpose}</div>
        </section>
      )}

      <section>
        <div className="section-label">{t("worldhq.room.here")}</div>
        {d.here.length === 0 ? (
          <div className="tiny muted">{t("worldhq.room.nobody")}</div>
        ) : (
          <ul className="hq-list">
            {d.here.map((a) => (
              <li key={a.id}>
                <button className="link-btn" onClick={() => openAgent(a.id)}>
                  {a.profile?.appearance?.displayName || a.name}
                </button>
                <StatusBadge status={a.status} />
              </li>
            ))}
          </ul>
        )}
        {d.assigned.length > 0 && (
          <div className="tiny muted hq-gap">
            {t("worldhq.room.assigned")}: {d.assigned.map((a) => a.name).join(", ")}
          </div>
        )}
      </section>

      <section>
        <div className="section-label">{t("worldhq.room.work")}</div>
        {d.tasks.length === 0 ? (
          <div className="tiny muted">{t("worldhq.room.noWork")}</div>
        ) : (
          <ul className="hq-list">
            {d.missions.map((m) => (
              <li key={m.id}>
                <Chip tone="accent">{m.title}</Chip>
              </li>
            ))}
            {d.tasks.map((task) => (
              <li key={task.id}>
                <button className="link-btn ellipsis" onClick={() => openTask(task.id)}>
                  {task.title}
                </button>
                <Chip tone={TASK_STATUS[task.status].tone}>{TASK_STATUS[task.status].label}</Chip>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="section-label">{t("worldhq.room.inUse")}</div>
        {d.inUse.length === 0 ? (
          <div className="tiny muted">{t("worldhq.room.noTool")}</div>
        ) : (
          <ul className="hq-list">
            {d.inUse.map(({ agent, action }) => (
              <li key={agent.id} className="mono tiny ellipsis" title={action}>
                {agent.name}: {action}
              </li>
            ))}
          </ul>
        )}
        {d.required.length > 0 && (
          <>
            <div className="tiny muted hq-gap">{t("worldhq.room.required")}</div>
            <ul className="hq-list">
              {d.required.map((c) => (
                <li key={c.name} className="tiny">
                  <span className="mono">{c.name}</span>
                  {c.configured ? <Chip tone="dim">{c.status}</Chip> : <Chip tone="amber">{t("worldhq.room.connMissing")}</Chip>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <div className="section-label">{t("worldhq.room.recent")}</div>
        {d.recent.length === 0 ? (
          <div className="tiny muted">{t("worldhq.room.noRecent")}</div>
        ) : (
          <ul className="hq-list hq-events">
            {d.recent.map((e) => (
              <li key={e.id} className="tiny">
                <span className="dim">{formatRelative(e.ts)}</span> <span className="ellipsis">{e.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
