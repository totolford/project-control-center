import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useToasts } from "../lib/toast";

const ICONS = { info: Info, success: CircleCheck, error: CircleAlert };

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.tone];
        return (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon size={15} />
            <span className="toast-text">{t.text}</span>
            <button className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
