import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  detail?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
}

export type MenuEntry = MenuItem | "separator" | { heading: string };

/** Dropdown menu anchored to its trigger. Closes on outside click, Escape, or selection. */
export function Menu({
  trigger,
  entries,
  align = "left",
  label,
  className,
  buttonClassName = "icon-btn",
}: {
  trigger: ReactNode;
  entries: MenuEntry[] | (() => MenuEntry[]);
  align?: "left" | "right";
  label: string;
  className?: string;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<React.CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
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
  }, [open]);

  const list = open ? (typeof entries === "function" ? entries() : entries) : [];

  return (
    <div className={`menu-anchor ${className ?? ""}`} ref={ref}>
      <button
        type="button"
        className={buttonClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          const r = ref.current!.getBoundingClientRect();
          const maxHeight = Math.max(160, window.innerHeight - r.bottom - 12);
          setPos(align === "right" ? { top: r.bottom + 4, right: window.innerWidth - r.right, maxHeight } : { top: r.bottom + 4, left: r.left, maxHeight });
          setOpen((o) => !o);
        }}
      >
        {trigger}
      </button>
      {open && (
        <div className="menu" role="menu" style={pos}>
          {list.length === 0 && <div className="menu-empty">Nothing to show</div>}
          {list.map((entry, i) => {
            if (entry === "separator") return <div key={i} className="menu-sep" />;
            if ("heading" in entry) {
              return (
                <div key={i} className="menu-heading">
                  {entry.heading}
                </div>
              );
            }
            return (
              <button
                key={i}
                role="menuitem"
                className={`menu-item${entry.danger ? " danger" : ""}`}
                disabled={entry.disabled}
                onClick={() => {
                  setOpen(false);
                  entry.onSelect?.();
                }}
              >
                {entry.icon && <span className="menu-icon">{entry.icon}</span>}
                <span className="menu-text">
                  <span>{entry.label}</span>
                  {entry.detail && <span className="menu-detail">{entry.detail}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
