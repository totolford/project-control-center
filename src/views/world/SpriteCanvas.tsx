import { useEffect, useRef, useState } from "react";

export type FrameRect = { x: number; y: number; w: number; h: number };

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Frames of a spritesheet drawn pixelated, tinted like AI Town does (multiply),
 * and walked through at `fps` when several frames are given.
 */
export function SpriteCanvas({ src, frames, tint, size = 64, fps = 6, label }: {
  src: string;
  frames: FrameRect[];
  tint?: string | null;
  /** Displayed size of the longest side, px. */
  size?: number;
  fps?: number;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [n, setN] = useState(0);

  useEffect(() => {
    let live = true;
    setFailed(false);
    const i = new Image();
    i.onload = () => live && setImg(i);
    i.onerror = () => live && setFailed(true);
    i.src = src;
    return () => {
      live = false;
    };
  }, [src]);

  const count = frames.length;
  useEffect(() => {
    setN(0);
    if (count < 2 || reducedMotion()) return;
    const t = setInterval(() => setN((k) => (k + 1) % count), 1000 / fps);
    return () => clearInterval(t);
  }, [count, fps]);

  const f = frames[n % Math.max(1, count)];
  const scale = f ? size / Math.max(f.w, f.h) : 1;

  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !img || !f) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, c.width, c.height);
    if (tint && /^#[0-9a-fA-F]{6}$/.test(tint)) {
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, c.width, c.height);
      ctx.globalCompositeOperation = "source-over";
    }
  }, [img, f?.x, f?.y, f?.w, f?.h, tint]);

  if (failed) return <span className="sprite-missing tiny muted">no image</span>;
  if (!f) return null;
  return (
    <canvas
      ref={ref}
      className="sprite-canvas"
      width={Math.round(f.w * scale)}
      height={Math.round(f.h * scale)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
