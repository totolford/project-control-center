import { useEffect, useMemo, useState } from "react";
import { Check, ImageUp, TriangleAlert, Upload } from "lucide-react";
import { Field, Spinner } from "../../components/Common";
import { Modal } from "../../components/Modal";
import { api, errorMessage } from "../../lib/api";
import { attempt } from "../../lib/toast";
import type { Agent, AgentAppearance, AiTownWorld } from "../../lib/types";
import { useStore } from "../../store";
import { NEXUS_SKIN_PREFIX, builtinSkinChoices, isValidTint, skinSlug } from "./aitown";
import { listImportedSkins, uploadSkin, type ImportedSkin } from "./convexHttp";
import { SpriteCanvas, type FrameRect } from "./SpriteCanvas";
import {
  DIRECTIONS,
  buildSpritesheetData,
  detectLayout,
  frameRect,
  layoutErrors,
  type Detection,
  type Direction,
  type SheetLayout,
} from "./spritesheet";

type Tab = "builtin" | "imported" | "import";

interface Look {
  src: string;
  frames: FrameRect[];
}

/** Default character of an agent that never chose one (mirrors bridge.rs default_character). */
function defaultSkin(agent: Agent): string {
  if (agent.kind === "central") return "f1";
  let h = 2166136261;
  for (const b of new TextEncoder().encode(agent.id)) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `f${2 + (h % 7)}`;
}

function walk(data: { frames: Record<string, { frame: FrameRect }>; animations?: Record<string, string[]> }, dir: Direction): FrameRect[] {
  return (data.animations?.[dir] ?? []).map((n) => data.frames[n]?.frame).filter((f): f is FrameRect => !!f);
}

