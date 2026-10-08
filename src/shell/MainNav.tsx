import { Fragment, memo } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useUi } from "../state/ui";
import { useStore, type ViewName } from "../store";
import { NAV_SECTIONS, SETTINGS_ITEM, type NavItem } from "./navItems";
import { useT } from "../i18n";

function isActive(item: ViewName, current: ViewName): boolean {
  return item === current || (item === "agents" && current === "agent");
}

const NavButton = memo(function NavButton({ item, active, collapsed, badge }: { item: NavItem; active: boolean; collapsed: boolean; badge?: number }) {
  const navigate = useStore((s) => s.navigate);
  useT(); // labels are getters in the current language: re-render on a language change
  const Icon = item.icon;
  return (
    <button
      className={`nav-item${active ? " active" : ""}`}
      onClick={() => navigate({ name: item.name })}
      aria-current={active ? "page" : undefined}
      title={badge ? `${item.label} (${badge})` : item.label}
    >
      <Icon size={14} />
      {!collapsed && <span className="nav-label">{item.label}</span>}
      {badge ? <span className="nav-badge">{badge}</span> : null}
    </button>
  );
});

/** Vertical main navigation in labelled groups; collapsible to icons. */
export function MainNav() {
  const current = useStore((s) => s.view.name);
  const review = useStore((s) => s.project?.tasks.filter((t) => t.status === "review").length ?? 0);
  const collapsed = useUi((s) => s.navCollapsed);
  const toggleNav = useUi((s) => s.toggleNav);
  const t = useT();
  return (
    <nav className={`mainnav${collapsed ? " collapsed" : ""}`} aria-label={t("shell.nav.views")}>
      {NAV_SECTIONS.map((section, i) => (
        <Fragment key={i}>
          {collapsed ? i > 0 && <span className="nav-sep" /> : <span className="nav-section">{section.label}</span>}
          {section.items.map((item) => (
            <NavButton key={item.name} item={item} active={isActive(item.name, current)} collapsed={collapsed} badge={item.name === "tasks" ? review : undefined} />
          ))}
        </Fragment>
      ))}
      <span className="spacer" />
      <NavButton item={SETTINGS_ITEM} active={current === "settings"} collapsed={collapsed} />
      <button className="nav-item nav-toggle" onClick={toggleNav} title={collapsed ? t("shell.nav.expand") : t("shell.nav.collapse")} aria-label={collapsed ? t("shell.nav.expand") : t("shell.nav.collapse")}>
        {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
      </button>
    </nav>
  );
}
