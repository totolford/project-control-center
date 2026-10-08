// Inline-SVG charts of the AI Usage page. Marks follow the dataviz spec: columns
// capped at 24px with a 4px rounded data-end, 2px surface gap between stacked
// segments, 2px lines, hairline recessive grid, legend for two series, a hover
// tooltip on every mark. Text stays in text colors; series colors are only on marks.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UsageDay, UsageGroup } from "../../lib/usageTypes";
import { t } from "../../i18n";
import { niceMax } from "./usageLogic";

/** Series colors (validated for the dark surface: CVD ΔE 26.6 Claude↔Local). */
export const SERIES = { claude: "#3987e5", local: "#199e70", cost: "#c98500" } as const;

const H = 150;
const PAD = { top: 10, right: 8, bottom: 20, left: 46 };

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(480);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(160, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Column with a 4px rounded top, square at the bottom. */
function colPath(x: number, y: number, w: number, h: number, round: boolean): string {
  if (h <= 0) return "";
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Bar growing right with a 4px rounded end. */
function barPath(x: number, y: number, w: number, h: number, round: boolean): string {
  if (w <= 0) return "";
  const r = round ? Math.min(4, h / 2, w) : 0;
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

export function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="usage-legend">
      {items.map((i) => (
        <span key={i.label}>
          <i style={{ background: i.color }} /> {i.label}
        </span>
      ))}
    </div>
  );
}

/** Axis label of a `YYYY-MM-DD` day, month and day in the UI locale's order. */
function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return t.manager.formatDate(new Date(y, m - 1, d), { month: "numeric", day: "numeric" }) || day.slice(5);
}

interface Tip {
  x: number;
  y: number;
  body: ReactNode;
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="usage-tip" style={{ left: tip.x, top: tip.y }} role="status">
      {tip.body}
    </div>
  );
}

