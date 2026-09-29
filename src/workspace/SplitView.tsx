import { Fragment, memo, useRef, useState } from "react";
import { MIN_FRACTION, resizeSplit, type LayoutNode, type SplitNode } from "./layout";
import { PanelFrame } from "./PanelFrame";
import { useWorkspace } from "./store";

const MIN_PX = 140;

/** Renders one layout node: a panel, or a split with draggable splitters. */
export const NodeView = memo(function NodeView({ node, tabId, path }: { node: LayoutNode; tabId: string; path: number[] }) {
  if (node.type === "panel") return <PanelFrame panel={node} maximized={false} />;
  return <SplitView node={node} tabId={tabId} path={path} />;
});

function isCollapsed(node: LayoutNode): boolean {
  return node.type === "panel" && node.minimized === true;
}

const SplitView = memo(function SplitView({ node, tabId, path }: { node: SplitNode; tabId: string; path: number[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const update = useWorkspace((s) => s.update);
  const [live, setLive] = useState<number[] | null>(null);
  const sizes = live ?? node.sizes;
  const horizontal = node.direction === "horizontal";

  const startResize = (index: number, e: React.PointerEvent<HTMLDivElement>) => {
    const container = ref.current;
    if (!container) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const rect = container.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    const start = horizontal ? e.clientX : e.clientY;
    const initial = node.sizes.slice();
    const pair = initial[index] + initial[index + 1];
    const min = Math.min(pair / 2, Math.max(MIN_FRACTION, MIN_PX / Math.max(total, 1)));
    let latest = initial;

    const onMove = (ev: PointerEvent) => {
      const delta = ((horizontal ? ev.clientX : ev.clientY) - start) / Math.max(total, 1);
      const a = Math.min(pair - min, Math.max(min, initial[index] + delta));
      latest = initial.slice();
      latest[index] = a;
      latest[index + 1] = pair - a;
      setLive(latest);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setLive(null);
      if (latest !== initial) update((ws) => resizeSplit(ws, tabId, path, latest));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  return (
    <div ref={ref} className={`split-node ${horizontal ? "h" : "v"}`}>
      {node.children.map((child, i) => {
        const collapsed = isCollapsed(child);
        const key = child.type === "panel" ? child.id : `s${i}`;
        return (
          <Fragment key={key}>
            {i > 0 && (
              <div
                className="splitter"
                role="separator"
                aria-orientation={horizontal ? "vertical" : "horizontal"}
                onPointerDown={(e) => startResize(i - 1, e)}
              />
            )}
            <div className={`tile${collapsed ? " collapsed" : ""}`} style={collapsed ? undefined : { flex: `${sizes[i]} 1 0px` }}>
              <NodeView node={child} tabId={tabId} path={[...path, i]} />
            </div>
          </Fragment>
        );
      })}
    </div>
  );
});
