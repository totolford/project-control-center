import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Prevents closing with Escape / backdrop (e.g. while an action runs). */
  locked?: boolean;
  className?: string;
}

export function Modal({ title, onClose, children, footer, width = 520, locked, className }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (!ref.current?.contains(document.activeElement)) {
      ref.current?.querySelector<HTMLElement>("input, textarea, select, button.primary, .modal-body button")?.focus();
    }
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !locked) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, locked]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !locked && onClose()}>
      <div ref={ref} className={`modal ${className ?? ""}`} style={{ width }} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2>{title}</h2>
          {!locked && (
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
