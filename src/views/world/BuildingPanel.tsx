import { ArchiveRestore, History, Plus, Wrench, X } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Chip } from "../../components/StatusBadge";
import { LOCALE_NAMES, isLocale, useT } from "../../i18n";
import { formatDateTime } from "../../lib/format";
import { ROOM_KINDS, kindName, splitRooms } from "./hq";
import { useHq } from "./useHq";

/** NEXUS HQ as a whole: rooms, what the project calls for, issues, snapshots. */
export function BuildingPanel({ onOpenRoom, onClose }: { onOpenRoom: (roomId: string) => void; onClose: () => void }) {
  const t = useT();
  const { view, error, apply, restore } = useHq();

  if (!view) {
    return (
      <aside className="hq-panel" aria-label={t("worldhq.hq.title")}>
        <header className="hq-panel-head">
          <div className="hq-panel-title grow">{t("worldhq.hq.title")}</div>
          <button className="icon-btn" aria-label={t("worldhq.room.close")} onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <div className="tiny muted">{error ? t("worldhq.hq.unavailable", { error }) : t("worldhq.hq.loading")}</div>
      </aside>
    );
  }

  const { config } = view;
  const { active, archived } = splitRooms(config);
  const locale = config.locale;
  const done = t("worldhq.hq.applied");
  const suggestions = view.suggestions.suggestions;
  const occupied = (id: string) => view.occupancy.filter((o) => o.roomId === id).length;

  const restoreSnapshot = async (id: string, at: string, label: string) => {
    const ok = await ask(t("worldhq.hq.restoreConfirm", { at: formatDateTime(at), label }), { title: t("worldhq.hq.snapshots"), kind: "warning" });
    if (ok) await restore(id, t("worldhq.hq.restored"));
  };

  return (
    <aside className="hq-panel" aria-label={t("worldhq.hq.title")}>
      <header className="hq-panel-head">
        <div className="grow">
          <div className="hq-panel-title">{t("worldhq.hq.title")}</div>
          <div className="tiny muted">
            {t("worldhq.hq.summary", { count: active.length, revision: config.revision })} ·{" "}
            {t("worldhq.hq.language", { language: isLocale(locale) ? LOCALE_NAMES[locale] : locale })}
          </div>
        </div>
        <button className="icon-btn" aria-label={t("worldhq.room.close")} title={t("worldhq.room.close")} onClick={onClose}>
          <X size={14} />
        </button>
      </header>

      <section>
        <div className="section-label">{t("worldhq.hq.rooms")}</div>
        <ul className="hq-list">
          {active.map((r) => (
            <li key={r.id}>
              <button className="link-btn ellipsis" onClick={() => onOpenRoom(r.id)}>
                {r.name}
              </button>
              {r.temporary && <Chip tone="dim">{t("worldhq.room.temporary")}</Chip>}
              {occupied(r.id) > 0 && <Chip tone="green">{occupied(r.id)}</Chip>}
            </li>
          ))}
        </ul>
        <div className="row hq-gap">
          <select
            className="aitown-focus"
            aria-label={t("worldhq.hq.addRoomLabel")}
            value=""
            onChange={(e) => {
              if (e.target.value) void apply({ op: "create_room", type: e.target.value }, done);
            }}
          >
            <option value="">{t("worldhq.hq.addRoom")}</option>
            {ROOM_KINDS.filter((k) => k !== "central_hq").map((k) => (
              <option key={k} value={k}>
                {kindName(k, locale)}
              </option>
            ))}
          </select>
          <label className="tiny row">
            {t("worldhq.hq.layout")}
            <select
              className="aitown-focus"
              value={config.layout}
              onChange={(e) => void apply({ op: "set_layout", mode: e.target.value as "auto" | "manual" }, done)}
            >
              <option value="auto">{t("worldhq.hq.layoutAuto")}</option>
              <option value="manual">{t("worldhq.hq.layoutManual")}</option>
            </select>
          </label>
        </div>
      </section>

      <section>
        <div className="section-label">{t("worldhq.hq.suggestions")}</div>
        {suggestions.length === 0 ? (
          <div className="tiny muted">{t("worldhq.hq.noSuggestion")}</div>
        ) : (
          <ul className="hq-list">
            {suggestions.map((s) => (
              <li key={`${s.action}:${s.kind}:${s.room ?? ""}`}>
                <span className="grow small">
                  <strong>{s.action === "create" ? kindName(s.kind, locale) : config.rooms.find((r) => r.id === s.room)?.name ?? s.room}</strong>
                  <span className="tiny muted"> — {s.reason}</span>
                </span>
                {s.action === "create" ? (
                  <button className="btn btn-sm" onClick={() => void apply({ op: "create_room", type: s.kind }, done)}>
                    <Plus size={12} /> {t("worldhq.hq.create")}
                  </button>
                ) : (
                  s.room && (
                    <button className="btn btn-sm" onClick={() => onOpenRoom(s.room as string)}>
                      {t("worldhq.room.archive")}…
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.issues.length > 0 && (
        <section>
          <div className="section-label">{t("worldhq.hq.issues")}</div>
          <ul className="hq-list">
            {view.issues.map((i, n) => (
              <li key={n} className="tiny">
                <Chip tone={i.severity === "error" ? "red" : "amber"}>{i.severity}</Chip> {i.message}
              </li>
            ))}
          </ul>
          <button className="btn btn-sm hq-gap" onClick={() => void apply({ op: "repair_world" }, done)}>
            <Wrench size={12} /> {t("worldhq.hq.repair")}
          </button>
        </section>
      )}

      {archived.length > 0 && (
        <section>
          <div className="section-label">{t("worldhq.hq.archivedRooms")}</div>
          <ul className="hq-list">
            {archived.map((r) => (
              <li key={r.id}>
                <span className="grow small dim">{r.name}</span>
                <button className="btn btn-sm" onClick={() => void apply({ op: "restore_room", room: r.id }, done)}>
                  <ArchiveRestore size={12} /> {t("worldhq.room.restore")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="section-label">{t("worldhq.hq.snapshots")}</div>
        {view.snapshots.length === 0 ? (
          <div className="tiny muted">{t("worldhq.hq.noSnapshot")}</div>
        ) : (
          <ul className="hq-list">
            {view.snapshots.slice(0, 8).map((s) => (
              <li key={s.id} className="tiny">
                <span className="grow">
                  {formatDateTime(s.at)} <span className="muted">· {s.label}</span>
                </span>
                <button className="icon-btn" aria-label={t("worldhq.room.restore")} title={t("worldhq.room.restore")} onClick={() => void restoreSnapshot(s.id, s.at, s.label)}>
                  <History size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
