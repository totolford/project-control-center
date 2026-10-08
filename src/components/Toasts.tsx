import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useToasts } from "../lib/toast";
import { useT } from "../i18n";

const ICONS = { info: Info, success: CircleCheck, error: CircleAlert };

export function Toasts() {
  const t = useT();
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((item) => {
        const Icon = ICONS[item.tone];
        return (
          <div key={item.id} className={`toast toast-${item.tone}`}>
            <Icon size={15} />
            <span className="toast-text">{item.text}</span>
            <button className="icon-btn" onClick={() => dismiss(item.id)} aria-label={t("comp.dismiss")}>
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
