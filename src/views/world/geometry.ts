// World units → canvas pixels, tick interpolation and hit testing (pure, no DOM).

export interface Viewport {
  scale: number;
  ox: number;
  oy: number;
}

export interface Point {
  id: string;
  x: number;
  y: number;
}

/** Largest uniform scale that fits the world in the canvas, centered, with a pixel margin. */
export function fitViewport(worldW: number, worldH: number, canvasW: number, canvasH: number, margin = 8): Viewport {
  const w = Math.max(1, canvasW - margin * 2);
  const h = Math.max(1, canvasH - margin * 2);
  const scale = Math.max(0.01, Math.min(w / Math.max(1, worldW), h / Math.max(1, worldH)));
  return { scale, ox: (canvasW - worldW * scale) / 2, oy: (canvasH - worldH * scale) / 2 };
}

export function toCanvas(v: Viewport, x: number, y: number): [number, number] {
  return [v.ox + x * v.scale, v.oy + y * v.scale];
}

export function toWorld(v: Viewport, px: number, py: number): [number, number] {
  return [(px - v.ox) / v.scale, (py - v.oy) / v.scale];
}

/** 0..1 progress between the previous and the latest frame, given the tick interval. */
export function frameProgress(now: number, arrivedAt: number, intervalMs: number): number {
  if (intervalMs <= 0) return 1;
  return Math.min(1, Math.max(0, (now - arrivedAt) / intervalMs));
}

/** Positions between two frames; characters new in `next` appear at their position. */
export function interpolate(prev: Map<string, Point>, next: Point[], t: number): Point[] {
  return next.map((p) => {
    const from = prev.get(p.id);
    if (!from) return { id: p.id, x: p.x, y: p.y };
    return { id: p.id, x: from.x + (p.x - from.x) * t, y: from.y + (p.y - from.y) * t };
  });
}

export function toPointMap(points: Point[]): Map<string, Point> {
  return new Map(points.map((p) => [p.id, { id: p.id, x: p.x, y: p.y }]));
}

/** Character under a canvas point: the closest within `radius` pixels (drawn points are in canvas space). */
export function hitTest(points: Point[], px: number, py: number, radius: number): string | null {
  let best: string | null = null;
  let bestD = radius * radius;
  for (const p of points) {
    const d = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** Avatar radius in pixels: proportional to the map, readable at any size. */
export function avatarRadius(v: Viewport, compact: boolean): number {
  return Math.max(compact ? 6 : 8, Math.min(compact ? 10 : 15, v.scale * 0.55));
}