function Axis({ width, max, fmt }: { width: number; max: number; fmt: (v: number) => string }) {
  const inner = H - PAD.top - PAD.bottom;
  return (
    <g className="usage-axis">
      {[0, 0.5, 1].map((f) => {
        const y = PAD.top + inner - f * inner;
        return (
          <g key={f}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} />
            <text x={PAD.left - 6} y={y + 3} textAnchor="end">
              {fmt(max * f)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function XLabels({ days, x, band }: { days: UsageDay[]; x: (i: number) => number; band: number }) {
  const every = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor((band * days.length) / 44))));
  return (
    <g className="usage-axis">
      {days.map((d, i) =>
        i % every === 0 || i === days.length - 1 ? (
          <text key={d.day} x={x(i) + band / 2} y={H - 5} textAnchor="middle">
            {shortDay(d.day)}
          </text>
        ) : null,
      )}
    </g>
  );
}

export interface StackSeries {
  label: string;
  color: string;
  value: (d: UsageDay) => number;
}

/** Columns per day, stacked by series (one series = plain columns). */
export function DayColumns({
  days,
  series,
  fmt,
  label,
}: {
  days: UsageDay[];
  series: StackSeries[];
  fmt: (v: number) => string;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const totals = days.map((d) => series.reduce((s, x) => s + x.value(d), 0));
  const max = niceMax(Math.max(0, ...totals));
  const inner = H - PAD.top - PAD.bottom;
  const plotW = width - PAD.left - PAD.right;
  const band = plotW / Math.max(1, days.length);
  const colW = Math.max(2, Math.min(24, band * 0.7));
  const x = (i: number) => PAD.left + i * band;
  const scale = (v: number) => (v / max) * inner;
  return (
    <div className="usage-chart" ref={ref} onMouseLeave={() => setTip(null)}>
      <svg width={width} height={H} role="img" aria-label={label}>
        <Axis width={width} max={max} fmt={fmt} />
        {days.map((d, i) => {
          let base = PAD.top + inner;
          const visible = series.map((s) => s.value(d)).filter((v) => v > 0).length;
          let drawn = 0;
          const cx = x(i) + (band - colW) / 2;
          return (
            <g key={d.day}>
              {series.map((s) => {
                const v = s.value(d);
                if (v <= 0) return null;
                drawn += 1;
                const h = scale(v);
                // 2px surface gap above every segment that has one on top of it.
                const gap = drawn < visible ? 2 : 0;
                const y = base - h;
                const path = colPath(cx, y + gap, colW, Math.max(0.5, h - gap), drawn === visible);
                base = y;
                return <path key={s.label} d={path} fill={s.color} />;
              })}
              <rect
                className="usage-hit"
                x={x(i)}
                y={PAD.top}
                width={band}
                height={inner}
                onMouseEnter={() =>
                  setTip({
                    x: Math.min(width - 150, x(i) + band),
                    y: PAD.top,
                    body: (
                      <>
                        <b>{d.day}</b>
                        {series.map((s) => (
                          <div key={s.label}>
                            <i style={{ background: s.color }} /> {s.label}: {fmt(s.value(d))}
                          </div>
                        ))}
                      </>
                    ),
                  })
                }
              />
            </g>
          );
        })}
        <XLabels days={days} x={x} band={band} />
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Line of a 0..1 share per day; days without data break the line. */
export function DayShareLine({
  days,
  value,
  color,
  label,
  fmt,
}: {
  days: UsageDay[];
  value: (d: UsageDay) => number | null;
  color: string;
  label: string;
  fmt: (v: number | null) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const inner = H - PAD.top - PAD.bottom;
  const plotW = width - PAD.left - PAD.right;
  const band = plotW / Math.max(1, days.length);
  const x = (i: number) => PAD.left + i * band;
  const y = (v: number) => PAD.top + inner - v * inner;
  const segments: string[] = [];
  let cur = "";
  days.forEach((d, i) => {
    const v = value(d);
    if (v === null) {
      if (cur) segments.push(cur);
      cur = "";
      return;
    }
    cur += `${cur ? "L" : "M"}${x(i) + band / 2},${y(v)}`;
  });
  if (cur) segments.push(cur);
  return (
    <div className="usage-chart" ref={ref} onMouseLeave={() => setTip(null)}>
      <svg width={width} height={H} role="img" aria-label={label}>
        <Axis width={width} max={1} fmt={(v) => `${Math.round(v * 100)}%`} />
        {segments.map((p) => (
          <path key={p} d={p} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {days.map((d, i) => {
          const v = value(d);
          return (
            <g key={d.day}>
              {v !== null && <circle cx={x(i) + band / 2} cy={y(v)} r={4} fill={color} className="usage-dot" />}
              <rect
                className="usage-hit"
                x={x(i)}
                y={PAD.top}
                width={band}
                height={inner}
                onMouseEnter={() =>
                  setTip({
                    x: Math.min(width - 150, x(i) + band),
                    y: PAD.top,
                    body: (
                      <>
                        <b>{d.day}</b>
                        <div>{fmt(v)}</div>
                      </>
                    ),
                  })
                }
              />
            </g>
          );
        })}
        <XLabels days={days} x={x} band={band} />
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Ranked horizontal bars (tokens), split Claude / Local; past `limit`, the rest folds into "Other". */
export function GroupBars({
  groups,
  limit = 8,
  claudeLabel,
  localLabel,
  otherLabel,
  fmt,
  extra,
  name,
}: {
  groups: UsageGroup[];
  limit?: number;
  claudeLabel: string;
  localLabel: string;
  otherLabel: string;
  fmt: (v: number) => string;
  /** Text after the value (requests, cost). */
  extra?: (g: UsageGroup) => string;
  name?: (key: string) => string;
}) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>();
  let rows = groups.filter((g) => g.requests > 0);
  if (rows.length > limit) {
    const rest = rows.slice(limit - 1);
    const other: UsageGroup = {
      key: otherLabel,
      requests: rest.reduce((s, g) => s + g.requests, 0),
      tokens: rest.reduce((s, g) => s + g.tokens, 0),
      claudeTokens: rest.reduce((s, g) => s + g.claudeTokens, 0),
      localTokens: rest.reduce((s, g) => s + g.localTokens, 0),
      costUsd: rest.reduce((s, g) => s + g.costUsd, 0),
    };
    rows = [...rows.slice(0, limit - 1), other];
  }
  const max = Math.max(1, ...rows.map((g) => g.tokens));
  const labelW = Math.min(170, Math.floor(width * 0.34));
  const valueW = 120;
  const barMax = Math.max(20, width - labelW - valueW - 12);
  const rowH = 22;
  const thick = 12;
  return (
    <div className="usage-chart" ref={ref} onMouseLeave={() => setTip(null)}>
      <svg width={width} height={rows.length * rowH + 4} role="img">
        {rows.map((g, i) => {
          const y = i * rowH + 4;
          const wc = (g.claudeTokens / max) * barMax;
          const wl = (g.localTokens / max) * barMax;
          const x0 = labelW + 6;
          const both = wc > 0 && wl > 0;
          const title = name ? name(g.key) : g.key;
          return (
            <g key={g.key}>
              <text className="usage-bar-label" x={labelW} y={y + thick - 2} textAnchor="end">
                {title.length > 26 ? `${title.slice(0, 25)}…` : title}
              </text>
              {wc > 0 && <path d={barPath(x0, y, both ? Math.max(0.5, wc - 2) : wc, thick, !both)} fill={SERIES.claude} />}
              {wl > 0 && <path d={barPath(x0 + wc, y, wl, thick, true)} fill={SERIES.local} />}
              <text className="usage-bar-value" x={x0 + wc + wl + 6} y={y + thick - 2}>
                {fmt(g.tokens)}
                {extra ? ` · ${extra(g)}` : ""}
              </text>
              <rect
                className="usage-hit"
                x={0}
                y={y - 4}
                width={width}
                height={rowH}
                onMouseEnter={() =>
                  setTip({
                    x: Math.min(width - 170, x0 + wc + wl),
                    y: y + rowH,
                    body: (
                      <>
                        <b>{title}</b>
                        <div>
                          <i style={{ background: SERIES.claude }} /> {claudeLabel}: {fmt(g.claudeTokens)}
                        </div>
                        <div>
                          <i style={{ background: SERIES.local }} /> {localLabel}: {fmt(g.localTokens)}
                        </div>
                        {extra && <div>{extra(g)}</div>}
                      </>
                    ),
                  })
                }
              />
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}
