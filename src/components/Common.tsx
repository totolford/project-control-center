import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { useT } from "../i18n";

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  const t = useT();
  return <LoaderCircle size={size} className="spin" aria-label={t("comp.loading")} />;
}

export function Loading({ text }: { text?: string }) {
  const t = useT();
  return (
    <div className="loading">
      <Spinner /> {text ?? t("common.loading")}
    </div>
  );
}

/** Pretty-printed JSON, optionally collapsible. */
export function JsonView({ value, collapsible, label }: { value: unknown; collapsible?: boolean; label?: string }) {
  const t = useT();
  const [open, setOpen] = useState(!collapsible);
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? "null";
  } catch {
    text = String(value);
  }
  if (!collapsible) return <pre className="json">{text}</pre>;
  return (
    <div className="json-wrap">
      <button type="button" className="link-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {label ?? t("comp.json.input")}
      </button>
      {open && <pre className="json">{text}</pre>}
    </div>
  );
}

/** Labelled form field. `group` renders a div, for controls made of several buttons. */
export function Field({ label, hint, children, group }: { label: string; hint?: ReactNode; children: ReactNode; group?: boolean }) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </Tag>
  );
}

export function Section({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-header">
        <h3>{title}</h3>
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="page-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