/** "Customize Character": skin (preset, built-in or imported spritesheet), tint, badge, display name. */
export function CustomizeCharacter({ agent, world, onClose, onSaved }: {
  agent: Agent;
  /** Running AI Town (needed to list and import spritesheets). */
  world: AiTownWorld | null;
  onClose: () => void;
  onSaved?: (a: Agent) => void;
}) {
  const current = agent.profile.appearance ?? {};
  const builtins = useMemo(() => builtinSkinChoices(), []);
  const [skin, setSkin] = useState<string>(current.skin ?? defaultSkin(agent));
  const [preset, setPreset] = useState<string | null>(current.preset ?? null);
  const [displayName, setDisplayName] = useState(current.displayName ?? "");
  const [badge, setBadge] = useState(current.badge ?? "");
  const [tint, setTint] = useState(current.tint ?? "");
  const [tab, setTab] = useState<Tab>(skin.startsWith(NEXUS_SKIN_PREFIX) ? "imported" : "builtin");
  const [imported, setImported] = useState<ImportedSkin[] | null>(null);
  const [importedError, setImportedError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const upsertAgent = useStore((s) => s.upsertAgent);
  /** Bumped after an upload: the list (and storage URLs) come back from AI Town. */
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!world) return;
    let live = true;
    listImportedSkins(world.url, world.worldId)
      .then((s) => live && (setImported(s), setImportedError(null)))
      .catch((e) => live && setImportedError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [world, reload]);

  const look: Look | null = useMemo(() => {
    const b = builtins.find((c) => c.skin === skin);
    if (b) {
      // Built-in sheets share the folk layout: the down walk is the 3 frames of row 0.
      const f = b.frame;
      return { src: b.textureUrl, frames: [0, 1, 2].map((k) => ({ ...f, x: f.x + k * f.w })) };
    }
    const i = imported?.find((s) => `${NEXUS_SKIN_PREFIX}${s.name}` === skin);
    if (i?.textureUrl) return { src: i.textureUrl, frames: walk(i.spritesheetData, "down") };
    return null;
  }, [skin, builtins, imported]);

  const tintError = tint && !isValidTint(tint) ? "Tint must be #rrggbb." : null;

  const save = async () => {
    const appearance: AgentAppearance = {
      skin,
      preset,
      displayName: displayName.trim() || null,
      badge: badge.trim() || null,
      tint: tint || null,
    };
    setSaving(true);
    const a = await attempt(() => api.setAgentAppearance(agent.id, appearance), "Character saved");
    setSaving(false);
    if (a) {
      upsertAgent(a);
      onSaved?.(a);
      onClose();
    }
  };

  const shownName = displayName.trim() || agent.name;

  return (
    <Modal
      title={`Customize Character — ${agent.name}`}
      onClose={onClose}
      width={860}
      locked={saving}
      className="world-modal"
      footer={
        <>
          <span className="tiny muted grow">
            {world ? "The character changes in the town within a second." : "Saved now; the town shows it when AI Town runs."}
          </span>
          <button className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving || !!tintError} onClick={() => void save()}>
            {saving ? <Spinner size={12} /> : <Check size={13} />} Save
          </button>
        </>
      }
    >
      <div className="cc-layout">
        <aside className="cc-preview">
          <div className="cc-stage">
            {look ? <SpriteCanvas src={look.src} frames={look.frames} tint={tint || null} size={128} label={`${shownName} preview`} /> : <span className="tiny muted">No preview</span>}
          </div>
          <div className="cc-nameplate">
            {badge.trim() && <span className="cc-badge">{badge.trim()}</span>}
            <strong>{shownName}</strong>
          </div>
          <div className="tiny muted mono">{skin}</div>
          <p className="tiny muted">
            A skin is a whole spritesheet: hair, clothes and accessories are drawn in it. Colors can only be shifted with the tint.
          </p>
        </aside>

        <div className="cc-main">
          <div className="cc-tabs" role="tablist">
            {(
              [
                ["builtin", "Presets & built-in"],
                ["imported", "Imported"],
                ["import", "Import spritesheet"],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={`cc-tab${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>

          {tab === "builtin" && (
            <div className="cc-grid" role="radiogroup" aria-label="Skins">
              {builtins.map((c) => {
                const active = skin === c.skin && (preset ? preset === c.preset : builtins.find((b) => b.skin === skin) === c);
                return (
                  <button
                    key={`${c.skin}-${c.preset ?? ""}`}
                    role="radio"
                    aria-checked={active}
                    className={`cc-skin${active ? " active" : ""}`}
                    title={c.look}
                    onClick={() => {
                      setSkin(c.skin);
                      setPreset(c.preset ?? null);
                    }}
                  >
                    <SpriteCanvas src={c.textureUrl} frames={[c.frame]} tint={tint || null} size={48} />
                    <span className="cc-skin-label">{c.label}</span>
                    <span className="cc-skin-look">{c.look}</span>
                  </button>
                );
              })}
            </div>
          )}

          {tab === "imported" && (
            <div>
              {!world && <div className="notice">Start AI Town to see the spritesheets imported into it.</div>}
              {importedError && <div className="notice notice-error">Cannot list imported skins: {importedError}</div>}
              {world && imported === null && !importedError && <Spinner />}
              {imported?.length === 0 && <div className="small muted">No spritesheet imported yet: use “Import spritesheet”.</div>}
              <div className="cc-grid">
                {imported?.map((s) => {
                  const id = `${NEXUS_SKIN_PREFIX}${s.name}`;
                  const down = walk(s.spritesheetData, "down");
                  return (
                    <button
                      key={s.name}
                      className={`cc-skin${skin === id ? " active" : ""}`}
                      aria-pressed={skin === id}
                      onClick={() => {
                        setSkin(id);
                        setPreset(null);
                      }}
                    >
                      {s.textureUrl && down[0] ? <SpriteCanvas src={s.textureUrl} frames={[down[0]]} tint={tint || null} size={48} /> : <span className="tiny muted">?</span>}
                      <span className="cc-skin-label">{s.label}</span>
                      <span className="cc-skin-look mono">{s.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {tab === "import" && (
            <ImportSpritesheet
              world={world}
              onImported={(id) => {
                setReload((n) => n + 1);
                setSkin(id);
                setPreset(null);
                setTab("imported");
              }}
            />
          )}

          <div className="grid-2 world-gap">
            <Field label="Display name" hint="Shown above the character; empty = agent name.">
              <input value={displayName} maxLength={40} placeholder={agent.name} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
            <Field label="Badge" hint="Up to 8 characters, e.g. DEV or QA.">
              <input value={badge} maxLength={8} onChange={(e) => setBadge(e.target.value)} />
            </Field>
            <Field label="Tint" hint={tintError ?? "Multiplied into the sprite colors (white = none)."} group>
              <div className="row">
                <input type="color" aria-label="Tint color" value={isValidTint(tint) ? tint : "#ffffff"} onChange={(e) => setTint(e.target.value)} />
                <input className="mono grow" value={tint} placeholder="none" maxLength={7} onChange={(e) => setTint(e.target.value.trim())} />
                <button className="btn btn-sm" disabled={!tint} onClick={() => setTint("")}>
                  Clear
                </button>
              </div>
            </Field>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Import a PNG spritesheet: detect its grid, map directions, preview, upload to AI Town. */
function ImportSpritesheet({ world, onImported }: { world: AiTownWorld | null; onImported: (id: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [layout, setLayout] = useState<SheetLayout | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const pick = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (f.type !== "image/png") {
      setError("Choose a PNG spritesheet.");
      return;
    }
    const u = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const d = detectLayout(img.naturalWidth, img.naturalHeight);
      setFile(f);
      setUrl(u);
      setDims({ w: img.naturalWidth, h: img.naturalHeight });
      setDetection(d);
      setLayout(d.layout);
      setLabel(f.name.replace(/\.png$/i, ""));
    };
    img.onerror = () => setError("This file cannot be read as an image.");
    img.src = u;
  };

  const errors = layout && dims ? layoutErrors(layout, dims.w, dims.h) : [];
  const gridRows = dims && layout ? Math.max(1, Math.floor(dims.h / layout.frameH)) : 4;
  const blocks = detection && layout && layout.frameW === detection.layout.frameW && layout.frameH === detection.layout.frameH ? detection.blocks : [];

  const upload = async () => {
    if (!world || !file || !layout || errors.length) return;
    setBusy(true);
    setError(null);
    const spritesheetData = buildSpritesheetData(layout);
    const name = skinSlug(label);
    try {
      const id = await uploadSkin(world.url, file, { name, label: label.trim() || name, spritesheetData, speed: 0.1 });
      onImported(id);
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  };

  const num = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || min)));

  return (
    <div className="cc-import">
      <label className="btn btn-sm cc-file">
        <ImageUp size={13} /> Choose PNG…
        <input type="file" accept="image/png" onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      {!file && (
        <p className="small muted">
          AI Town characters are 32×32 frames: one row per direction (down, left, right, up), 3 walk frames each. Other grids work
          too: NEXUS detects the image size and you adjust the mapping.
        </p>
      )}
      {error && <div className="notice notice-error">{error}</div>}
      {file && url && dims && layout && (
        <>
          <div className="small">
            <span className="mono">{file.name}</span> — {dims.w}×{dims.h} px · grid {Math.floor(dims.w / layout.frameW)}×{gridRows} frames
          </div>
          {detection?.notes.map((n) => (
            <div key={n} className="tiny muted">
              {n}
            </div>
          ))}
          <div className="cc-import-grid">
            <Field label="Frame width">
              <input type="number" min={8} max={256} value={layout.frameW} onChange={(e) => setLayout({ ...layout, frameW: num(e.target.value, 8, 256) })} />
            </Field>
            <Field label="Frame height">
              <input type="number" min={8} max={256} value={layout.frameH} onChange={(e) => setLayout({ ...layout, frameH: num(e.target.value, 8, 256) })} />
            </Field>
            <Field label="Frames / direction">
              <input type="number" min={1} max={12} value={layout.framesPerDir} onChange={(e) => setLayout({ ...layout, framesPerDir: num(e.target.value, 1, 12) })} />
            </Field>
            {blocks.length > 1 && (
              <Field label="Character">
                <select
                  value={blocks.findIndex((b) => b.x === layout.originX && b.y === layout.originY)}
                  onChange={(e) => {
                    const b = blocks[Number(e.target.value)];
                    if (b) setLayout({ ...layout, originX: b.x, originY: b.y });
                  }}
                >
                  {blocks.map((b, i) => (
                    <option key={i} value={i}>
                      #{i + 1} ({b.x}, {b.y})
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {DIRECTIONS.map((d) => (
              <Field key={d} label={`Row: ${d}`}>
                <select value={layout.rows[d]} onChange={(e) => setLayout({ ...layout, rows: { ...layout.rows, [d]: Number(e.target.value) } })}>
                  {Array.from({ length: gridRows }, (_, i) => (
                    <option key={i} value={i}>
                      row {i + 1}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          <div className="cc-walks" aria-label="Live preview">
            {DIRECTIONS.map((d) => (
              <figure key={d}>
                {errors.length === 0 && (
                  <SpriteCanvas src={url} frames={Array.from({ length: layout.framesPerDir }, (_, n) => frameRect(layout, d, n))} size={56} />
                )}
                <figcaption className="tiny muted">{d}</figcaption>
              </figure>
            ))}
          </div>
          {errors.map((e) => (
            <div key={e} className="tiny tone-red-fg">
              {e}
            </div>
          ))}
          <div className="row">
            <Field label="Skin name">
              <input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <span className="tiny muted mono">id: {NEXUS_SKIN_PREFIX + skinSlug(label)}</span>
          </div>
          {!world && (
            <div className="notice notice-warn">
              <TriangleAlert size={14} /> Start AI Town first: imported spritesheets are stored in its local backend.
            </div>
          )}
          <button className="btn primary" disabled={!world || busy || errors.length > 0 || !label.trim()} onClick={() => void upload()}>
            {busy ? <Spinner size={12} /> : <Upload size={13} />} Upload to AI Town
          </button>
          <div className="tiny muted">Re-using a skin name replaces that skin for every character wearing it.</div>
        </>
      )}
    </div>
  );
}
