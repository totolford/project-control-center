// Canvas 2D drawing of the campus map and its characters. Everything drawn comes from the scene data.

import type { Character, Room } from "../../lib/types";
import { avatarRadius, fitViewport, toCanvas, truncate, type Point, type Viewport } from "./geometry";
import { CANVAS_COLORS, ROOM_META, initials, spriteFill, type Ring } from "./status";

export interface Scene {
  /** CSS pixels */
  width: number;
  height: number;
  worldW: number;
  worldH: number;
  rooms: Room[];
  /** Interpolated positions in world units. */
  points: Point[];
  characters: Map<string, Character>;
  rings: Map<string, Ring>;
  selectedId: string | null;
  hoveredId: string | null;
  compact: boolean;
  /** ms timestamp, drives the pulse of live working / awaiting rings only */
  time: number;
}

export interface Drawn {
  viewport: Viewport;
  /** Character centers in CSS pixels, for hit testing. */
  points: Point[];
  radius: number;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawRooms(ctx: CanvasRenderingContext2D, v: Viewport, rooms: Room[], compact: boolean) {
  ctx.lineWidth = 1;
  ctx.font = `600 ${compact ? 9 : 10.5}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  for (const r of rooms) {
    const [x, y] = toCanvas(v, r.x, r.y);
    const w = r.w * v.scale;
    const h = r.h * v.scale;
    ctx.fillStyle = ROOM_META[r.kind]?.floor ?? "rgba(133,141,153,0.07)";
    roundRect(ctx, x, y, w, h, 4);
    ctx.fill();
    ctx.strokeStyle = CANVAS_COLORS.wall;
    ctx.stroke();
    ctx.fillStyle = CANVAS_COLORS.roomLabel;
    ctx.fillText(truncate(r.name.toUpperCase(), Math.max(4, Math.floor(w / 7))), x + 6, y + 5);
  }
}

function drawBubble(ctx: CanvasRenderingContext2D, text: string, cx: number, top: number) {
  ctx.font = `11px "Segoe UI", system-ui, sans-serif`;
  const label = truncate(text, 30);
  const w = ctx.measureText(label).width + 12;
  const h = 18;
  const x = cx - w / 2;
  const y = top - h - 4;
  ctx.fillStyle = CANVAS_COLORS.bubble;
  ctx.strokeStyle = CANVAS_COLORS.bubbleBorder;
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = CANVAS_COLORS.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, y + h / 2 + 0.5);
}

export function drawScene(ctx: CanvasRenderingContext2D, s: Scene): Drawn {
  ctx.clearRect(0, 0, s.width, s.height);
  ctx.fillStyle = CANVAS_COLORS.background;
  ctx.fillRect(0, 0, s.width, s.height);
  const v = fitViewport(s.worldW, s.worldH, s.width, s.height, s.compact ? 4 : 10);
  drawRooms(ctx, v, s.rooms, s.compact);

  const r = avatarRadius(v, s.compact);
  const drawn: Point[] = [];
  const showAllBubbles = !s.compact && s.points.length <= 12;
  const focus = new Set([s.selectedId, s.hoveredId]);
  // Focused characters last so they stay on top.
  const ordered = [...s.points].sort((a, b) => Number(focus.has(a.id)) - Number(focus.has(b.id)));
  for (const p of ordered) {
    const c = s.characters.get(p.id);
    if (!c) continue;
    const ring = s.rings.get(p.id);
    const [x, y] = toCanvas(v, p.x, p.y);
    drawn.push({ id: p.id, x, y });

    if (ring?.pulse) {
      const phase = (Math.sin(s.time / 260) + 1) / 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 3 + phase * 4, 0, Math.PI * 2);
      ctx.fillStyle = ring.color;
      ctx.globalAlpha = 0.22 * (1 - phase) + 0.05;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (p.id === s.selectedId) {
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = CANVAS_COLORS.selection;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = spriteFill(c.sprite);
    ctx.fill();
    ctx.lineWidth = s.compact ? 2 : 2.5;
    ctx.strokeStyle = ring?.color ?? CANVAS_COLORS.neutralRing;
    ctx.stroke();

    ctx.fillStyle = CANVAS_COLORS.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${Math.round(r * 0.8)}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillText(initials(c.name), x, y + 0.5);

    const focused = focus.has(p.id);
    if (!s.compact || focused) {
      ctx.font = `${s.compact ? 10 : 11}px "Segoe UI", system-ui, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillStyle = focused ? CANVAS_COLORS.text : CANVAS_COLORS.roomLabel;
      ctx.fillText(truncate(c.name, 18), x, y + r + 3);
    }
    if (c.activity && (focused || showAllBubbles)) drawBubble(ctx, c.activity, x, y - r);
  }
  return { viewport: v, points: drawn, radius: r };
}
