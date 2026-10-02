import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, World } from "../../lib/types";
import { frameProgress, hitTest, interpolate, toPointMap, type Point } from "./geometry";
import { drawScene, type Drawn } from "./renderer";
import { characterRing } from "./status";

interface Props {
  world: World;
  agents: Agent[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  compact?: boolean;
}

interface Hover {
  id: string;
  x: number;
  y: number;
}

/** Campus map. Positions come from frames; between two ticks they are interpolated for smooth movement. */
export function WorldCanvas({ world, agents, selectedId, onSelect, compact = false }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Hover | null>(null);

  const characters = world.characters;
  const byId = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);
  const rings = useMemo(
    () => new Map(characters.map((c) => [c.id, characterRing(c, world.mode, agents)])),
    [characters, world.mode, agents],
  );

  // Interpolation state lives in refs: the animation loop must not re-render React.
  const shown = useRef<Point[]>([]);
  const from = useRef<Map<string, Point>>(new Map());
  const arrivedAt = useRef(0);
  const drawn = useRef<Drawn | null>(null);
  const dirty = useRef(true);
  const latest = useRef({ world, byId, rings, selectedId, hoverId: null as string | null, compact, size });
  latest.current = { world, byId, rings, selectedId, hoverId: hover?.id ?? null, compact, size };

  useEffect(() => {
    from.current = toPointMap(shown.current);
    arrivedAt.current = performance.now();
    dirty.current = true;
  }, [characters]);

  useEffect(() => {
    dirty.current = true;
  }, [rings, selectedId, hover?.id, size, world.rooms]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const frame = (now: number) => {
      const s = latest.current;
      const interval = 1000 / Math.max(0.2, s.world.settings.speed);
      const t = frameProgress(now, arrivedAt.current, interval);
      const pulsing = [...s.rings.values()].some((r) => r.pulse);
      if (dirty.current || t < 1 || pulsing) {
        shown.current = interpolate(from.current, s.world.characters, t);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawn.current = drawScene(ctx, {
          width: s.size.w,
          height: s.size.h,
          worldW: s.world.width,
          worldH: s.world.height,
          rooms: s.world.rooms,
          points: shown.current,
          characters: s.byId,
          rings: s.rings,
          selectedId: s.selectedId,
          hoveredId: s.hoverId,
          compact: s.compact,
          time: now,
        });
        dirty.current = false;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  const pick = (e: React.MouseEvent) => {
    const d = drawn.current;
    if (!d) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const id = hitTest(d.points, px, py, d.radius + 3);
    return id ? { id, x: px, y: py } : null;
  };

  const hovered = hover ? byId.get(hover.id) : undefined;
  const hoverRing = hover ? rings.get(hover.id) : undefined;
  const roomName = (id: string | null) => world.rooms.find((r) => r.id === id)?.name ?? "outside";

  return (
    <div ref={wrapRef} className={`world-canvas${compact ? " compact" : ""}`}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h }}
        role="img"
        aria-label={`AI World map: ${world.rooms.length} rooms, ${characters.length} characters`}
        onMouseMove={(e) => {
          const h = pick(e);
          setHover((old) => {
            if (!h || !old || h.id !== old.id) return h;
            return Math.abs(h.x - old.x) < 6 && Math.abs(h.y - old.y) < 6 ? old : h;
          });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => onSelect(pick(e)?.id ?? null)}
        className={hover ? "pointer" : undefined}
      />
      {hovered && hover && (
        <div className="world-tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <div className="world-tooltip-name">{hovered.name}</div>
          <div className="tiny" style={{ color: hoverRing?.color }}>
            {hoverRing?.label}
          </div>
          <div className="tiny muted">
            {hovered.targetRoom && hovered.targetRoom !== hovered.room
              ? `${roomName(hovered.room)} → ${roomName(hovered.targetRoom)}`
              : roomName(hovered.room)}
          </div>
          {hovered.activity && <div className="tiny">{hovered.activity}</div>}
        </div>
      )}
    </div>
  );
}
